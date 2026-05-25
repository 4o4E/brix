// brix CLI 客户端：通过 HTTP 调用 server 上的 gemini-draw 脚本
//
// 用法：
//   BRIX_TOKEN=<token> npm run gemini-draw -- "<prompt>" [--out=./out]
//   BRIX_TOKEN=<token> npm run gemini-draw -- --json-args '{"prompt":"画一只猫"}' [--out=./out]
//
// 要求 server 已在跑（npm run serve）；本脚本只是个 HTTP 调用方，不直接操作浏览器。

import { runViaBrix } from '../src/cli/brix-client.js';

function parseArgv(): { args: unknown; out?: string } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let jsonArgs: unknown | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json-args' && i + 1 < argv.length) { try { jsonArgs = JSON.parse(argv[++i]); } catch { /* ignore */ } continue; }
    if (a.startsWith('--json-args=')) { try { jsonArgs = JSON.parse(a.slice('--json-args='.length)); } catch { /* ignore */ } continue; }
    if (a === '--out' && i + 1 < argv.length) { out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out = a.slice('--out='.length); continue; }
    positional.push(a);
  }
  if (jsonArgs !== undefined) return { args: jsonArgs, out };
  if (!positional[0]) {
    console.error('用法: npm run gemini-draw -- "<prompt>" [--out=./out]');
    process.exit(1);
  }
  return { args: { prompt: positional[0] }, out };
}

async function main() {
  const { args, out } = parseArgv();
  const result = await runViaBrix('gemini-draw', args, { url: 'https://gemini.google.com/app', out });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
