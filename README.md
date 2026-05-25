# brix

浏览器脚本执行平台：拉起一个真实 Chrome（叠加 [rebrowser-patches][rb]），通过 CDP 接管，对外暴露 HTTP API 让远端调用方在 tab 里跑预置脚本，取回结构化结果和落地的下载文件。

部署目标 Windows。设计背景参见 [docs/design.md](docs/design.md)。

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
npm run login                          # 打开 accounts.google.com 等用户登录
npm run lens -- ./image.png            # Google Lens 识图
npm run gemini-draw -- "画一只猫"      # Gemini 生图
npm run snapshot -- https://example.com [--interactive-only] [--max-depth=N]
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
| `BRIX_HTTP_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `BRIX_HTTP_PORT` | `9233` | HTTP 监听端口 |
| `BRIX_USER_DATA_DIR` | `./user-data-dir/default` | Chrome profile 根目录（含 cookie） |
| `BRIX_DATA_DIR` | `./data` | run 产物根目录（含 downloads） |
| `BRIX_CHROME_PATH` | 自动探测 | Chrome 可执行文件路径 |
| `BRIX_CDP_PORT` | `9222` | Chrome remote debugging port |
| `BRIX_CDP_URL` | `http://127.0.0.1:<port>` | 已运行的 CDP 端点（附加模式） |
| `BRIX_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
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
| DELETE | `/sessions/:sid` | — | `204` |

脚本 throw 时返回 `500 {error:"script_failed", details, runId, downloads}` —— 调用方可拿 `runId` 去 files 端点取已经落地的部分产物。

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

## 内置脚本

| 脚本 | args | 输出要点 |
|---|---|---|
| [gemini-draw](scripts/gemini-draw.ts) | `{prompt: string}` | 图片落 `downloads/image-N.<ext>`；文字回复在 `output.text` |
| [google-lens](scripts/google-lens.ts) | `{image: string}`（base64/dataURL）或 `{imagePath: string}` | `output.pages: [{title, url, sourceDomain, thumbnailUrl, ...}]` |
| [snapshot](scripts/snapshot.ts) | `{url?, scope?, interactiveOnly?, maxDepth?}` | `output.snapshot: string`（带 `[ref=eN]`）+ refMap 落 `refs.json` |
| [login](scripts/login.ts) | — | 打开 accounts.google.com 等用户登录，最多 10 分钟。cookie 留在 profile |

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
npm test            # node:test via tsx，153 个单元 + 集成测试，不需要 Chrome
npm run e2e         # 真 Chrome 端到端，需要本机装 Chrome；CI 在 ubuntu + xvfb 下跑
```

`npm test` 覆盖 `src/runs/*` 的纯逻辑单元 + `src/server/*` 的全部 HTTP 路由集成（auth 矩阵 / scripts CRUD / files CRUD / 错误形状），不起 Chrome 因此快且稳。

`npm run e2e` 走完整链路：spawn 真 `tsx scripts/serve.ts` 子进程 → 拉真 Chrome → 在本机 fixture 页上跑 snapshot 和触发下载的脚本 → 验证 `/sessions` `/runs/:id/files` 全链路。GitHub Actions（`.github/workflows/e2e.yml`）在每次 push/PR 到 main/master 时跑一遍。

## 项目结构

```
brix/
├── scripts/                  CLI 入口 + 内置脚本
│   ├── serve.ts              HTTP 服务入口
│   ├── gemini-draw.ts        内置脚本
│   ├── google-lens.ts
│   ├── snapshot.ts
│   └── login.ts
├── src/
│   ├── config.ts             环境变量
│   ├── browser/              真实 Chrome 拉起 + CDP 接管
│   ├── runs/                 Run 抽象（id/mime/cli/run）
│   ├── scripts/              脚本 CRUD（registry）
│   ├── sessions/             会话注册表（内存 Map）
│   ├── server/               HTTP 服务（http + auth + util + routes/）
│   └── utils/                logger
└── docs/
    └── design.md             原始设计文档
```
