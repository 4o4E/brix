// ESM resolve hook：跑在 worker 线程，对 brix 脚本里的所有 import 一律拒绝。
//
// 工作机制：registry.loadScriptModule 在加载 .js 脚本时，URL 上加 `?brix-script=1`
// 标记。本 hook 看到 parentURL 带这个标记就直接抛错 —— 静态 import 在加载阶段被 Node
// 解析为对应 resolve 调用，动态 import() 在执行时也走 resolve，两条路都被堵死。
//
// 注意：本文件必须是纯 JS（.mjs），因为 `register()` 在 worker 里加载它，不一定能拿到
// tsx 这种 TS 转译器。

const MARK = 'brix-script=1';

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL;
  if (parent && parent.includes(MARK)) {
    throw new Error(
      `brix script: import 被拒（"${specifier}"）— brix 脚本不允许任何 import / require / 动态 import，` +
      `所有运行时能力请用注入的 brix API`
    );
  }
  return nextResolve(specifier, context);
}
