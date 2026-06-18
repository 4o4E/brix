# brix

简体中文 | [English](README.en.md)

浏览器脚本执行平台：拉起一个真实 Chrome（叠加 [rebrowser-patches][rb]），通过 CDP 接管，对外暴露 HTTP API 让远端调用方在 tab 里跑预置脚本，取回结构化结果和落地的下载文件。

除整段脚本外，还提供**交互式单步原语**（`/sessions/:sid/actions`：navigate / snapshot / click / fill …，ref 跨调用存活）和一个 **MCP server**，把浏览器能力统一暴露给 LLM——形成「探索（单步试错）→ 固化（写成脚本）→ 生产（直接调用脚本）」的流水线。

部署目标 Windows。许可证 [Apache-2.0](LICENSE)。设计背景参见 [docs/design.md](docs/design.md)。

> 本项目通过源码运行（`tsx`），未发布到 npm。

[rb]: https://github.com/rebrowser/rebrowser-patches

## 前置依赖

- Windows 10/11
- Node.js 22+
- 本地装 Chrome（默认路径 `C:\Program Files\Google\Chrome\Application\chrome.exe`，或通过 `BRIX_CHROME_PATH` 覆盖）

## 安装

```bash
npm install
```

不会自动下载 Chromium —— brix 用本机的真实 Chrome。

## 启动 HTTP 服务

```bash
BRIX_TOKEN=<your-secret> npm run serve
# brix http on http://0.0.0.0:9233
```

- `BRIX_TOKEN` 必须设置，否则启动失败。
- `/health` 公开；其余端点需要 `Authorization: Bearer <token>` 或 `X-Brix-Token: <token>`。
- 首次请求会拉起 Chrome 进程（CDP `--remote-debugging-port=9222`），常驻复用。

## CLI

每个脚本都既可走 HTTP，也可单独 CLI 调试：

```bash
npm run login                          # 通过 brix HTTP API 触发登录脚本（自动化）
npm run lens -- ./image.png            # Google Lens 识图
npm run gemini-draw -- "画一只猫"      # Gemini 生图
npm run chatgpt-draw -- "画一只猫"     # ChatGPT 生图
npm run snapshot -- https://example.com [--interactive-only] [--max-depth=N]
npm run zhihu -- https://www.zhihu.com/question/19550225  # 知乎抓取（正文+图片+评论）
npm run zhihu -- https://zhuanlan.zhihu.com/p/96956163 --max-comments=50 --download-images
npm run zhihu-login                    # 打开知乎登录页，等你登录（cookie 留在 profile）
```

如果 Google 把自动化的 Chrome 判为"不安全浏览器"，先关掉 serve，用 `open-profile` 在同一个
USER_DATA_DIR 上启一个 **不带 CDP / 不带 automation flag** 的纯净 Chrome，手动登录后关窗口，
cookie 会留在 profile 里，下次 `npm run serve` 经 CDP attach 即继承登录态：

```bash
npm run open-profile -- https://accounts.google.com
# 在弹出的 Chrome 里登录 → 关闭窗口 → 启 serve
```

CLI 末行会打印一行 JSON：`{runId, output, downloads, error}`。downloads 里的文件落在 `<DATA_DIR>/runs/<runId>/downloads/`。

也可强制传 JSON 参数：

```bash
npm run gemini-draw -- --json-args '{"prompt":"画一只猫"}'
```

## 环境变量

