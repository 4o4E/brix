// 用 child_process.spawn 拉起本地 Chrome（不经过 Playwright launch），
// 探测 CDP 端口，返回 webSocketDebuggerUrl 供 connectOverCDP 直连。
//
// 为什么不让 Playwright 启 Chrome：
//   playwright 的 launch / launchPersistentContext 会在用户给的 args 上追加
//   --remote-debugging-pipe / 一批 --disable-features=... 等，这些 args 本身被
//   Google 等反爬列表当指纹用，登录 / Lens 上传会被拦。
//   child_process.spawn 启的 Chrome 进程参数完全可控，等同"用户手动启动"。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { getEnv, type EnvConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser');

/**
 * Chrome 实际占用的 CDP 端口。BRIX_CDP_PORT=0（默认）让 chrome 自己挑空闲端口，
 * 启动后从 user-data-dir/DevToolsActivePort 读出真实端口，写到这里供后续
 * probe/fetch/minimize 复用。固定端口模式直接写用户给的值。
 *
 * 为啥不直接用 env.CDP_PORT：固定端口在 Windows 上经常撞 Hyper-V/WSL2 的
 * excluded port range（netsh interface ipv4 show excludedportrange），导致 chrome
 * bind 失败但探测看不出来，干等 20s 才挂。0 + DevToolsActivePort 是最稳的。
 */
let actualCdpPort: number | null = null;

function cdpEndpoint(): string {
  // BRIX_CDP_URL 是显式 attach-mode 覆盖（用户已经自己启了一个 chrome 在这个端点）
  const override = process.env.BRIX_CDP_URL?.trim();
  if (override) return override;
  if (actualCdpPort !== null) return `http://127.0.0.1:${actualCdpPort}`;
  return `http://127.0.0.1:${getEnv().CDP_PORT}`;
}

interface ChromeProcInfo { pid: number; cmd: string; }

/**
 * 找出所有命令行里含 needle（通常是 user-data-dir 路径）的 chrome 进程。
 * 只用于诊断 / 兜底清理，best-effort。
 *
 * 安全性：needle 由调用方传入的就是 BRIX_USER_DATA_DIR 这种 brix 私有路径，
 * 普通用户日常使用的 Chrome 永远不会有这个串在命令行里（默认在
 * %LOCALAPPDATA%\Google\Chrome\User Data），所以匹配到的一定是 brix 自己拉起的。
 *
 * - Windows: PowerShell 查 Win32_Process（启动 ~300ms，可接受）。-like 默认大小写
 *   不敏感。stderr 失败信息会写日志便于排查。
 * - POSIX:   pgrep -af 一次拿到 pid + 完整命令行
 */
