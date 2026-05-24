// brix 内置脚本：打印任意 URL 的交互式 snapshot
//
// 用法（CLI）：
//   npm run snapshot -- <url> [--scope=<css>] [--interactive-only] [--max-depth=N]
//   npm run snapshot -- --json-args '{"url":"https://example.com","interactiveOnly":true}'
//
// 用法（HTTP via session）：
//   POST /sessions/:sid/scripts/snapshot
//   body: { args: { url?, scope?, interactiveOnly?, maxDepth? } }
//   注意：via HTTP 时 url 可省略 —— 直接对当前 page 取 snapshot。
//
// 产物：
//   <run.dir>/page.png        截图
//   <run.dir>/page.html       原始 HTML
//   <run.dir>/snapshot.txt    snapshot 文本
//   <run.dir>/refs.json       refMap 序列化

import { pathToFileURL } from 'node:url';
import type { Page } from 'rebrowser-playwright';
import { createLogger } from '../src/utils/logger.js';
import { runAsCli } from '../src/runs/cli.js';
import type { Run } from '../src/runs/run.js';
import { takeSnapshot, createBrowserRefContext, type FormatOptions } from '../src/browser/snapshot.js';

const log = createLogger('snapshot');

export const meta = {
  description: '抓当前 page（或新 goto 指定 url）的交互式 snapshot 文本 + 截图 + HTML + refMap',
  argsExample: { url: 'https://example.com', interactiveOnly: true, maxDepth: 0 },
};

interface SnapshotArgs {
  url?: string;
  scope?: string;
  interactiveOnly?: boolean;
  maxDepth?: number;
}

export interface SnapshotOutput {
  snapshot: string;
  refCount: number;
  finalUrl: string;
  durationMs: number;
}

function coerceArgs(args: unknown): SnapshotArgs {
  if (typeof args === 'string') return { url: args };
  if (Array.isArray(args) && typeof args[0] === 'string') return { url: args[0] };
  if (args && typeof args === 'object') {
    const a = args as SnapshotArgs;
    return {
      url: typeof a.url === 'string' ? a.url : undefined,
      scope: typeof a.scope === 'string' ? a.scope : undefined,
      interactiveOnly: !!a.interactiveOnly,
      maxDepth: typeof a.maxDepth === 'number' ? a.maxDepth : 0,
    };
  }
  return {};
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<SnapshotOutput> {
  const a = coerceArgs(args);
  const t0 = Date.now();
  log.info(`runId=${run.runId} url=${a.url ?? '(current)'} scope=${a.scope ?? '-'}`);

  if (a.url) {
    await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { /* ignore */ });

  const ctx = createBrowserRefContext();
  const formatOpts: Partial<FormatOptions> = {
    interactiveOnly: !!a.interactiveOnly,
    maxDepth: a.maxDepth ?? 0,
  };

  const snap = await takeSnapshot(page, a.scope, ctx, formatOpts);

  const screenshot = await page.screenshot({ fullPage: true }).catch((e) => {
    log.warn(`screenshot failed: ${e instanceof Error ? e.message : e}`);
    return null;
  });
  if (screenshot) await run.writeArtifact('page.png', screenshot);
  await run.writeArtifact('page.html', await page.content().catch(() => '<error>'));
  await run.writeArtifact('snapshot.txt', snap);

  const refsObj = Object.fromEntries(
    Array.from(ctx.refMap.entries()).map(([k, v]) => [k, { role: v.role, name: v.name, selector: v.selector }]),
  );
  await run.writeArtifact('refs.json', JSON.stringify(refsObj, null, 2));

  const output: SnapshotOutput = {
    snapshot: snap,
    refCount: ctx.refCounter,
    finalUrl: page.url(),
    durationMs: Date.now() - t0,
  };
  log.info(`done in ${output.durationMs}ms, ${output.refCount} ref(s)`);
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAsCli(runInSession, {
    parseArgv: (positional) => {
      const a: SnapshotArgs = {};
      for (const tok of positional) {
        if (tok.startsWith('--scope=')) a.scope = tok.slice('--scope='.length);
        else if (tok === '--interactive-only') a.interactiveOnly = true;
        else if (tok.startsWith('--max-depth=')) a.maxDepth = Number(tok.slice('--max-depth='.length)) || 0;
        else if (!tok.startsWith('--') && !a.url) a.url = tok;
      }
      if (!a.url) {
        console.error('用法: npm run snapshot -- <url> [--scope=<css>] [--interactive-only] [--max-depth=N]');
        process.exit(1);
      }
      return a;
    },
  });
}
