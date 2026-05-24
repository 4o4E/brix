# brix

`brix` 是一个浏览器脚本执行平台，管理一个反检测浏览器进程及其上的脚本和会话。平台启动时拉起浏览器，每个 session 对应浏览器里的一个 tab，调用方在同一 tab 上可执行多条脚本，得到结构化结果和诊断信息。

定位是后端基础设施：bot、后端服务、定时任务都通过 HTTP API 调用，不直接操作浏览器进程。部署目标是 Windows。

## 目标

- 浏览器进程管理：平台维护一个长期运行的反检测浏览器进程，加载指定 profile（user-data-dir），常驻不退出。
- 会话管理：session 对应浏览器中的一个 tab，长期保持；支持在同一 tab 上多次连续操作。所有 session 共享同一份 cookie / 登录态 / storage。
- 脚本管理：保存脚本、版本、适用站点、输入参数、输出 schema、最近成功状态。
- 任务执行：调用方提交 `(sessionId, scriptId, input)`，平台执行脚本步骤并返回结构化结果。
- 协议灵活度：浏览器进程暴露 CDP，调用方既可走 Playwright 高层 API，也可下到 raw CDP 干 OS 级操作（原生粘贴、剪贴板、拖拽、文件 chooser 等 JS 难做或做不准的事），并允许外部工具直连接管。
- 诊断回放：保存页面截图、HTML 摘要、控制台错误、网络失败、脚本版本和执行耗时。
- 未来可拆：bot、后端或其他服务都通过 API 调用，不绑定具体业务进程。

## 非目标

- 不做验证码绕过或对抗式反爬。
- 不把所有站点都强行抽象成爬虫；能用 API 的脚本仍然走 API。
- 不让平台自动生成或修复脚本；脚本完全由人手编写和版本化提交。
- 不让业务方直接操作浏览器实例，所有访问通过 API。
- 不在一个进程内做多账户隔离；多账户场景靠跑多份 brix 实例解决。
- 不追求跨平台一致性；以 Windows 为第一部署目标。

## 核心概念

### 浏览器进程

平台启动时拉起 **一个** 反检测浏览器进程，加载 `<BRIX_USER_DATA_DIR>/<BRIX_PROFILE>/` 下的 profile，常驻运行。所有 session 都在这个进程里以 tab 形式存在，共享同一份 cookie / 登录态 / storage。

### 会话 (Session)

一个 Session 对应浏览器中的一个 tab（page）。

- 生命周期由调用方控制：创建后保持活动，直到调用方关闭或 TTL 到期。
- **单 session 内串行**：同一 session 同一时刻只能跑一个 run，避免在同一 tab 上互相干扰。
- **不同 session 之间并发**：不同 tab 可以并行执行 run（受浏览器整体负载和站点冷却限制）。

### 脚本 (Script)

一段保存在平台中的、由人手编写的浏览器操作序列 + 结果提取逻辑。脚本本身不绑定 session，可以在任意符合 `match` 条件的 session 上运行。

### 执行 (Run)

一次脚本在某个 session（tab）上的执行。Run 本身无状态，所有可复用状态都留在 session 的 tab 里以及共享的 profile 里。

## 核心流程

```text
brix 启动
  -> 拉起浏览器进程（常驻）
     加载 profile = <BRIX_USER_DATA_DIR>/<BRIX_PROFILE>/

bot / backend

  -> POST /sessions                       # 申请一个 tab
     <- { sessionId }

  -> POST /sessions/{id}/runs             # 在 tab 上执行脚本（可多次）
     { scriptId: "google-lens", input: { url: "..." } }
     <- { runId, status, result, diagnostics }

  -> POST /sessions/{id}/runs             # 复用 tab 上的状态再来一次
     { scriptId: "google-lens-next-page" }

  -> DELETE /sessions/{id}                # 关闭 tab
```

## 浏览器栈

### 候选对比