| 名 | 默认 | 说明 |
|---|---|---|
| `BRIX_TOKEN` | — | HTTP 鉴权 token。空则服务拒启 |
| `BRIX_HTTP_HOST` | `0.0.0.0` | HTTP 监听地址（server 绑哪） |
| `BRIX_HTTP_PORT` | `9233` | HTTP 监听端口 |
| `BRIX_API_URL` | 由 host/port 推导 | CLI 客户端连接的 brix 服务地址（连哪），如 `http://192.168.66.120:9400`。与 server 绑定解耦，可指向远端 brix |
| `BRIX_USER_DATA_DIR` | `./user-data-dir/default` | Chrome profile 根目录（含 cookie） |
| `BRIX_DATA_DIR` | `./data` | run 产物根目录（含 downloads） |
| `BRIX_CHROME_PATH` | 自动探测 | Chrome 可执行文件路径 |
| `BRIX_CDP_PORT` | `9222` | Chrome remote debugging port |
| `BRIX_CDP_URL` | `http://127.0.0.1:<port>` | 已运行的 CDP 端点（附加模式） |
| `BRIX_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `BRIX_DEBUG_ARTIFACTS` | `false`（`LOG_LEVEL=debug` 时隐式 `true`） | 是否落盘调试产物（`stage-*.png/html`、结果页 `page.png/html`）；关时只留 `result.json` + `downloads/`。单次请求可用 body `debug` 覆盖 |
| `BRIX_IDLE_TIMEOUT_MIN` | `30` | 空闲多少分钟后断开 Playwright（不关 Chrome），0 = 不超时 |
| `BRIX_DOWNLOAD_DIR` / `BRIX_CACHE_DIR` / `BRIX_CRASH_DIR` | `<DATA_DIR>/...` | 各类 Chrome 内部目录 |
| `BRIX_SNAPSHOT_MAX_CHARS` | `16000` | snapshot 文本最大字符数 |

## HTTP API

错误统一：`400 bad_request` / `403 forbidden` / `404 not_found` / `500 internal`，body 形如 `{"error":"...","details":"..."}`。

### 公开端点

| Method | Path | 响应 |
|---|---|---|
| GET | `/health` | `200 {ok:true}` |

### 会话（执行入口）

所有脚本执行都在某个 session 的 tab 里发生。

| Method | Path | Body | 响应 |
|---|---|---|---|
| POST | `/sessions` | `{url?:string}` | `201 {sessionId, url}` —— 开新 tab，可选直接 goto |
| GET | `/sessions` | — | `200 [{sessionId, url, createdAt, lastActiveAt}, ...]` |
| POST | `/sessions/:sid/scripts/:name` | `{args?:any}` | `200 {runId, output, downloads}` —— 同步等完成 |
| POST | `/sessions/:sid/actions` | `{op, ...params, returnSnapshot?, debug?}` | `200 {runId, op, result?, snapshot?, downloads?}` —— 单步原语 |
| GET | `/sessions/:sid/trace` | — | `200 {trace:[{ts, op, params, ok, resultSummary?}, ...]}` —— 动作轨迹（最近 200 条） |
| DELETE | `/sessions/:sid` | — | `204` |

脚本 throw 时返回 `500 {error:"script_failed", details, runId, downloads}` —— 调用方可拿 `runId` 去 files 端点取已经落地的部分产物。动作（`/actions`）失败时类似返回 `500 {error:"action_failed", details, runId}`；参数/未知 op 返回 `400 bad_request`。

#### 交互式单步原语（`/sessions/:sid/actions`）

整段脚本之外的另一种执行形态：一次发一个浏览器原语，看结果再决定下一步——LLM 探索网页、人工随时介入（有头共享 tab）都走这里。`snapshot` 产生的 `ref`（`e1/e2`…）**按 session 存活**，跨多次调用有效，直到下次 `snapshot` 刷新。同一 session 串行执行。

`op` 取值（`target` = ref 或 CSS selector）：

| op | 关键参数 | 说明 |
|---|---|---|
| `navigate` | `url`, `waitUntil?` | 导航 |
| `snapshot` | `scope?`, `interactiveOnly?`, `maxDepth?` | 抓带 `[ref=eN]` 的结构化快照 |
| `click` | `target`, `expectDownload?`, `saveAs?`, `optional?` | 点击；`expectDownload` 时捕获下载落到本 session 的 run |
| `fill` / `type` | `target`, `value` | 覆盖填入 / 逐字符键入 |
| `press` | `key` | 按键 |
| `select` / `hover` | `target`(, `value`) | 选项 / 悬停 |
| `scroll` | `direction`, `amount?` | 滚动 |
| `upload` | `target`, `files` | 投文件（base64/dataUrl，不接受宿主路径） |
| `eval` | `source` | 页面内执行 JS（字符串） |
| `waitForSelector` / `waitForLoad` / `waitForUrl` | … | 等待条件 |
| `text` / `attr` / `count` / `content` / `url` / `title` | `selector?` | 读取页面信息 |
| `screenshot` | `fullPage?` | 截图（返回 base64） |

变更类 op 传 `returnSnapshot:true` 会顺带返回刷新后的快照（含新 refs）。`/trace` 返回你在该 session 上跑过的成功动作序列，便于回看并**固化成脚本**——brix 只给轨迹，脚本由你/LLM 按下文约定编写，不自动生成。

### 脚本 CRUD（不含执行）

`scripts/` 目录下的 `.ts` 文件。内置脚本（gemini-draw / google-lens / snapshot / login）走同一套，调用方有 token 就有权改/删；想恢复就 PUT 回去。

| Method | Path | Body | 响应 |
|---|---|---|---|
| GET | `/scripts` | — | `200 [{name, description?, argsExample?, bytes, createdAt, updatedAt}, ...]` |
| GET | `/scripts/:name` | — | `200 {meta, source}` |
| PUT | `/scripts/:name` | `{source:string}` | `200 {meta}` —— 写前用 `tsc --noEmit` 做语法检查，失败 `400 bad_script` |
| DELETE | `/scripts/:name` | — | `204` |

`name` 规则：`^[a-z0-9][a-z0-9-]{0,63}$`。源码上限 1 MB。

### 下载文件

每个 run 产生的下载文件落在 `<DATA_DIR>/runs/<runId>/downloads/`，由这套端点暴露。run 的其他产物（截图、HTML、`result.json`、stage-*）在 `runs/<runId>/` 但 **不通过 HTTP 暴露**。

| Method | Path | 响应 |
|---|---|---|
| GET | `/runs/:id/files` | `200 [{name, bytes, mimeType, downloadedAt}, ...]` |
| GET | `/runs/:id/files/:name` | `200 <bytes>` + `Content-Type` / `Content-Length` / `Content-Disposition: attachment` |
| DELETE | `/runs/:id/files/:name` | `204` —— 硬删除 |

文件名校验：`^[A-Za-z0-9._-]{1,255}$`，且不以 `.` 开头、不含 `..`。`/`、`\`、`..` 等路径穿越尝试直接 404。

### 例子

```bash
TOKEN=test123 BASE=http://127.0.0.1:9233

