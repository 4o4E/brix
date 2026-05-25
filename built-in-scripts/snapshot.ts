// brix 内置脚本：打印任意 URL 的交互式 snapshot
//
// 执行入口：POST /sessions/:sid/scripts/snapshot
//   body: { args: { url?, scope?, interactiveOnly?, maxDepth? } }
//   url 可省略 → 直接对当前 page 取 snapshot
//
// server-side DOM 脚本：snapshot 文本生成 + refMap 都走 run.takeSnapshot()。
//
// 产物：
//   <run.dir>/page.png        截图
//   <run.dir>/page.html       原始 HTML
//   <run.dir>/snapshot.txt    snapshot 文本
//   <run.dir>/refs.json       refMap 序列化

import type { Page } from 'rebrowser-playwright';
import type { Run } from '../src/runs/run.js';

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
  run.log.info(`url=${a.url ?? '(current)'} scope=${a.scope ?? '-'}`);

  if (a.url) {
    await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => { /* ignore */ });

  const { snapshot, refCount, refs } = await run.takeSnapshot(page, {
    scope: a.scope,
    interactiveOnly: !!a.interactiveOnly,
    maxDepth: a.maxDepth ?? 0,
  });

  const screenshot = await page.screenshot({ fullPage: true }).catch((e) => {
    run.log.warn(`screenshot failed: ${e instanceof Error ? e.message : e}`);
    return null;
  });
  if (screenshot) await run.writeArtifact('page.png', screenshot);
  await run.writeArtifact('page.html', await page.content().catch(() => '<error>'));
  await run.writeArtifact('snapshot.txt', snapshot);
  await run.writeArtifact('refs.json', JSON.stringify(refs, null, 2));

  const output: SnapshotOutput = {
    snapshot,
    refCount,
    finalUrl: page.url(),
    durationMs: Date.now() - t0,
  };
  run.log.info(`done in ${output.durationMs}ms, ${output.refCount} ref(s)`);
  return output;
}
