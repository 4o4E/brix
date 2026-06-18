# brix

[简体中文](README.md) | English

Browser script execution platform: it launches a real Chrome (with [rebrowser-patches][rb]), takes it over via CDP, and exposes an HTTP API so remote callers can run preset scripts in a tab and get back structured results and saved download files.

Beyond running whole scripts, brix also offers **interactive single-step primitives** (`/sessions/:sid/actions`: navigate / snapshot / click / fill …, where refs survive across calls) and an **MCP server** that exposes browser capabilities to LLMs uniformly — forming an "explore (step-by-step) → crystallize (write a script) → produce (call the script)" pipeline.

Deployment target is Windows. Licensed under [Apache-2.0](LICENSE). For design background see [docs/design.md](docs/design.md).

> This project runs from source (`tsx`); it is not published to npm.

[rb]: https://github.com/rebrowser/rebrowser-patches

## Prerequisites

- Windows 10/11
- Node.js 22+
- A local Chrome install (default path `C:\Program Files\Google\Chrome\Application\chrome.exe`, or override via `BRIX_CHROME_PATH`)

## Install

```bash
npm install
```

It does not download Chromium — brix uses your real local Chrome.

## Start the HTTP service

```bash
BRIX_TOKEN=<your-secret> npm run serve
# brix http on http://0.0.0.0:9233
```

- `BRIX_TOKEN` is required, otherwise startup fails.
- `/health` is public; all other endpoints require `Authorization: Bearer <token>` or `X-Brix-Token: <token>`.
- The first request launches the Chrome process (CDP `--remote-debugging-port=9222`), kept resident and reused.

## CLI

Every script can be invoked over HTTP or debugged standalone via the CLI:

```bash
npm run login                          # trigger the login script via brix HTTP API (automated)
npm run lens -- ./image.png            # Google Lens reverse image search
npm run gemini-draw -- "draw a cat"    # Gemini image generation
npm run chatgpt-draw -- "draw a cat"   # ChatGPT image generation
npm run snapshot -- https://example.com [--interactive-only] [--max-depth=N]
npm run zhihu -- https://www.zhihu.com/question/19550225  # Zhihu scrape (body + images + comments)
npm run zhihu -- https://zhuanlan.zhihu.com/p/96956163 --max-comments=50 --download-images
npm run zhihu-login                    # open Zhihu login page, wait for you to log in (cookie stays in profile)
```

If Google flags the automated Chrome as an "insecure browser", stop `serve` first, use `open-profile` to launch a **clean Chrome (no CDP / no automation flags)** on the same USER_DATA_DIR, log in manually, then close the window — the cookie stays in the profile and the next `npm run serve` inherits the login state via CDP attach:

```bash
npm run open-profile -- https://accounts.google.com
# log in in the popped-up Chrome → close the window → start serve
```

The CLI's last line prints one JSON line: `{runId, output, downloads, error}`. Files in `downloads` land in `<DATA_DIR>/runs/<runId>/downloads/`.

You can also force JSON args:

```bash
npm run gemini-draw -- --json-args '{"prompt":"draw a cat"}'
```

## Environment variables

