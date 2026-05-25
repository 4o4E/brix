// Spawn `tsx scripts/serve.ts` as a child process with isolated env (token,
// ports, profile/data dirs all unique per spawn) and wait for the
// "brix http on http://HOST:PORT" line on stdout before returning.
//
// On stop():
//   - SIGKILL the brix server child (it owns the http listener)
//   - Best-effort kill the Chrome process tree it spawned. Chrome is launched
//     `detached: true, stdio: 'ignore'` from src/browser/launcher.ts so it is
//     NOT a child of `tsx`. We can't reach it by pid via the parent. The cheap
//     reliable cleanup is: use a distinct CDP port + a distinct user-data-dir
//     per spawn — even if the Chrome instance lingers a few seconds, it
//     cannot collide with the next spawn.

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
    BRIX_LOG_LEVEL: 'debug',
    // make IDLE_TIMEOUT_MIN big so the disconnect timer never fires mid-test
    BRIX_IDLE_TIMEOUT_MIN: '60',
    ...opts.extraEnv,
  };
  // ensure BRIX_CHROME_PATH from outer env makes it through; on Linux CI the
  // launcher only auto-detects Windows paths so it MUST be set.
  if (process.env.BRIX_CHROME_PATH) env.BRIX_CHROME_PATH = process.env.BRIX_CHROME_PATH;

  const isWin = process.platform === 'win32';
  const child: ChildProcess = spawn(
    isWin ? 'npx.cmd' : 'npx',
    ['tsx', 'scripts/serve.ts'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
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
    await new Promise<void>((resolveP) => {
      if (child.exitCode !== null) { resolveP(); return; }
      const t = setTimeout(() => resolveP(), 2000);
      child.once('exit', () => { clearTimeout(t); resolveP(); });
    });
    // Chrome was spawned `detached: true` by src/browser/launcher.ts and is
    // NOT a child of the brix server, so killing the server doesn't reach
    // it. On Linux CI we leave a zombie Chrome holding its CDP port + xvfb
    // resources between tests, which seems to wedge the next test's first
    // session creation. Cheap targeted cleanup: pgrep -f for any process
    // whose cmdline contains our unique user-data-dir, SIGKILL them.
    killChromeByUserDataDir(userDataDir);
    await new Promise<void>((resolveP) => logStream.end(resolveP));
    await rm(scratch, { recursive: true, force: true }).catch(() => { /* ignore */ });
  };

  return { baseUrl, token, httpPort, cdpPort, dataDir, userDataDir, logPath, stop };
}

/**
 * pgrep -f to find any process whose cmdline contains userDataDir, then
 * SIGKILL them. Linux/macOS only — on Windows we don't run CI. Best-effort:
 * pgrep not installed → just return.
 */
function killChromeByUserDataDir(userDataDir: string): void {
  if (process.platform === 'win32') return;
  try {
    const r = spawnSync('pgrep', ['-f', userDataDir], { encoding: 'utf-8' });
    if (r.status !== 0 || !r.stdout) return;
    const pids = r.stdout.split(/\s+/).filter(Boolean).map((s) => Number(s)).filter((n) => Number.isFinite(n));
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* pgrep not present */ }
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
