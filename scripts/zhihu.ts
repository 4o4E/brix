// brix CLI 客户端：通过 HTTP 调用 server 上的 zhihu 抓取脚本
//
// 用法：
//   BRIX_TOKEN=<token> npm run zhihu -- https://www.zhihu.com/question/19550225
//   BRIX_TOKEN=<token> npm run zhihu -- https://zhuanlan.zhihu.com/p/123456 --max-answers=50
//   BRIX_TOKEN=<token> npm run zhihu -- --json-args '{"url":"...","includeHtml":true}'
//
// 末行打印结果 JSON：{runId, output, savedFiles}。output 见 ZhihuOutput。

import { runViaBrix } from '../src/cli/brix-client.js';

interface ZhihuArgs {
  url: string;
  maxAnswers?: number;
  maxScrolls?: number;
  includeHtml?: boolean;
  comments?: boolean;
  maxComments?: number;
  maxReplies?: number;
  downloadImages?: boolean;
}

function parseArgv(): { args: ZhihuArgs; out?: string } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let jsonArgs: ZhihuArgs | undefined;
  let url: string | undefined;
  let maxAnswers: number | undefined;
  let maxScrolls: number | undefined;
  let maxComments: number | undefined;
  let maxReplies: number | undefined;
  let includeHtml: boolean | undefined;
  let noComments: boolean | undefined;
  let downloadImages: boolean | undefined;

  // 空串 / 非数字（如 `--max-comments=`）返回 undefined，避免 Number('')===0 把功能静默关掉
  const num = (v: string): number | undefined => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json-args' && i + 1 < argv.length) { try { jsonArgs = JSON.parse(argv[++i]); } catch { /* ignore */ } continue; }
    if (a.startsWith('--json-args=')) { try { jsonArgs = JSON.parse(a.slice('--json-args='.length)); } catch { /* ignore */ } continue; }
    if (a === '--out' && i + 1 < argv.length) { out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out = a.slice('--out='.length); continue; }
    if (a === '--max-answers' && i + 1 < argv.length) { maxAnswers = num(argv[++i]); continue; }
    if (a.startsWith('--max-answers=')) { maxAnswers = num(a.slice('--max-answers='.length)); continue; }
    if (a === '--max-scrolls' && i + 1 < argv.length) { maxScrolls = num(argv[++i]); continue; }
    if (a.startsWith('--max-scrolls=')) { maxScrolls = num(a.slice('--max-scrolls='.length)); continue; }
    if (a === '--max-comments' && i + 1 < argv.length) { maxComments = num(argv[++i]); continue; }
    if (a.startsWith('--max-comments=')) { maxComments = num(a.slice('--max-comments='.length)); continue; }
    if (a === '--max-replies' && i + 1 < argv.length) { maxReplies = num(argv[++i]); continue; }
    if (a.startsWith('--max-replies=')) { maxReplies = num(a.slice('--max-replies='.length)); continue; }
    if (a === '--html' || a === '--include-html') { includeHtml = true; continue; }
    if (a === '--no-comments') { noComments = true; continue; }
    if (a === '--download-images' || a === '--images') { downloadImages = true; continue; }
    if (!a.startsWith('--')) { url = a; continue; }
  }

  if (jsonArgs?.url) return { args: jsonArgs, out };
  if (!url) {
    console.error('用法: npm run zhihu -- <知乎链接> [--max-answers=N] [--max-comments=N] [--max-replies=N] [--no-comments] [--html] [--download-images] [--out=./out]');
    process.exit(1);
  }
  const args: ZhihuArgs = { url };
  if (maxAnswers !== undefined) args.maxAnswers = maxAnswers;
  if (maxScrolls !== undefined) args.maxScrolls = maxScrolls;
  if (maxComments !== undefined) args.maxComments = maxComments;
  if (maxReplies !== undefined) args.maxReplies = maxReplies;
  if (includeHtml) args.includeHtml = true;
  if (noComments) args.comments = false;
  if (downloadImages) args.downloadImages = true;
  return { args, out };
}

async function main() {
  const { args, out } = parseArgv();
  // 不把 url 传给 session 初始导航：脚本内部会 page.goto(args.url)，传了会重复加载
  // （对知乎这种重风控页面尤其浪费，且给风控两次机会）。
  const result = await runViaBrix('zhihu', args, { out });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