function findChromeByCmdline(needle: string): ChromeProcInfo[] {
  if (process.platform === 'win32') {
    const escaped = needle.replace(/'/g, "''");
    const ps = `$d='${escaped}'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like "*$d*" } | ` +
      `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    });
    if (r.error) {
      log.warn(`findChromeByCmdline powershell spawn error: ${r.error.message}`);
      return [];
    }
    if (r.status !== 0) {
      log.warn(`findChromeByCmdline powershell exit=${r.status} stderr=${(r.stderr ?? '').slice(0, 400)}`);
      return [];
    }
    if (!r.stdout) return [];
    const out = r.stdout.split(/\r?\n/).flatMap((line) => {
      const sep = line.indexOf('|');
      if (sep < 0) return [];
      const pid = Number(line.slice(0, sep));
      const cmd = line.slice(sep + 1);
      return Number.isFinite(pid) ? [{ pid, cmd }] : [];
    });
    log.debug(`findChromeByCmdline(${needle}) → ${out.length} match(es)`);
    return out;
  }
  const r = spawnSync('pgrep', ['-af', needle], { encoding: 'utf-8', timeout: 8000 });
  // pgrep exit=1 = "no match"（不是错误，不要 warn）；其他非 0 才报
  if (r.status !== 0 && r.status !== 1) {
    log.warn(`findChromeByCmdline pgrep exit=${r.status} stderr=${(r.stderr ?? '').slice(0, 400)}`);
  }
  if (!r.stdout) return [];
  const out = r.stdout.split('\n').flatMap((line) => {
    const m = line.match(/^(\d+)\s+(.+)$/);
    return m ? [{ pid: Number(m[1]), cmd: m[2] }] : [];
  });
  log.debug(`findChromeByCmdline(${needle}) → ${out.length} match(es)`);
  return out;
}

/**
 * 清理 user-data-dir 下的 Singleton* 锁文件 + 崩溃残留。
 * chrome 崩了或被 SIGKILL 后这几个文件经常残留，下一次 chrome 启动会以为有别人
 * 在用 profile 而直接转发命令然后退出，导致 brix 探不到 CDP。手动删掉就好。
 * 文件可能根本不存在 / 是 symlink / 平台无关 —— 全 best-effort。
 */
async function cleanSingletonLocks(userDataDir: string): Promise<void> {
  const names = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const n of names) {
    try {
      await unlink(join(userDataDir, n));
      log.debug(`removed stale lock: ${n}`);
    } catch { /* 不存在最常见，不打日志 */ }
  }
}

/** SIGKILL 所有命令行匹配 needle 的 chrome 进程。返回杀掉的数量。 */
function killChromeByCmdline(needle: string): number {
  const procs = findChromeByCmdline(needle);
  let killed = 0;
  for (const p of procs) {
    try {
      if (process.platform === 'win32') {
        // /T 杀进程树 /F 强杀；Chrome 会 fork renderer/GPU/utility helpers，
        // 但这些 helper 多数也带 --user-data-dir=，findChromeByCmdline 会一并
        // 收到，/T 只是冗余保险。
        const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], {
          encoding: 'utf-8', timeout: 5000, windowsHide: true,
        });
        if (r.status === 0) killed += 1;
      } else {
        try { process.kill(p.pid, 'SIGKILL'); killed += 1; } catch { /* already gone */ }
      }
    } catch { /* ignore */ }
  }
  return killed;
}

async function probeCdp(timeoutMs = 1500): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${cdpEndpoint()}/json/version`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(timeoutMs = 20_000, abort?: Promise<never>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const loop = (async (): Promise<void> => {
    while (Date.now() < deadline) {
      if (await probeCdp(800)) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Chrome CDP not reachable on ${cdpEndpoint()} within ${timeoutMs}ms`);
  })();
  await (abort ? Promise.race<void>([loop, abort]) : loop);
}

/**
 * 试着在 127.0.0.1:port 上启个 TCP listener，能起来就关掉返回 ok。
 * 用来在 spawn chrome 之前 fail-fast 检查端口可用性。
 *
 * Windows 上常见的 EACCES（0x271D）= 端口在 excluded port range 里，
 * 通常是 Hyper-V/WSL2 占的；EADDRINUSE = 真的有人在用。两种都需要换端口。
 */
async function probeBindable(port: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: `${e.code ?? 'ERR'} ${e.message}` });
    });
    s.listen(port, '127.0.0.1', () => {
      s.close(() => resolve({ ok: true }));
    });
  });
}

/**
 * 启动后 chrome 会写 <user-data-dir>/DevToolsActivePort，两行：
 *   <port>\n
 *   /devtools/browser/<uuid>\n
 * 用来告诉外部 --remote-debugging-port=0 时它最终挑了哪个端口。
 * 我们靠它支持自动选端口（避开 Windows excluded range）。
 */
async function readDevToolsActivePort(userDataDir: string, timeoutMs = 20_000): Promise<number> {
  const path = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, 'utf-8');
      const first = content.split(/\r?\n/)[0]?.trim();
      const p = Number(first);
      if (Number.isFinite(p) && p > 0) return p;
    } catch { /* 文件还没写出来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`DevToolsActivePort not appeared in ${userDataDir} within ${timeoutMs}ms`);
}

/**
 * 把 Chrome profile 的下载目录指到 DOWNLOAD_DIR，关掉"询问保存位置"。
 * Chrome 不接受 --download-directory 命令行参数（设计如此），唯一办法是改
 * <USER_DATA_DIR>/Default/Preferences 里的 download.* 字段。
 *
 * 读 + merge + 写：只覆盖 download 三项，保留用户其他偏好；解析失败就放弃改、
 * 不覆写，避免误伤 Chrome profile。
 */
async function ensureDownloadPreferences(env: EnvConfig): Promise<void> {
  const prefsDir = join(env.USER_DATA_DIR, 'Default');
  await mkdir(prefsDir, { recursive: true });
  const prefsPath = join(prefsDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(await readFile(prefsPath, 'utf-8'));
    } catch (e) {
      log.warn(`Preferences parse failed, skip patching: ${e instanceof Error ? e.message : e}`);
      return;
    }
  }
  const existing = (prefs.download as Record<string, unknown>) ?? {};
  prefs.download = {
    ...existing,
    default_directory: env.DOWNLOAD_DIR,
    prompt_for_download: false,
    directory_upgrade: true,
  };
  await writeFile(prefsPath, JSON.stringify(prefs));
  log.debug(`patched Preferences download.default_directory=${env.DOWNLOAD_DIR}`);
}

/**
 * Spawn 出来的 Chrome 句柄。
 * - `earlyExit` 是个永不 resolve / 只在 Chrome 提前退出时 reject 的 Promise，用来
 *   跟 waitForCdp 一起 race —— 一旦 Chrome 没起来就走（不用干等满 20s）。
 *   stdio=ignore 让我们看不到 Chrome 的 stderr，所以这是 best-effort 提示。
 */
interface ChromeHandle {
  earlyExit: Promise<never>;
}

async function launchChromeProcess(port: number): Promise<ChromeHandle> {
  const env = getEnv();
  if (!env.CHROME_PATH) {
    throw new Error('Chrome not found. Set BRIX_CHROME_PATH or install Chrome to a standard location.');
  }
  await mkdir(env.USER_DATA_DIR, { recursive: true });
  await mkdir(env.DOWNLOAD_DIR, { recursive: true });
  await mkdir(env.CACHE_DIR, { recursive: true });
  await mkdir(env.CRASH_DIR, { recursive: true });
  await ensureDownloadPreferences(env);
  // 清掉上次的 DevToolsActivePort，避免读到陈旧端口
  try { await unlink(join(env.USER_DATA_DIR, 'DevToolsActivePort')); } catch { /* 不存在最常见 */ }

  const args = [
    `--user-data-dir=${env.USER_DATA_DIR}`,
    `--disk-cache-dir=${env.CACHE_DIR}`,
    `--crash-dumps-dir=${env.CRASH_DIR}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // START_MINIMIZED=true 时跳过 --start-maximized，等 CDP 起来后用
  // Browser.setWindowBounds 设 minimized；否则窗口会先最大化闪一下再缩。
  if (!env.START_MINIMIZED) args.push('--start-maximized');
  // BRIX_CHROME_EXTRA_ARGS: 空白分隔，追加到 chrome args 后。CI 上需要
  // --no-sandbox --disable-dev-shm-usage 才能起得来；本机 Windows 一般不用动。
  // 跟 anti-detection 的取舍：本机不传 = 行为不变；CI 显式传 = 接受指纹偏差。
  const extra = process.env.BRIX_CHROME_EXTRA_ARGS?.trim();
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));
  log.info(`spawn chrome ${env.CHROME_PATH}`);
  log.debug(`chrome args: ${args.join(' ')}`);

  const child = spawn(env.CHROME_PATH, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  child.on('error', (e) => log.error('chrome spawn error:', e));

  // 注：spawn 出来的 chrome.exe 在 Windows 上经常只是一个 launcher 进程 ——
  // 真正的浏览器拉起后这个 wrapper 立刻 exit(0)。所以 code=0 的早 exit
  // *不一定* 是失败；但 code !== 0 几乎肯定是失败（最常见: user-data-dir
  // 被另一个 chrome 锁住，singleton 把参数转发后退出）。code=null/signal 也
  // 当失败处理。等满 200ms 给 spawn 一点起步时间再开始监听。
  const earlyExit = new Promise<never>((_resolve, reject) => {
    let armed = false;
    const arm = setTimeout(() => { armed = true; }, 200).unref();
    child.once('exit', (code, signal) => {
      clearTimeout(arm);
      if (!armed) return; // 起步窗口里的退出忽略
      if (code === 0 && !signal) return; // 大概率是 launcher wrapper 正常退出
      reject(new Error(
        `Chrome 提前退出 (code=${code}, signal=${signal}) — 通常是已有 Chrome ` +
        `占用 ${env.USER_DATA_DIR}，singleton 把命令转发后这边就退了。` +
        `结束所有 chrome.exe 再试。`,
      ));
    });
  });
  return { earlyExit };
}

/**
 * 用 CDP 把 Chrome 窗口设为最小化（best-effort）。
 *
 * 流程：browser-level WS → Target.getTargets 找 page → Browser.getWindowForTarget
 * 拿 windowId → Browser.setWindowBounds {windowState:'minimized'}。失败只 warn，
 * 不影响后续 Playwright 连接。
 *
 * Chrome 没有跨平台的 `--start-minimized` 命令行参数；CDP 是唯一可靠途径。
 */
async function minimizeChromeWindow(): Promise<void> {
  try {
    const verR = await fetch(`${cdpEndpoint()}/json/version`);
    if (!verR.ok) return;
    const ver = (await verR.json()) as { webSocketDebuggerUrl?: string };
    if (!ver.webSocketDebuggerUrl) return;
    await callCdpOnce(ver.webSocketDebuggerUrl, async (send) => {
      const targets = (await send('Target.getTargets')) as {
        targetInfos?: Array<{ targetId: string; type: string }>;
      };
      const page = targets.targetInfos?.find((t) => t.type === 'page');
      if (!page) {
        log.debug('minimize: no page target found, skip');
        return;
      }
      const win = (await send('Browser.getWindowForTarget', { targetId: page.targetId })) as {
        windowId?: number;
      };
      if (typeof win.windowId !== 'number') {
        log.debug('minimize: no windowId from Browser.getWindowForTarget, skip');
        return;
      }
      await send('Browser.setWindowBounds', {
        windowId: win.windowId,
        bounds: { windowState: 'minimized' },
      });
    });
    log.debug('chrome window minimized via CDP');
  } catch (e) {
    log.warn(`minimize chrome failed: ${e instanceof Error ? e.message : e}`);
  }
}

type CdpSend = (method: string, params?: object) => Promise<unknown>;

/**
 * 在 wsUrl 上跑一次性 CDP 调用序列，结束（或超时）后关 WS。
 * - send() 把任意响应（result 或 error）都 resolve 成 unknown，调用方自行判断字段。
 * - 整个 fn 受 timeoutMs 上限保护，避免挂死整个启动流程。
 */
async function callCdpOnce(
  wsUrl: string,
  fn: (send: CdpSend) => Promise<void>,
  timeoutMs = 3000,
): Promise<void> {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map<number, (r: unknown) => void>();
  ws.addEventListener('message', (ev) => {
    try {
      const j = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (typeof j.id === 'number') {
        const cb = pending.get(j.id);
        if (cb) { pending.delete(j.id); cb(j.result ?? j.error); }
      }
    } catch { /* ignore */ }
  });
  const send: CdpSend = (method, params = {}) =>
    new Promise((res) => {
      const id = ++nextId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('ws error')); }, { once: true });
    });
    await Promise.race([
      fn(send),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('cdp call timeout')), timeoutMs)),
    ]);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