| Name | Default | Meaning |
|---|---|---|
| `BRIX_TOKEN` | — | HTTP auth token. Empty → server refuses to start |
| `BRIX_HTTP_HOST` | `0.0.0.0` | HTTP listen address (where the server binds) |
| `BRIX_HTTP_PORT` | `9233` | HTTP listen port |
| `BRIX_API_URL` | derived from host/port | brix URL the CLI/MCP client connects to (where to connect), e.g. `http://192.168.66.120:9400`. Decoupled from server binding; can point to a remote brix |
| `BRIX_USER_DATA_DIR` | `./user-data-dir/default` | Chrome profile root (holds cookies) |
| `BRIX_DATA_DIR` | `./data` | run-artifact root (holds downloads) |
| `BRIX_CHROME_PATH` | auto-detected | Chrome executable path |
| `BRIX_CDP_PORT` | `9222` | Chrome remote debugging port |
| `BRIX_CDP_URL` | `http://127.0.0.1:<port>` | already-running CDP endpoint (attach mode) |
| `BRIX_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `BRIX_DEBUG_ARTIFACTS` | `false` (implicit `true` when `LOG_LEVEL=debug`) | whether to persist debug artifacts (`stage-*.png/html`, result-page `page.png/html`); when off only `result.json` + `downloads/` remain. Per-request override via body `debug` |
| `BRIX_IDLE_TIMEOUT_MIN` | `30` | minutes idle before disconnecting Playwright (Chrome stays up), 0 = no timeout |
| `BRIX_DOWNLOAD_DIR` / `BRIX_CACHE_DIR` / `BRIX_CRASH_DIR` | `<DATA_DIR>/...` | various Chrome-internal dirs |
| `BRIX_SNAPSHOT_MAX_CHARS` | `16000` | max chars of snapshot text |

## HTTP API

Unified errors: `400 bad_request` / `403 forbidden` / `404 not_found` / `500 internal`, body shaped like `{"error":"...","details":"..."}`.

### Public endpoints

| Method | Path | Response |
|---|---|---|
| GET | `/health` | `200 {ok:true}` |

### Sessions (execution entry)

All script/primitive execution happens inside a session's tab.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/sessions` | `{url?:string}` | `201 {sessionId, url}` — open a new tab, optional goto |
| GET | `/sessions` | — | `200 [{sessionId, url, createdAt, lastActiveAt}, ...]` |
| POST | `/sessions/:sid/scripts/:name` | `{args?:any}` | `200 {runId, output, downloads}` — synchronous |
| POST | `/sessions/:sid/actions` | `{op, ...params, returnSnapshot?, debug?}` | `200 {runId, op, result?, snapshot?, downloads?}` — single primitive |
| GET | `/sessions/:sid/trace` | — | `200 {trace:[{ts, op, params, ok, resultSummary?}, ...]}` — action trace (last 200) |
| DELETE | `/sessions/:sid` | — | `204` |

When a script throws it returns `500 {error:"script_failed", details, runId, downloads}` — the caller can use `runId` against the files endpoint to fetch partial artifacts already saved. Action (`/actions`) failures similarly return `500 {error:"action_failed", details, runId}`; bad params / unknown op return `400 bad_request`.

#### Interactive single-step primitives (`/sessions/:sid/actions`)

The other execution mode besides whole scripts: send one browser primitive at a time, observe the result, then decide the next step — used both by LLMs exploring a page and by humans stepping in manually (headful shared tab). The `ref`s produced by `snapshot` (`e1/e2`…) **survive per session** across multiple calls until the next `snapshot` refreshes them. A session executes serially.

`op` values (`target` = ref or CSS selector):

| op | key params | notes |
|---|---|---|
| `navigate` | `url`, `waitUntil?` | navigate |
| `snapshot` | `scope?`, `interactiveOnly?`, `maxDepth?` | structured snapshot with `[ref=eN]` |
| `click` | `target`, `expectDownload?`, `saveAs?`, `optional?` | click; with `expectDownload` capture the download into this session's run |
| `fill` / `type` | `target`, `value` | overwrite-fill / type char-by-char |
| `press` | `key` | press a key |
| `select` / `hover` | `target`(, `value`) | select option / hover |
| `scroll` | `direction`, `amount?` | scroll |
| `upload` | `target`, `files` | upload files (base64/dataUrl, host paths rejected) |
| `eval` | `source` | run JS in the page (string) |
| `waitForSelector` / `waitForLoad` / `waitForUrl` | … | wait for a condition |
| `text` / `attr` / `count` / `content` / `url` / `title` | `selector?` | read page info |
| `screenshot` | `fullPage?` | screenshot (returns base64) |

Passing `returnSnapshot:true` on a mutating op also returns the refreshed snapshot (with new refs). `/trace` returns the sequence of successful actions you ran on that session, to review and **crystallize into a script** — brix only gives the trace; the script is written by you/the LLM per the convention below, never auto-generated.

### Scripts CRUD (no execution)