# 1. 开 session（直接打开 gemini）
SID=$(curl -sX POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://gemini.google.com/app"}' $BASE/sessions | jq -r .sessionId)

# 2. 跑 gemini-draw
RES=$(curl -sX POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"args":{"prompt":"画一只猫"}}' $BASE/sessions/$SID/scripts/gemini-draw)
RID=$(echo $RES | jq -r .runId)

# 3. 列 / 取 / 删 下载文件
curl -H "Authorization: Bearer $TOKEN" $BASE/runs/$RID/files
curl -H "Authorization: Bearer $TOKEN" $BASE/runs/$RID/files/image-0.png -o cat.png
curl -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/runs/$RID/files/image-0.png -i

# 4. 关 session
curl -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/sessions/$SID -i
```

## MCP 服务

把上面的浏览器能力以 [Model Context Protocol](https://modelcontextprotocol.io) 暴露给 LLM 客户端（Claude Desktop / Claude Code 等）。MCP server 本身**不拉 Chrome**，它只是 brix 的又一个 HTTP 调用方——所以先 `npm run serve` 起 brix，再起 MCP：

```bash
BRIX_TOKEN=<your-secret> npm run mcp
# brix-mcp running on stdio
```

stdio 传输。复用 brix 的 env：`BRIX_TOKEN` 必填；`BRIX_API_URL` 可指向远端 brix（否则按 `BRIX_HTTP_HOST/PORT` 推导本机）。

在 MCP 客户端里这样配置（以 Claude Desktop 的 `mcpServers` 为例）：

```json
{
  "mcpServers": {
    "brix": {
      "command": "npx",
      "args": ["tsx", "scripts/mcp.ts"],
      "cwd": "/abs/path/to/brix",
      "env": { "BRIX_TOKEN": "<your-secret>", "BRIX_API_URL": "http://127.0.0.1:9233" }
    }
  }
}
```

暴露的 tool（26 个）：

- **会话**：`session_open` / `session_list` / `session_close` / `session_trace`
- **交互原语**：`browser_navigate` / `browser_snapshot` / `browser_click`（含 `expectDownload`）/ `browser_fill` / `browser_type` / `browser_press` / `browser_select` / `browser_hover` / `browser_scroll` / `browser_upload` / `browser_eval` / `browser_wait` / `browser_read` / `browser_screenshot`（回图块）
- **逃生口**：`browser_action`（透传任意 `op`）
- **脚本**：`script_list` / `script_get` / `script_save`（固化）/ `script_delete` / `script_run`（生产）
- **产物**：`run_files_list` / `run_file_get`（图片回图块）

典型流程：`session_open` → 反复 `browser_snapshot`/`browser_click`/… 探索 → `session_trace` 回看 → `script_save` 固化成 `.js` → 之后 `script_run` 直接调用。

## 内置脚本

| 脚本 | args | 输出要点 |
|---|---|---|
| [gemini-draw](scripts/gemini-draw.ts) | `{prompt: string, images?: [{filename?, mimeType?, dataUrl?/base64?}]}` | 图片落 `downloads/image-N.<ext>`；文字回复在 `output.text` |
| [chatgpt-draw](scripts/chatgpt-draw.ts) | `{prompt: string, images?: [{filename?, mimeType?, dataUrl?/base64?}]}` | 图片落 `downloads/image-N.<ext>`；文字回复在 `output.text` |
| [google-lens](scripts/google-lens.ts) | `{image: string}`（base64/dataURL）或 `{imagePath: string}` | `output.pages: [{title, url, sourceDomain, thumbnailUrl, ...}]`；`output.aiOverview: {text, sources: [{title, url, sourceDomain}], generated}`（AI 概览正文与引用来源） |
| [snapshot](scripts/snapshot.ts) | `{url?, scope?, interactiveOnly?, maxDepth?}` | `output.snapshot: string`（带 `[ref=eN]`）+ refMap 落 `refs.json` |
| [login](scripts/login.ts) | — | 打开 accounts.google.com 等用户登录，最多 10 分钟。cookie 留在 profile |
| [zhihu](scripts/zhihu.ts) | `{url, maxAnswers?, comments?, maxComments?, maxReplies?, includeHtml?, downloadImages?}` | `output.items: [{type, author, authorAvatar, content, images:[{url,width,height,caption}], voteCount, commentCount, url, comments:[{author, content, likeCount, replyTo, children:[...]}], ...}]` + `title`/`questionDetail`/`loginWall`。支持问题/回答/专栏/想法；评论走 comment_v5 API（顶层+嵌套回复）；图片给原图链接，`downloadImages` 时落 `downloads/img-*` |
| [zhihu-login](scripts/zhihu-login.ts) | — | 打开知乎登录页等用户登录，最多 10 分钟。cookie 留在 profile |

## 写自定义脚本

约定：

```ts
// scripts/my-thing.ts
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: '...',
  argsExample: { foo: 'bar' },
};