| 维度 | rebrowser-patches (Chromium) | Camoufox (Firefox) | 真实 Chrome + rebrowser-playwright |
|---|---|---|---|
| 内核 | Patched Chromium | Patched Firefox | 本地真实 Chrome |
| 调试协议 | CDP | Juggler（Firefox 等价 CDP） | CDP |
| 反检测重点 | CDP 层痕迹（`Runtime.Enable`、`sourceURL=pptr:`、utility world 名） | C++ 层 spoof navigator / WebGL / Canvas / 字体 / WebRTC | CDP 层痕迹 + 真实浏览器指纹基线 |
| CreepJS 检出率 | 高（接近 vanilla playwright） | 接近 0% | 中（指纹基线真实，CDP 痕迹已修） |
| Windows 部署 | 需 `patch.exe`（Git for Windows）；纯 Node 运行时 | v150 之前 Windows build 不全；headless 仍有崩溃 issue (#614) | 最简单，沿用本地 Chrome 安装 |
| API | drop-in puppeteer / playwright | Playwright Firefox 子集 | 标准 Playwright + CDP |
| Node 绑定 | 一等公民 | 第三方 `camoufox-js`（Apify 维护，标 Experimental） | 一等公民 |
| 安装体积 | 小 | 自带 ~200MB 定制 Firefox 二进制 | 小（复用本地 Chrome） |
| 维护活跃度 | 放缓（最近 release 2025-05） | 高（2026-05 仍大版本迭代） | 跟随 playwright 节奏 |
| 外部调试生态 | DevTools 可远程 inspect | 只能用 Playwright Firefox inspector / `about:debugging` | DevTools 可远程 inspect，生态最广 |

数据来源：2026 公开 benchmark（CreepJS、Cloudflare 实测）。Camoufox 在指纹层全面领先；rebrowser 系列只修 CDP 层泄露，对 Canvas/WebGL/字体不处理。

### 推荐

**主选：真实 Chrome + `rebrowser-playwright`（叠加 `rebrowser-patches`）。**

理由：

- **协议灵活度 + 原生能力最完整**。CDP 有公开文档，可在 Playwright 之外用 `chrome-remote-interface` 等任意客户端，也可在 Playwright 内 `page.context().newCDPSession(page)` 下到 raw CDP；浏览器原生粘贴、剪贴板读写、原生拖拽、文件 chooser 等 JS 难做的操作 CDP 都有一等支持（`Browser.grantPermissions` + `Input.dispatchKeyEvent` + `Input.dispatchMouseEvent` 等）。Juggler 协议无公开文档、客户端只有 Playwright 一家，这类能力要么缺失要么不可靠。
- **暴露调试端点最简单**：Chrome 的 `--remote-debugging-port` 直接给出 `ws://127.0.0.1:<port>/devtools/browser/<id>`，DevTools / chrome-remote-interface / Puppeteer 等任意工具都能直连。
- 真实 Chrome 自带"主流浏览器指纹"基线，配合 rebrowser-patches 清掉 CDP 层泄露痕迹（`Runtime.Enable`、`sourceURL=pptr:` 等）。
- 安装链路最短：本地装 Chrome + `npm i rebrowser-playwright`，不需要额外下 200MB 二进制。
- API 与标准 Playwright 完全兼容，便于后续切换或并存其它驱动。

**主要权衡**：

- 指纹层（CreepJS / Canvas / WebGL）防护明显弱于 Camoufox。遇到 Cloudflare / DataDome 高级模式被识别的站点，需额外接入 fingerprint 注入（BrowserForge 等）或换路线。
- rebrowser-patches 维护节奏放缓（最近 release 2025-05），要锁版本并跟 Playwright 升级做回归测试。

**备选：Camoufox（通过 `camoufox-js`）。**

适用场景：指纹防护要求极致、且业务场景不依赖 CDP 原生能力（粘贴 / 剪贴板 / 复杂输入分发等）的目标站点。代价是只能 Playwright client 连得上（第三方工具 / DevTools 远程 inspect 全部失效），Juggler 协议在浏览器原生操作上能力不全，调试可达性主要依靠 Playwright Firefox 自带 inspector。

**架构建议**：抽象 `BrowserDriver` 接口，主线跑 Chrome。若后续少数站点指纹防护要求极致，再挂 Camoufox 实现作为旁路通道。

### 运行参数

- 在 Windows 上以服务 / 后台进程方式运行；浏览器进程加载固定的 user-data-dir，进程内复用。
- 默认有头模式（headless 更容易被指纹识别）；是否支持 headless 后续视测试结果决定。
- 提供两种启动模式：
  - **平台拉起**（默认）：brix 自行启动反检测浏览器并管理生命周期。
  - **附加现有**：调用方自行启动浏览器并暴露调试端口，把地址给 brix 接管。
- 浏览器进程的 CDP 端点（`ws://127.0.0.1:<port>/devtools/browser/<id>`）在平台启动日志中打印，也可通过 `GET /debug-info` 查询。

## 脚本模型草案

```ts
export interface BrowserScript {
  id: string;
  version: number;
  name: string;
  type: 'browser' | 'api';
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  match?: {
    domains?: string[];
    urlPatterns?: string[];
  };
  steps: ScriptStep[];
  extractor?: { code: string };           // 在结果页执行的纯读取脚本
  limits?: {
    timeoutMs?: number;
    cooldownMs?: number;
  };
}

export type ScriptStep =
  | { type: 'navigate'; urlTemplate: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { type: 'upload';   selector: string; inputKey: string }
  | { type: 'click';    selector: string }
  | { type: 'waitFor';  selector: string; timeoutMs?: number }
  | { type: 'execute';  code: string };   // 在页面上下文里跑一段自定义 JS
```

API 类脚本 (`type: 'api'`) 不依赖浏览器，走另一组 step 类型（request / transform 等），后续细化。

## API 草案

### 创建会话

```http
POST /sessions
Content-Type: application/json

{
  "ttlSeconds": 3600
}
```

返回：

```json
{
  "sessionId": "sess_01",
  "targetId":  "page_target_id",
  "expiresAt": "2026-05-22T12:00:00Z"
}
```

所有 session 共享平台启动时已绑定的 profile，请求中无需指定。`targetId` 是 CDP 层稳定的 target 标识，外部 client 拿着它可以用 `Target.attachToTarget` 直接寻址该 tab，无需扫描。

### 在会话上执行脚本

支持同步 / 异步两种模式，由调用方在 `mode` 字段决定。同一 session 串行执行 run，不同 session 之间可并发。两种模式排队规则一致，区别只在调用方如何拿结果。

**同步模式 (`mode: "sync"`，默认)**：HTTP 连接保持到执行结束，直接返回完整结果。

```http
POST /sessions/sess_01/runs
Content-Type: application/json

{
  "scriptId":  "google-lens",
  "input":     { "url": "https://example.com/image.jpg" },
  "mode":      "sync",
  "timeoutMs": 60000,
  "options":   { "saveDiagnostics": true }
}
```

`timeoutMs` 解析优先级：请求参数 → 脚本 `limits.timeoutMs` → 平台默认 `60000`。

返回：

```json
{
  "runId":         "run_01",
  "scriptId":      "google-lens",
  "scriptVersion": 3,
  "status":        "ok",
  "result":        { "candidates": [] },
  "diagnostics":   {
    "durationMs":     8421,
    "screenshotPath": "runs/run_01/page.png"
  }
}
```

**异步模式 (`mode: "async"`)**：立即返回 `runId`，调用方通过 `GET /runs/{runId}` 轮询状态和结果。

```http
POST /sessions/sess_01/runs
Content-Type: application/json

{
  "scriptId": "google-lens",
  "input":    { "url": "..." },
  "mode":     "async"
}
```

返回：

```json
{
  "runId":  "run_01",
  "status": "pending"
}
```

### 关闭会话

```http
DELETE /sessions/sess_01
```

### 其他端点

- `GET /sessions` — 列出活动会话。
- `GET /sessions/{id}` — 当前 URL、剩余 TTL。
- `GET /runs/{id}` — 查询 run 状态和结果（异步模式轮询用，也可查历史）。
- `GET /debug-info` — 返回浏览器 CDP 端点地址，便于人工接管或外部工具直连。

## 图片搜源脚本规划

- `google-lens`：浏览器脚本，默认主链路。输入图片 URL 或文件，输出候选页面、候选图、标题和来源站点。
- `saucenao`：API 脚本，使用官方 API key，输出相似度、数据库、外链和缩略图。
- `trace-moe`：API 脚本，动画帧专用，输出番剧、集数、时间点和相似度。
- `iqdb`：HTTP/API 风格脚本，低成本补充候选。
- `ascii2d`：浏览器脚本，作为插画类低频兜底。
- `yandex-image`：浏览器脚本，Google 不可用时兜底。

搜源结果之后可以接独立的 verifier（pHash / dHash / 颜色直方图 / 多模态比对），但 verifier 不在 brix 范围内，由调用方或专门服务负责。

## 浏览器与诊断

- 浏览器进程常驻，所有 session 复用；run 结束后不主动清理 tab 状态，页面与 cookie 留给同 session 后续 run 或其它 session 共享。
- 按脚本和站点设置 `timeoutMs`、`cooldownMs`。
- 每个 run 默认保存：截图、最终 URL、标题、控制台错误、关键网络失败、步骤级耗时、scriptVersion。
- 存储路径：`<BRIX_DATA_DIR>/runs/<runId>/`，按 TTL 清理。

## 配置

通过环境变量调整，未设置时取项目下默认值：

- `BRIX_USER_DATA_DIR`：浏览器 profile 根目录，默认 `<projectRoot>/user-data-dir`。
- `BRIX_PROFILE`：profile 名称（即 `BRIX_USER_DATA_DIR` 下的子目录名），默认 `default`。整个平台进程只用一个 profile；切换需重启 brix。
- `BRIX_DATA_DIR`：诊断 / 截图 / run 历史的根目录，默认 `<projectRoot>/data`。

`user-data-dir` 和 `data` 都建议加入 `.gitignore`，且不要混放在仓库目录外的共享盘上（user-data-dir 含 cookie 等敏感数据）。

## 参考项目

- `F:\Desktop\project\source-searcher`：提供历史搜源站点清单和旧解析逻辑参考。
- `F:\Desktop\project\my-claw`：提供 CDP 会话、Playwright 操作、图片上传参考。

## 初期开发步骤

1. 建立 TypeScript / Node 22 项目骨架，搭 HTTP API 框架。
2. 实现 browser manager：平台启动时通过 rebrowser-playwright 拉起真实 Chrome（叠加 rebrowser-patches），加载 profile，常驻管理；暴露 CDP 端点。
3. 实现 session manager：在浏览器上分配 tab，按 sessionId 索引，按 TTL 回收。
4. 实现 script registry：脚本存储、版本管理、JSON Schema 校验。
5. 实现 run executor：在指定 session 的 tab 上按 step 执行，收集诊断；支持 sync / async 模式。
6. 接入 `google-lens` 作为第一个 browser script，打通端到端。
7. 补 `saucenao` 和 `trace-moe` 作为 API script。
8. 给 bot 提供 `session + script` 的最小调用接口。
