// Spawn `tsx scripts/serve.ts` as a child process with isolated env (token,
// ports, profile/data dirs all unique per spawn) and wait for the
// "brix http on http://HOST:PORT" line on stdout before returning.
//
// On stop():
//   - SIGKILL the brix server child (it owns the http listener)
//   - Kill the Chrome process tree it spawned. Chrome is launched
//     `detached: true, stdio: 'ignore'` from src/browser/launcher.ts so it is
//     NOT a child of `tsx` — killing the server doesn't reach it. We match it
//     by its unique `--user-data-dir=<scratch>` cmdline and kill it directly
//     (see killChromeByUserDataDir): taskkill on Windows, pkill on Linux/CI.
//     Distinct CDP port + user-data-dir per spawn is the backstop so a slow
//     kill can't collide with the next spawn.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createWriteStream, writeFileSync } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HELPERS_DIR, '..', '..', '..');

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolveP, rejectP) => {
    const s = createServer();
    s.unref();
    s.on('error', rejectP);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolveP(port));
      } else {
        s.close(() => rejectP(new Error('no port')));
      }
    });
  });
}

export interface BrixServer {
  baseUrl: string;
  token: string;
  httpPort: number;
  cdpPort: number;
  dataDir: string;
  userDataDir: string;
  logPath: string;
  stop(): Promise<void>;
}

export interface SpawnOpts {
  /** Override the token (default: random) */
  token?: string;
  /** Extra env vars to merge */
  extraEnv?: NodeJS.ProcessEnv;
  /** ms to wait for the listening line on stdout (default 30s) */
  startTimeoutMs?: number;
}

function randomToken(): string {
  return 'tk-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Start a brix server in a child process. Resolves once the server prints its
 * listening line. The returned `stop()` kills the child and removes scratch dirs.
 */
export async function startBrixServer(opts: SpawnOpts = {}): Promise<BrixServer> {
  const token = opts.token ?? randomToken();
  const httpPort = await pickFreePort();
  const cdpPort = await pickFreePort();
  const scratch = await mkdtemp(join(tmpdir(), 'brix-e2e-'));
  const dataDir = join(scratch, 'data');
  const userDataDir = join(scratch, 'user-data');
  await mkdir(dataDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  const logPath = join(scratch, 'brix-stdio.log');
  // Touch the file synchronously up front. createWriteStream(flags:'a') is
  // lazy — it only opens the fd on first write, so a child process that
  // hangs before printing anything leaves nothing on disk and the CI
  // upload-artifact step finds nothing. A 1-line marker guarantees the
  // file exists, and lets us identify *which* spawn it was when several
  // tests' logs end up in the same artifact archive.
  const startMarker = `=== brix-e2e spawn at ${new Date().toISOString()} httpPort=${httpPort} cdpPort=${cdpPort} ===\n`;
  writeFileSync(logPath, startMarker);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRIX_TOKEN: token,
    BRIX_HTTP_HOST: '127.0.0.1',
    BRIX_HTTP_PORT: String(httpPort),
    BRIX_CDP_PORT: String(cdpPort),
    BRIX_DATA_DIR: dataDir,
    BRIX_USER_DATA_DIR: userDataDir,
    // Pin builtins dir to the repo so cwd drift between tests (e.g. `cd` in
    // some test setup) doesn't leave bootstrap unable to find templates.
    BRIX_BUILTIN_SCRIPTS_DIR: join(REPO_ROOT, 'built-in-scripts'),
    BRIX_LOG_LEVEL: 'debug',
    // make IDLE_TIMEOUT_MIN big so the disconnect timer never fires mid-test
    BRIX_IDLE_TIMEOUT_MIN: '60',
    // Under xvfb on CI minimize is meaningless and the post-launch CDP round
    // trip just adds startup latency. Local windows-host runs of `npm run e2e`
    // also don't want a window flicker. Tests assert on protocol/output, not
    // visual state, so opt out unconditionally for e2e.
    BRIX_CHROME_START_MINIMIZED: 'false',
    ...opts.extraEnv,
  };
  // ensure BRIX_CHROME_PATH from outer env makes it through; on Linux CI the
  // launcher only auto-detects Windows paths so it MUST be set.
  if (process.env.BRIX_CHROME_PATH) env.BRIX_CHROME_PATH = process.env.BRIX_CHROME_PATH;

  const isWin = process.platform === 'win32';
  // On Windows npx.cmd is a .cmd batch file → child_process.spawn with
  // shell:false rejects it as EINVAL; need shell:true so cmd.exe runs it.
  // On Linux/CI npx is a JS script with a shebang — shell:false is fine
  // and slightly safer (no shell quoting surprises).
  const child: ChildProcess = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['tsx', 'scripts/serve.ts'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
      windowsHide: true,
    },
  );
  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;

  // Write log incrementally on every chunk. Earlier we batched chunks in a
  // Buffer[] and only flushed in stop() — that worked locally but on CI a
  // job-level timeout cancels the test before stop() runs, so the artifact
  // upload found an empty file and we had zero visibility into why the server
  // hung. createWriteStream + per-chunk write means even a hard cancel leaves
  // the captured-so-far output on disk.
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const onData = (b: Buffer): void => {
    logStream.write(b);
  };
  stdout.on('data', onData);
  stderr.on('data', onData);

  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const ready = waitForLine(stdout, stderr, /brix http on /, opts.startTimeoutMs ?? 30_000);
  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code, sig) => {
      reject(new Error(`brix server exited before ready (code=${code}, sig=${sig})`));
    });
  });

  try {
    await Promise.race([ready, exited]);
  } catch (e) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    logStream.end();
    throw e;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    // wait briefly for exit so logs flush
    await raceTimeout(new Promise<void>((resolveP) => {
      if (child.exitCode !== null) { resolveP(); return; }
      const t = setTimeout(() => resolveP(), 2000);
      child.once('exit', () => { clearTimeout(t); resolveP(); });
    }), 3000);
    // Chrome was spawned `detached: true` by src/browser/launcher.ts and is
    // NOT a child of the brix server, so killing the server doesn't reach
    // it. On Linux CI we'd leave a zombie Chrome holding its CDP port +
    // xvfb resources between tests, wedging the next test's first session
    // creation. On Windows it holds files open in user-data-dir and makes
    // the subsequent fs.rm hang waiting for handles to close. Either way:
    // pkill -KILL -f <userDataDir> to clear it.
    killChromeByUserDataDir(userDataDir);
    await raceTimeout(new Promise<void>((resolveP) => logStream.end(resolveP)), 2000);
    // fs.rm with recursive+force can still hang on Windows when Chrome (now
    // killed but its handles may not be released instantly) is holding
    // user-data-dir/Default/Cookies etc. Race against a timeout so stop()
    // is guaranteed to return — leaving a stray /tmp/brix-e2e-XXX dir is
    // far better than wedging the whole test run. The mkdtemp prefix means
    // it's trivially clean-up-able by the user.
    await raceTimeout(rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => { /* ignore */ }), 5000);
  };

  return { baseUrl, token, httpPort, cdpPort, dataDir, userDataDir, logPath, stop };
}

