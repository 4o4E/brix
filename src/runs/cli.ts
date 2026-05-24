// 脚本 CLI 共用入口：解析 --json-args / --run-id，调 runInSession，打末行 JSON 摘要
//
// 脚本贴这段：
//   if (import.meta.url === pathToFileURL(process.argv[1]).href) {
//     await runAsCli(runInSession);
//   }

import type { Page } from 'rebrowser-playwright';
import { newTab, closeSession } from '../browser/session.js';
import { createLogger } from '../utils/logger.js';
import { createRun, type Run } from './run.js';

const log = createLogger('cli');

export type RunInSession = (page: Page, args: unknown, run: Run) => Promise<unknown>;

interface CliOpts {
  /** 若脚本想从 argv 解析自己的形参（如 npm run gemini-draw -- "<prompt>"），传这个回调；返回 unknown 即是 args */
  parseArgv?: (positional: string[]) => unknown;
  /** runInSession 完成后是否关闭 tab，默认 true */
  closeTab?: boolean;
}

function parseJsonArgsFlag(argv: string[]): unknown | undefined {
  const i = argv.indexOf('--json-args');
  if (i < 0 || i + 1 >= argv.length) {
    const eq = argv.find((a) => a.startsWith('--json-args='));
    if (!eq) return undefined;
    try { return JSON.parse(eq.slice('--json-args='.length)); } catch { return undefined; }
  }
  try { return JSON.parse(argv[i + 1]); } catch { return undefined; }
}

function filterPositional(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json-args' || a === '--run-id') { i++; continue; }
    if (a.startsWith('--json-args=') || a.startsWith('--run-id=')) continue;
    out.push(a);
  }
  return out;
}

export async function runAsCli(runInSession: RunInSession, opts: CliOpts = {}): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArgs = parseJsonArgsFlag(argv);
  const positional = filterPositional(argv);
  const args = jsonArgs ?? (opts.parseArgv ? opts.parseArgv(positional) : positional);

  const run = await createRun();
  log.info(`runId=${run.runId} argv=${JSON.stringify(positional)} jsonArgs=${jsonArgs !== undefined}`);

  const page = await newTab();

  let output: unknown = null;
  let error: { message: string; stack?: string } | null = null;
  try {
    output = await runInSession(page, args, run);
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined };
    log.error(`runInSession threw: ${error.message}`);
  }

  const downloads = await run.listDownloads().catch(() => []);
  const summary = { runId: run.runId, output, downloads, error };
  console.log(JSON.stringify(summary));

  if (opts.closeTab !== false) {
    await page.close().catch(() => { /* ignore */ });
  }
  await closeSession();

  if (error) process.exit(1);
}
