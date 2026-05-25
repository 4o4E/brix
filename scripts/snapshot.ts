// brix CLI 客户端：通过 HTTP 调用 server 上的 snapshot 脚本
//
// 用法：
//   BRIX_TOKEN=<token> npm run snapshot -- <url> [--scope=<css>] [--interactive-only] [--max-depth=N] [--out=./out]
//   BRIX_TOKEN=<token> npm run snapshot -- --json-args '{"url":"https://example.com","interactiveOnly":true}' [--out=./out]

import { runViaBrix } from '../src/cli/brix-client.js';

interface SnapshotArgs {
  url?: string;
  scope?: string;
  interactiveOnly?: boolean;
  maxDepth?: number;
}

function parseArgv(): { args: unknown; out?: string; initialUrl?: string } {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  let jsonArgs: unknown | undefined;
  const a: SnapshotArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--json-args' && i + 1 < argv.length) { try { jsonArgs = JSON.parse(argv[++i]); } catch { /* ignore */ } continue; }
    if (tok.startsWith('--json-args=')) { try { jsonArgs = JSON.parse(tok.slice('--json-args='.length)); } catch { /* ignore */ } continue; }
    if (tok === '--out' && i + 1 < argv.length) { out = argv[++i]; continue; }
    if (tok.startsWith('--out=')) { out = tok.slice('--out='.length); continue; }
    if (tok.startsWith('--scope=')) { a.scope = tok.slice('--scope='.length); continue; }
    if (tok === '--interactive-only') { a.interactiveOnly = true; continue; }
    if (tok.startsWith('--max-depth=')) { a.maxDepth = Number(tok.slice('--max-depth='.length)) || 0; continue; }
    if (!tok.startsWith('--') && !a.url) { a.url = tok; continue; }
  }
  if (jsonArgs !== undefined) {
    const url = (jsonArgs && typeof jsonArgs === 'object' && typeof (jsonArgs as SnapshotArgs).url === 'string')
      ? (jsonArgs as SnapshotArgs).url : undefined;
    return { args: jsonArgs, out, initialUrl: url };
  }
  if (!a.url) {
    console.error('用法: npm run snapshot -- <url> [--scope=<css>] [--interactive-only] [--max-depth=N] [--out=./out]');
    process.exit(1);
  }
  return { args: a, out, initialUrl: a.url };
}

async function main() {
  const { args, out, initialUrl } = parseArgv();
  const result = await runViaBrix('snapshot', args, { url: initialUrl, out });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