`.ts`/`.js` files under the `scripts/` directory. Built-in scripts (gemini-draw / google-lens / snapshot / login) go through the same path; with the token you can edit/delete them; PUT them back to restore.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/scripts` | — | `200 [{name, description?, argsExample?, bytes, createdAt, updatedAt}, ...]` |
| GET | `/scripts/:name` | — | `200 {meta, source}` |
| PUT | `/scripts/:name` | `{source:string}` | `200 {meta}` — syntax-checked with `tsc --noEmit` before writing, failure → `400 bad_script` |
| DELETE | `/scripts/:name` | — | `204` |

`name` rule: `^[a-z0-9][a-z0-9-]{0,63}$`. Source size limit 1 MB.

### Download files

Each run's download files land in `<DATA_DIR>/runs/<runId>/downloads/` and are exposed by this set of endpoints. A run's other artifacts (screenshots, HTML, `result.json`, stage-*) are under `runs/<runId>/` but **not exposed over HTTP**.

| Method | Path | Response |
|---|---|---|
| GET | `/runs/:id/files` | `200 [{name, bytes, mimeType, downloadedAt}, ...]` |
| GET | `/runs/:id/files/:name` | `200 <bytes>` + `Content-Type` / `Content-Length` / `Content-Disposition: attachment` |
| DELETE | `/runs/:id/files/:name` | `204` — hard delete |

Filename validation: `^[A-Za-z0-9._-]{1,255}$`, not starting with `.`, no `..`. Path-traversal attempts (`/`, `\`, `..`) → 404.

### Example

```bash
TOKEN=test123 BASE=http://127.0.0.1:9233

# 1. open a session (directly open gemini)
SID=$(curl -sX POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://gemini.google.com/app"}' $BASE/sessions | jq -r .sessionId)

# 2. run gemini-draw
RES=$(curl -sX POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"args":{"prompt":"draw a cat"}}' $BASE/sessions/$SID/scripts/gemini-draw)
RID=$(echo $RES | jq -r .runId)

# 3. list / fetch / delete download files
curl -H "Authorization: Bearer $TOKEN" $BASE/runs/$RID/files
curl -H "Authorization: Bearer $TOKEN" $BASE/runs/$RID/files/image-0.png -o cat.png
curl -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/runs/$RID/files/image-0.png -i

# 4. close the session
curl -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/sessions/$SID -i
```

## MCP server

Exposes the browser capabilities above to LLM clients (Claude Desktop / Claude Code, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io). The MCP server itself **does not launch Chrome** — it is just another HTTP caller of brix. So start brix first with `npm run serve`, then start the MCP server:

```bash
BRIX_TOKEN=<your-secret> npm run mcp
# brix-mcp running on stdio
```

stdio transport. It reuses brix's env: `BRIX_TOKEN` is required; `BRIX_API_URL` can point to a remote brix (otherwise derived from `BRIX_HTTP_HOST/PORT` locally).

Configure it in your MCP client (Claude Desktop's `mcpServers` as an example):

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

Exposed tools (26):

- **Sessions**: `session_open` / `session_list` / `session_close` / `session_trace`
- **Primitives**: `browser_navigate` / `browser_snapshot` / `browser_click` (with `expectDownload`) / `browser_fill` / `browser_type` / `browser_press` / `browser_select` / `browser_hover` / `browser_scroll` / `browser_upload` / `browser_eval` / `browser_wait` / `browser_read` / `browser_screenshot` (returns an image block)
- **Escape hatch**: `browser_action` (passes through any `op`)
- **Scripts**: `script_list` / `script_get` / `script_save` (crystallize) / `script_delete` / `script_run` (produce)
- **Artifacts**: `run_files_list` / `run_file_get` (images returned as image blocks)

Typical flow: `session_open` → repeatedly `browser_snapshot`/`browser_click`/… to explore → `session_trace` to review → `script_save` to crystallize into a `.js` → then `script_run` to call it directly.

## Built-in scripts

| Script | args | output highlights |
|---|---|---|
| [gemini-draw](scripts/gemini-draw.ts) | `{prompt: string, images?: [{filename?, mimeType?, dataUrl?/base64?}]}` | images land in `downloads/image-N.<ext>`; text reply in `output.text` |
| [chatgpt-draw](scripts/chatgpt-draw.ts) | `{prompt: string, images?: [{filename?, mimeType?, dataUrl?/base64?}]}` | images in `downloads/image-N.<ext>`; text reply in `output.text` |
| [google-lens](scripts/google-lens.ts) | `{image: string}` (base64/dataURL) or `{imagePath: string}` | `output.pages: [{title, url, sourceDomain, thumbnailUrl, ...}]`; `output.aiOverview: {text, sources, generated}` |
| [snapshot](scripts/snapshot.ts) | `{url?, scope?, interactiveOnly?, maxDepth?}` | `output.snapshot: string` (with `[ref=eN]`) + refMap saved to `refs.json` |
| [login](scripts/login.ts) | — | open accounts.google.com etc. for the user to log in, up to 10 min. cookie stays in profile |
| [zhihu](scripts/zhihu.ts) | `{url, maxAnswers?, comments?, maxComments?, maxReplies?, includeHtml?, downloadImages?}` | `output.items: [...]` + `title`/`questionDetail`/`loginWall`. Supports questions/answers/columns/pins; comments via comment_v5 API; images give original-resolution links, saved to `downloads/img-*` when `downloadImages` |
| [zhihu-login](scripts/zhihu-login.ts) | — | open Zhihu login page for the user to log in, up to 10 min. cookie stays in profile |

## Writing a custom script

Convention:

```ts
// scripts/my-thing.ts
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: '...',
  argsExample: { foo: 'bar' },
};

