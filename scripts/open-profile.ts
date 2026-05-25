// 在 brix 的 USER_DATA_DIR 上启一个"普通"Chrome —— 不带 CDP、不带 automation flag。
//
// 用途：手动登录任何被风控的服务（Google / 各类 SaaS 等）。
//   Google 的 "browser not secure" 检测 + reCAPTCHA 之类的风控对"看起来是
//   自动化的 Chrome"特别敏感；CDP 端口、navigator.webdriver、init script
//   注入都是已知指纹。这个脚本把 Chrome 启得跟用户自己手动开的完全一样，
//   登录态写到 user-data-dir 后，brix serve 再以 CDP attach 复用 cookie。
//
// 用法：
//   npm run open-profile                              about:blank
//   npm run open-profile -- https://accounts.google.com
//   npm run open-profile -- --url=https://gemini.google.com/app
//
// 流程：
//   1) 关掉 npm run serve（profile 同时只能被一个 Chrome 持有）
//   2) 跑本脚本，弹出干净 Chrome
//   3) 在窗口里完成登录
//   4) 关窗口（脚本随之退出）
//   5) 启动 npm run serve；之后任何 session 都是登录态
//
// 与 `npm run login` 的区别：
//   `npm run login` = 通过 brix HTTP API + patchright + CDP，自动化的登录脚本。
//   `npm run open-profile` = 完全不走 brix，纯人肉登录，专为绕过风控。

import { spawn } from 'node:child_process';
import { getEnv } from '../src/config.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('open-profile');

function parseArgv(): { url: string } {
  const argv = process.argv.slice(2);
  let url = 'about:blank';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) { url = argv[++i]; continue; }
    if (a.startsWith('--url=')) { url = a.slice('--url='.length); continue; }
    if (!a.startsWith('--')) { url = a; continue; }
  }
  return { url };
}

async function main() {
  const env = getEnv();
  if (!env.CHROME_PATH) {
    console.error('Chrome 未找到。设置 BRIX_CHROME_PATH 或装到默认位置。');
    process.exit(1);
  }

  const { url } = parseArgv();

  // 注意：故意只给最少 args。不加 --remote-debugging-port，不加
  // --disable-blink-features=AutomationControlled，不加 --no-first-run 之外
  // 任何东西。任何额外 flag 都可能被风控当指纹。
  const args = [
    `--user-data-dir=${env.USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];

  log.info(`spawn chrome ${env.CHROME_PATH}`);
  log.info(`user-data-dir=${env.USER_DATA_DIR}`);
  log.info(`url=${url}`);
  console.log('');
  console.log('===========================================================');
  console.log('  Chrome 已启动。在窗口里完成登录后关掉窗口即可。');
  console.log('  注意：本脚本运行期间不要同时启 brix serve（profile 互斥）。');
  console.log('===========================================================');
  console.log('');

  // detached:false → child 是本进程的子进程，用户 Ctrl+C 也会一并退出
  // stdio:'ignore' → Chrome 在 Windows 上有时会往 stderr 喷大量 GPU 警告，
  //   inherit 会污染我们自己的输出
  const child = spawn(env.CHROME_PATH, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  });

  child.on('error', (e) => {
    console.error('chrome spawn error:', e);
    process.exit(1);
  });

  const code: number = await new Promise((res) => {
    child.on('exit', (c) => res(c ?? 0));
  });
  // 在 Windows 上 chrome.exe 经常只是 launcher wrapper，spawn 后立刻 exit(0)
  // 而真正的浏览器窗口还活着。所以 code=0 不等于 chrome 真退了 —— 但本脚本
  // 已经把控制权交给用户了，wrapper 退就退，不影响用户继续用 Chrome。
  log.info(`chrome wrapper exited (code=${code}); 浏览器窗口可能仍在运行，关掉即可。`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
