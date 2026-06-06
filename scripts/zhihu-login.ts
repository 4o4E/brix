// brix CLI 客户端：通过 HTTP 触发 server 上的 zhihu-login 脚本
//
// 用法：
//   BRIX_TOKEN=<token> npm run zhihu-login
//
// 浏览器会打开知乎登录页，在窗口里完成登录（扫码 / 短信 / 密码）后脚本自动返回，
// cookie 留在 USER_DATA_DIR；之后 `npm run zhihu` 自动复用登录态。
//
// 若自动化 Chrome 反复被风控拦截，改用纯净 Chrome 手动登录：
//   npm run open-profile -- https://www.zhihu.com/signin
// （需先停掉 serve；登录后关窗口再重启 serve）

import { runViaBrix } from '../src/cli/brix-client.js';

async function main() {
  const result = await runViaBrix('zhihu-login', {}, { url: 'https://www.zhihu.com/signin' });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
