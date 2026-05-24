// sessions 路由：创建/列/关 浏览器会话；在会话里执行脚本（唯一的执行入口）
//
// 暴露：
//   POST   /sessions                          { url? }
//   GET    /sessions
//   POST   /sessions/:sid/scripts/:name       { args? }
//   DELETE /sessions/:sid

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Page } from 'rebrowser-playwright';
import { createBrixSession, closeBrixSession, getBrixSession, listBrixSessions, touchBrixSession } from '../../sessions/registry.js';
import { BadScriptError, NotFoundError, loadScriptModule } from '../../scripts/registry.js';
import { createRun } from '../../runs/run.js';
import { createLogger } from '../../utils/logger.js';
import { readJson, sendError, sendJson, sendNoContent } from '../util.js';

const log = createLogger('routes-sessions');

const RE_ROOT = /^\/sessions\/?$/;
const RE_ITEM = /^\/sessions\/([^/]+)\/?$/;
const RE_SCRIPT = /^\/sessions\/([^/]+)\/scripts\/([^/]+)\/?$/;

export async function handleSessions(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (RE_ROOT.test(pathname)) {
    if (method === 'GET') {
      sendJson(res, 200, listBrixSessions());
      return true;
    }
    if (method === 'POST') {
      let body: { url?: unknown } | null = null;
      try { body = await readJson<{ url?: unknown }>(req); } catch (e) {
        sendError(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
        return true;
      }
      const rawUrl = body?.url;
      const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : undefined;
      try {
        const s = await createBrixSession(url);
        res.statusCode = 201;
        sendJson(res, 201, { sessionId: s.sessionId, url: s.page.url() });
      } catch (e) {
        log.error(`create session failed: ${e instanceof Error ? e.message : e}`);
        sendError(res, 500, 'internal');
      }
      return true;
    }
    sendError(res, 405, 'method_not_allowed');
    return true;
  }

  const scriptMatch = RE_SCRIPT.exec(pathname);
  if (scriptMatch) {
    if (method !== 'POST') { sendError(res, 405, 'method_not_allowed'); return true; }
    const sid = decodeURIComponent(scriptMatch[1]);
    const name = decodeURIComponent(scriptMatch[2]);
    const session = getBrixSession(sid);
    if (!session) { sendError(res, 404, 'not_found', 'session'); return true; }

    let body: { args?: unknown } | null = null;
    try { body = await readJson<{ args?: unknown }>(req); } catch (e) {
      sendError(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
      return true;
    }
    const args = body?.args;

    let mod: { runInSession: (page: unknown, args: unknown, run: unknown) => Promise<unknown> };
    try {
      mod = await loadScriptModule(name);
    } catch (e) {
      if (e instanceof NotFoundError) { sendError(res, 404, 'not_found', 'script'); return true; }
      if (e instanceof BadScriptError) { sendError(res, 500, 'bad_script', e.message); return true; }
      log.error(`load script failed: ${e instanceof Error ? e.message : e}`);
      sendError(res, 500, 'internal');
      return true;
    }

    const run = await createRun();
    touchBrixSession(sid);
    log.info(`session ${sid} → script ${name} → run ${run.runId}`);

    try {
      const output = await mod.runInSession(session.page as Page, args, run);
      const downloads = await run.listDownloads();
      touchBrixSession(sid);
      sendJson(res, 200, { runId: run.runId, output, downloads });
    } catch (e) {
      const downloads = await run.listDownloads().catch(() => []);
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error(`runInSession threw runId=${run.runId}: ${errMsg}`);
      sendJson(res, 500, { error: 'script_failed', details: errMsg, runId: run.runId, downloads });
    }
    return true;
  }

  const itemMatch = RE_ITEM.exec(pathname);
  if (itemMatch) {
    const sid = decodeURIComponent(itemMatch[1]);
    if (method === 'DELETE') {
      const removed = await closeBrixSession(sid);
      if (removed) sendNoContent(res);
      else sendError(res, 404, 'not_found');
      return true;
    }
    sendError(res, 405, 'method_not_allowed');
    return true;
  }

  return false;
}