export async function runInSession(page: Page, args: unknown, run: Run): Promise<unknown> {
  // operate on page; persist artifacts via run.writeArtifact / run.saveDownload
  await page.goto('https://example.com');
  await run.writeArtifact('result.json', JSON.stringify({ title: await page.title() }));
  return { title: await page.title() };
}
```

The `Run` interface:

```ts
interface Run {
  runId: string;
  dir: string;            // <DATA_DIR>/runs/<runId>/ script-private, not over HTTP
  downloadsDir: string;   // <DATA_DIR>/runs/<runId>/downloads/ served via HTTP /runs/:id/files
  saveDownload(d: Download, name?: string): Promise<DownloadedFile>;
  writeArtifact(name: string, data: Buffer | string): Promise<string>;
  listDownloads(): Promise<DownloadedFile[]>;
}
```

Write it via `PUT /scripts/my-thing`, then call it via `POST /sessions/:sid/scripts/my-thing`.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx, unit + integration (incl. MCP server with stubbed fetch), no Chrome needed
npm run e2e         # real-Chrome end-to-end, needs a local Chrome; CI runs it under ubuntu + xvfb
```

`npm test` covers the pure-logic units of `src/runs/*`, the session helpers of `src/sessions/*` (ref/lock/trace), the full HTTP route integration of `src/server/*` (auth matrix / scripts CRUD / files CRUD / actions contract / error shapes), and `src/mcp/*` (the real MCP server driven through an in-memory client with stubbed fetch as a fake brix). All without Chrome, so it's fast and stable.

`npm run e2e` runs the full chain: spawn a real `tsx scripts/serve.ts` child → launch real Chrome → run snapshot/download/interactive-action flows against a local fixture page → verify `/sessions` `/actions` `/runs/:id/files`. It auto-closes the spawned Chrome on teardown. GitHub Actions (`.github/workflows/e2e.yml`) runs it on every push/PR to main/master.

## Project structure

```
brix/
├── scripts/                  CLI entries + built-in scripts
│   ├── serve.ts              HTTP service entry
│   ├── mcp.ts                MCP server entry (stdio)
│   ├── gemini-draw.ts        built-in script (CLI client)
│   ├── chatgpt-draw.ts
│   ├── google-lens.ts
│   ├── snapshot.ts
│   └── login.ts
├── src/
│   ├── config.ts             environment variables
│   ├── browser/              real Chrome launch + CDP takeover
│   ├── runs/                 Run abstraction (id/mime/cli/run)
│   ├── scripts/              script CRUD (registry) + BrixScriptApi
│   ├── sessions/             session registry (in-memory Map) + ref/run/lock/trace
│   ├── server/               HTTP service (http + auth + util + routes/, incl. actions)
│   ├── mcp/                  MCP server (server + client)
│   └── utils/                logger
└── docs/
    └── design.md             original design doc
```

## License

[Apache License 2.0](LICENSE) © 2026 4o4E and brix contributors.

## Disclaimer

This project is browser-automation infrastructure, intended only for sites and accounts you are **authorized to access/operate** (e.g. your own accounts, sanctioned test targets). Users must comply with the target sites' terms of service and applicable laws. The project does **not** do CAPTCHA bypass or adversarial anti-scraping (see the non-goals in [docs/design.md](docs/design.md)). You are responsible for any consequences of misuse.

> Security note: whoever holds `BRIX_TOKEN` can do anything on your browser profile (including logged-in state, arbitrary in-page `eval`, and reading/writing download files). Treat the token as full access to that profile, and use it only between trusted networks/callers.