/** 读取 /json/version 拿 webSocketDebuggerUrl，避免 Playwright 自己拼带末尾斜杠的 URL 被 Chrome 拒 400 */
async function fetchWsUrl(): Promise<string> {
  const r = await fetch(`${cdpEndpoint()}/json/version`);
  if (!r.ok) throw new Error(`/json/version returned ${r.status}`);
  const j = (await r.json()) as { webSocketDebuggerUrl?: string };
  if (!j.webSocketDebuggerUrl) throw new Error('webSocketDebuggerUrl missing');
  return j.webSocketDebuggerUrl;
}

/**
 * 确保 Chrome 在 CDP 端口上活着，返回 webSocketDebuggerUrl
 *
 * 端口策略：
 *   - BRIX_CDP_URL 显式 attach（不 spawn）：原样使用
 *   - BRIX_CDP_PORT=0（默认）：让 chrome 挑空闲端口，DevToolsActivePort 读真实值
 *   - BRIX_CDP_PORT=N（>0）：先 bind 试一下，撞 Windows excluded range 直接报错
 *
 * 清理：spawn 前杀掉所有命令行里含 USER_DATA_DIR 的 chrome（一定是 brix 自己
 * 的残留，普通 Chrome 不会撞），删 Singleton* 锁。
 */