export async function runInSession(page: Page, args: unknown, run: Run): Promise<unknown> {
  // 操作 page；产物用 run.writeArtifact / run.saveDownload 落地
  await page.goto('https://example.com');
  await run.writeArtifact('result.json', JSON.stringify({ title: await page.title() }));
  return { title: await page.title() };
}
```

`Run` 接口：

```ts
interface Run {
  runId: string;
  dir: string;            // <DATA_DIR>/runs/<runId>/ 脚本私有，不走 HTTP
  downloadsDir: string;   // <DATA_DIR>/runs/<runId>/downloads/ 走 HTTP /runs/:id/files
  saveDownload(d: Download, name?: string): Promise<DownloadedFile>;
  writeArtifact(name: string, data: Buffer | string): Promise<string>;
  listDownloads(): Promise<DownloadedFile[]>;
}
```

通过 `PUT /scripts/my-thing` 写进去，之后 `POST /sessions/:sid/scripts/my-thing` 调用即可。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx，单元 + 集成测试（含 MCP server，stub fetch），不需要 Chrome
npm run e2e         # 真 Chrome 端到端，需要本机装 Chrome；CI 在 ubuntu + xvfb 下跑
```

`npm test` 覆盖 `src/runs/*` 的纯逻辑单元、`src/sessions/*` 的会话 helper（ref/锁/trace）、`src/server/*` 的全部 HTTP 路由集成（auth 矩阵 / scripts CRUD / files CRUD / actions 契约 / 错误形状），以及 `src/mcp/*`（经 in-memory client 驱动真实 MCP server、stub fetch 当 fake brix）。全程不起 Chrome，快且稳。

`npm run e2e` 走完整链路：spawn 真 `tsx scripts/serve.ts` 子进程 → 拉真 Chrome → 在本机 fixture 页上跑 snapshot 和触发下载的脚本 → 验证 `/sessions` `/runs/:id/files` 全链路。GitHub Actions（`.github/workflows/e2e.yml`）在每次 push/PR 到 main/master 时跑一遍。

## 项目结构

```
brix/
├── scripts/                  CLI 入口 + 内置脚本
│   ├── serve.ts              HTTP 服务入口
│   ├── mcp.ts                MCP server 入口（stdio）
│   ├── gemini-draw.ts        内置脚本（CLI 客户端）
│   ├── chatgpt-draw.ts
│   ├── google-lens.ts
│   ├── snapshot.ts
│   └── login.ts
├── src/
│   ├── config.ts             环境变量
│   ├── browser/              真实 Chrome 拉起 + CDP 接管
│   ├── runs/                 Run 抽象（id/mime/cli/run）
│   ├── scripts/              脚本 CRUD（registry）+ BrixScriptApi
│   ├── sessions/             会话注册表（内存 Map）+ ref/run/锁/trace
│   ├── server/               HTTP 服务（http + auth + util + routes/，含 actions）
│   ├── mcp/                  MCP server（server + client）
│   └── utils/                logger
└── docs/
    └── design.md             原始设计文档
```

## 许可证

[Apache License 2.0](LICENSE) © 2026 4o4E and brix contributors。

## 免责声明

本项目是浏览器自动化基础设施，仅供用于你**有权访问/操作**的站点与账号（如你自己的账号、获授权的测试目标）。使用者须遵守目标站点的服务条款与所在地法律。项目**不做**验证码绕过或对抗式反爬（见 [docs/design.md](docs/design.md) 非目标）。因滥用造成的后果由使用者自负。

> 安全提示：持有 `BRIX_TOKEN` 即可在你的浏览器 profile 上任意操作（含已登录态、`eval` 任意页面 JS、读写下载文件）。请将 token 视同该 profile 的完全访问权，仅在可信网络/可信调用方之间使用。
