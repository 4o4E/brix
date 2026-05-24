// 用 child_process.spawn 拉起本地 Chrome（不经过 Playwright launch），
// 探测 CDP 端口，返回 webSocketDebuggerUrl 供 connectOverCDP 直连。
//
// 为什么不让 Playwright 启 Chrome：
//   playwright 的 launch / launchPersistentContext 会在用户给的 args 上追加
//   --remote-debugging-pipe / 一批 --disable-features=... 等，这些 args 本身被
//   Google 等反爬列表当指纹用，登录 / Lens 上传会被拦。
//   child_process.spawn 启的 Chrome 进程参数完全可控，等同"用户手动启动"。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getEnv, type EnvConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('browser');

async function probeCdp(timeoutMs = 1500): Promise<boolean> {
  const { CDP_ENDPOINT } = getEnv();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(timeoutMs = 20_000): Promise<void> {
  const { CDP_ENDPOINT } = getEnv();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdp(800)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome CDP not reachable on ${CDP_ENDPOINT} within ${timeoutMs}ms`);
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

async function launchChromeProcess(): Promise<void> {
  const env = getEnv();
  if (!env.CHROME_PATH) {
    throw new Error('Chrome not found. Set BRIX_CHROME_PATH or install Chrome to a standard location.');
  }
  await mkdir(env.USER_DATA_DIR, { recursive: true });
  await mkdir(env.DOWNLOAD_DIR, { recursive: true });
  await mkdir(env.CACHE_DIR, { recursive: true });
  await mkdir(env.CRASH_DIR, { recursive: true });
  await ensureDownloadPreferences(env);

  const args = [
    `--user-data-dir=${env.USER_DATA_DIR}`,
    `--disk-cache-dir=${env.CACHE_DIR}`,
    `--crash-dumps-dir=${env.CRASH_DIR}`,
    `--remote-debugging-port=${env.CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
  ];
  log.info(`spawn chrome ${env.CHROME_PATH}`);
  log.debug(`chrome args: ${args.join(' ')}`);

  const child = spawn(env.CHROME_PATH, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  child.on('error', (e) => log.error('chrome spawn error:', e));
}

/** 读取 /json/version 拿 webSocketDebuggerUrl，避免 Playwright 自己拼带末尾斜杠的 URL 被 Chrome 拒 400 */
async function fetchWsUrl(): Promise<string> {
  const { CDP_ENDPOINT } = getEnv();
  const r = await fetch(`${CDP_ENDPOINT}/json/version`);
  if (!r.ok) throw new Error(`/json/version returned ${r.status}`);
  const j = (await r.json()) as { webSocketDebuggerUrl?: string };
  if (!j.webSocketDebuggerUrl) throw new Error('webSocketDebuggerUrl missing');
  return j.webSocketDebuggerUrl;
}

/**
 * 确保 Chrome 在 CDP 端口上活着，返回 webSocketDebuggerUrl
 * - 已经活着 → 直接拿 ws url
 * - 没活 → spawn 一个 + 等就绪 + 拿 ws url
 */
export async function ensureChromeRunning(): Promise<string> {
  const { CDP_ENDPOINT } = getEnv();
  if (!(await probeCdp())) {
    log.info(`no chrome on ${CDP_ENDPOINT}, launching one`);
    await launchChromeProcess();
    await waitForCdp(20_000);
  } else {
    log.info(`reusing chrome already on ${CDP_ENDPOINT}`);
  }
  return await fetchWsUrl();
}
