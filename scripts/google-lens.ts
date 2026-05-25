// brix CLI 客户端：通过 HTTP 调用 server 上的 google-lens 脚本
//
// 用法：
//   BRIX_TOKEN=<token> npm run lens -- <图片文件> [--out=./out]
//   BRIX_TOKEN=<token> npm run lens -- --json-args '{"imagePath":"C:/path/to.png"}' [--out=./out]
//
// 本脚本把本地图片读成 base64 后传给 server，省掉 server 端再读本地路径
// （server 可能在别的机器，文件根本不存在）。

import { readFile } from 'node:fs/promises';
import { runViaBrix } from '../src/cli/brix-client.js';

interface ParsedArgv {
  args: unknown;
  out?: string;
}

async function parseArgv(): Promise<ParsedArgv> {
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
    console.error('用法: npm run lens -- <图片文件 | data:image/...;base64,...> [--out=./out]');
    process.exit(1);
  }
  const input = positional[0];
  // 本地文件 → 读成 base64 data URL 传给 server
  if (input.startsWith('data:') || (input.length > 256 && !input.includes('/') && !input.includes('\\'))) {
    return { args: { image: input }, out };
  }
  try {
    const buf = await readFile(input);
    const b64 = buf.toString('base64');
    return { args: { image: `data:image/png;base64,${b64}` }, out };
  } catch (e) {
    console.error(`读取图片失败: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

async function main() {
  const { args, out } = await parseArgv();
  const result = await runViaBrix('google-lens', args, { out });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
