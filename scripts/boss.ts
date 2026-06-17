// brix CLI 客户端：通过 HTTP 调用 server 上的 boss 抓取脚本
//
// 用法：
//   npm run boss                       # 默认 mode=explore，dump DOM
//   npm run boss -- --scrape           # 真正抓取
//   npm run boss -- --json-args '{"mode":"scrape","maxConvos":20}'
//
// 末行打印结果 JSON：{runId, output, savedFiles}。

import { runViaBrix } from '../src/cli/brix-client.js';

function parseArgv(): { args: Record<string, unknown>; out?: string } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let jsonArgs: Record<string, unknown> | undefined;
  const args: Record<string, unknown> = {};

  const num = (v: string): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json-args' && i + 1 < argv.length) { try { jsonArgs = JSON.parse(argv[++i]); } catch { /* ignore */ } continue; }
    if (a.startsWith('--json-args=')) { try { jsonArgs = JSON.parse(a.slice('--json-args='.length)); } catch { /* ignore */ } continue; }
    if (a === '--out' && i + 1 < argv.length) { out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out = a.slice('--out='.length); continue; }
    if (a === '--scrape') { args.mode = 'scrape'; continue; }
    if (a === '--explore') { args.mode = 'explore'; continue; }
    if (a.startsWith('--start-index=')) { const n = num(a.slice('--start-index='.length)); if (n !== undefined) args.startIndex = n; continue; }
    if (a.startsWith('--max-convos=')) { const n = num(a.slice('--max-convos='.length)); if (n !== undefined) args.maxConvos = n; continue; }
    if (a.startsWith('--max-messages=')) { const n = num(a.slice('--max-messages='.length)); if (n !== undefined) args.maxMessages = n; continue; }
    if (a === '--no-jd') { args.jd = false; continue; }
    if (a.startsWith('--url=')) { args.url = a.slice('--url='.length); continue; }
  }

  return { args: jsonArgs ?? args, out };
}

async function main() {
  const { args, out } = parseArgv();
  const result = await runViaBrix('boss', args, { out });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
