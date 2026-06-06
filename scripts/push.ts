// brix CLI 客户端：把本地 built-in-scripts/<name>.ts 推到远端 brix（PUT /scripts/:name）
//
// runViaBrix 只负责"建会话 + 跑脚本"，不部署脚本；远端 server 的 SCRIPTS_DIR 不会自动
// 有本机新写的脚本，所以先用本工具把脚本源码推上去，再 npm run <脚本> 调用。
//
// 用法：
//   BRIX_TOKEN=<token> npm run push -- zhihu zhihu-login
//   BRIX_TOKEN=<token> npm run push -- zhihu --from=scripts        # 从别的目录取源
//
// 目标地址走 .env 的 BRIX_API_URL（连哪），与本机 serve 无关。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pushScript } from '../src/cli/brix-client.js';

function parseArgv(): { names: string[]; from: string } {
  const argv = process.argv.slice(2);
  const names: string[] = [];
  let from = 'built-in-scripts';
  for (const a of argv) {
    if (a.startsWith('--from=')) { from = a.slice('--from='.length); continue; }
    if (a.startsWith('--')) continue;
    names.push(a.replace(/\.ts$/, ''));
  }
  if (names.length === 0) {
    console.error('用法: npm run push -- <脚本名...> [--from=built-in-scripts]');
    process.exit(1);
  }
  return { names, from };
}

async function main() {
  const { names, from } = parseArgv();
  // 逐项独立 try/catch：一个失败不影响其它，最后汇总；有失败则非零退出，但已成功的保留。
  let failed = 0;
  for (const name of names) {
    try {
      const source = await readFile(join(from, `${name}.ts`), 'utf-8');
      const meta = await pushScript(name, source, 'ts');
      console.log(`✓ pushed ${name} (${source.length} chars):`, JSON.stringify(meta));
    } catch (e) {
      failed++;
      console.error(`✗ push ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`done: ${names.length - failed}/${names.length} pushed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
