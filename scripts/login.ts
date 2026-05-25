// brix CLI 客户端：通过 HTTP 触发 server 上的 login 脚本
//
// 用法：
//   BRIX_TOKEN=<token> npm run login
//
// 在浏览器里完成登录后，cookie 留在 USER_DATA_DIR；下次 newTab 自动复用。

import { runViaBrix } from '../src/cli/brix-client.js';

async function main() {
  const result = await runViaBrix('login', {}, { url: 'https://accounts.google.com/' });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