export async function ensureChromeRunning(): Promise<string> {
  const env = getEnv();
  if (await probeCdp()) {
    log.info(`reusing chrome already on ${cdpEndpoint()}`);
    return await fetchWsUrl();
  }

  // 清理 brix 自己的残留进程 + 锁文件
  const stale = killChromeByCmdline(env.USER_DATA_DIR);
  if (stale > 0) {
    log.warn(`killed ${stale} stale brix-chrome process(es) on ${env.USER_DATA_DIR}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await cleanSingletonLocks(env.USER_DATA_DIR);

  // 决定要让 chrome bind 的端口
  let requestedPort = env.CDP_PORT;
  if (requestedPort > 0) {
    const r = await probeBindable(requestedPort);
    if (!r.ok) {
      const hint = process.platform === 'win32'
        ? '\n  Windows 上常见原因：端口落在 excluded port range（Hyper-V/WSL2 占了一段动态端口）。\n' +
          '  查看：  netsh interface ipv4 show excludedportrange protocol=tcp\n' +
          '  最佳做法：BRIX_CDP_PORT=0 让 brix 自动挑空闲端口。'
        : '';
      throw new Error(
        `无法绑定 CDP 端口 127.0.0.1:${requestedPort}（${r.reason}）${hint}`,
      );
    }
  }

  log.info(`no chrome on ${cdpEndpoint()}, launching one (requestedPort=${requestedPort})`);
  const { earlyExit } = await launchChromeProcess(requestedPort);

  try {
    // requestedPort=0 时从 DevToolsActivePort 读 chrome 实际挑的端口
    if (requestedPort === 0) {
      const picked = await Promise.race([
        readDevToolsActivePort(env.USER_DATA_DIR, 20_000),
        earlyExit,
      ]);
      actualCdpPort = picked;
      log.info(`chrome picked CDP port ${picked}`);
    } else {
      actualCdpPort = requestedPort;
    }
    await waitForCdp(20_000, earlyExit);
  } catch (err) {
    // 自己拉起的 chrome 没起来 / CDP 没上，整棵进程树清干净避免堆积
    const n = killChromeByCmdline(env.USER_DATA_DIR);
    if (n > 0) log.warn(`launch failed, cleaned up ${n} chrome process(es)`);
    actualCdpPort = null;
    throw err;
  }
  if (env.START_MINIMIZED) await minimizeChromeWindow();
  return await fetchWsUrl();
}