/** Resolve `p` if it finishes within `ms`, otherwise resolve void anyway. Never rejects. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race<T | void>([
    p.catch(() => undefined),
    new Promise<void>((res) => setTimeout(res, ms).unref()),
  ]);
}

/**
 * Best-effort kill of the orphan Chrome that launcher.ts started with
 * detached:true (so it survived `child.kill` on the brix server child). It
 * carries `--user-data-dir=<userDataDir>`, which is unique per spawn, so we
 * match on that. SIGKILL/`/F` — we don't care about graceful shutdown, only
 * that no window lingers and nothing fights over the port / fds / files.
 *
 * Windows: `npm run e2e` runs on the dev's desktop, so a lingering Chrome
 * leaves a visible window AND holds user-data-dir handles open (wedging the
 * later fs.rm). Mirror launcher.ts: PowerShell finds chrome.exe by cmdline,
 * `taskkill /T` kills it plus its renderer/GPU children.
 *
 * Linux/macOS (CI): `pkill -KILL -f` matches the full cmdline and signals
 * every matching process (Chrome's zygote/renderer/GPU helpers all carry
 * `--user-data-dir=<path>`).
 */
function killChromeByUserDataDir(userDataDir: string): void {
  if (process.platform === 'win32') {
    try {
      const escaped = userDataDir.replace(/'/g, "''");
      const ps = `$d='${escaped}'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
        `Where-Object { $_.CommandLine -like "*$d*" } | ForEach-Object { $_.ProcessId }`;
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf-8', timeout: 5000 });
      const pids = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const pid of pids) spawnSync('taskkill', ['/F', '/T', '/PID', pid], { timeout: 5000 });
    } catch { /* best-effort */ }
    return;
  }
  try {
    spawnSync('pkill', ['-KILL', '-f', userDataDir], { encoding: 'utf-8', timeout: 5000 });
  } catch { /* pkill not present */ }
}

function waitForLine(stdout: Readable, stderr: Readable, re: RegExp, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveP, rejectP) => {
    let buffer = '';
    let done = false;
    const cleanup = (): void => {
      done = true;
      clearTimeout(timer);
      stdout.off('data', onData);
      stderr.off('data', onData);
    };
    const onData = (b: Buffer): void => {
      if (done) return;
      buffer += b.toString('utf-8');
      if (re.test(buffer)) {
        cleanup();
        resolveP();
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      rejectP(new Error(`timed out waiting for ${re} in stdout after ${timeoutMs}ms; captured:\n${buffer}`));
    }, timeoutMs);
    stdout.on('data', onData);
    stderr.on('data', onData);
  });
}
