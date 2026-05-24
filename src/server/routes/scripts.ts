// scripts 路由：CRUD scripts/*.ts （不包含执行）
//
// 暴露：
//   GET    /scripts
//   GET    /scripts/:name
//   PUT    /scripts/:name      { source }
//   DELETE /scripts/:name

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BadScriptError,
  NotFoundError,
  deleteScript,
  listScripts,
  readScript,
  writeScript,
} from '../../scripts/registry.js';
import { createLogger } from '../../utils/logger.js';
import { readJson, sendError, sendJson, sendNoContent } from '../util.js';

const log = createLogger('routes-scripts');

const RE_LIST = /^\/scripts\/?$/;
const RE_ITEM = /^\/scripts\/([^/]+)\/?$/;

export async function handleScripts(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (RE_LIST.test(pathname)) {
    if (method !== 'GET') { sendError(res, 405, 'method_not_allowed'); return true; }
    try {
      sendJson(res, 200, await listScripts());
    } catch (e) {
      log.error(`list failed: ${e instanceof Error ? e.message : e}`);
      sendError(res, 500, 'internal');
    }
    return true;
  }

  const m = RE_ITEM.exec(pathname);
  if (!m) return false;
  const name = decodeURIComponent(m[1]);

  if (method === 'GET') {
    try {
      sendJson(res, 200, await readScript(name));
    } catch (e) {
      if (e instanceof NotFoundError) sendError(res, 404, 'not_found');
      else { log.error(`read failed: ${e instanceof Error ? e.message : e}`); sendError(res, 500, 'internal'); }
    }
    return true;
  }

  if (method === 'PUT') {
    let body: unknown;
    try { body = await readJson(req); } catch (e) {
      sendError(res, 400, 'bad_request', e instanceof Error ? e.message : String(e));
      return true;
    }
    if (!body || typeof body !== 'object' || typeof (body as { source?: unknown }).source !== 'string') {
      sendError(res, 400, 'bad_request', 'source (string) is required');
      return true;
    }
    const source = (body as { source: string }).source;
    try {
      const meta = await writeScript(name, source);
      sendJson(res, 200, { meta });
    } catch (e) {
      if (e instanceof BadScriptError) sendError(res, 400, 'bad_script', e.details);
      else { log.error(`write failed: ${e instanceof Error ? e.message : e}`); sendError(res, 500, 'internal'); }
    }
    return true;
  }

  if (method === 'DELETE') {
    try {
      await deleteScript(name);
      sendNoContent(res);
    } catch (e) {
      if (e instanceof NotFoundError) sendError(res, 404, 'not_found');
      else { log.error(`delete failed: ${e instanceof Error ? e.message : e}`); sendError(res, 500, 'internal'); }
    }
    return true;
  }

  sendError(res, 405, 'method_not_allowed');
  return true;
}
