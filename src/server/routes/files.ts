// files 路由：取/删 一次 run 产生的下载文件
//
// 暴露：
//   GET    /runs/:id/files
//   GET    /runs/:id/files/:name
//   DELETE /runs/:id/files/:name
//
// 错误统一：NotFoundError → 404；其余 throw → 500。

import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deleteDownload, listDownloads, NotFoundError, readDownload } from '../../runs/run.js';
import { createLogger } from '../../utils/logger.js';
import { sendError, sendJson, sendNoContent } from '../util.js';

const log = createLogger('routes-files');

const RE_LIST = /^\/runs\/([^/]+)\/files\/?$/;
const RE_FILE = /^\/runs\/([^/]+)\/files\/([^/]+)\/?$/;

export async function handleFiles(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method ?? 'GET';

  const listMatch = RE_LIST.exec(pathname);
  if (listMatch) {
    const [, runId] = listMatch;
    if (method !== 'GET') { sendError(res, 405, 'method_not_allowed'); return true; }
    try {
      const items = await listDownloads(decodeURIComponent(runId));
      sendJson(res, 200, items);
    } catch (e) {
      if (e instanceof NotFoundError) sendError(res, 404, 'not_found');
      else { log.error(`list failed: ${e instanceof Error ? e.message : e}`); sendError(res, 500, 'internal'); }
    }
    return true;
  }

  const fileMatch = RE_FILE.exec(pathname);
  if (fileMatch) {
    const [, runId, name] = fileMatch;
    const decRunId = decodeURIComponent(runId);
    const decName = decodeURIComponent(name);

    if (method === 'GET') {
      try {
        const { path, bytes, mimeType } = await readDownload(decRunId, decName);
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Length': bytes,
          'Content-Disposition': `attachment; filename="${decName.replace(/"/g, '_')}"`,
        });
        const stream = createReadStream(path);
        stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
        stream.pipe(res);
      } catch (e) {
        if (e instanceof NotFoundError) sendError(res, 404, 'not_found');
        else { log.error(`read failed: ${e instanceof Error ? e.message : e}`); sendError(res, 500, 'internal'); }
      }
      return true;
    }

    if (method === 'DELETE') {
      try {
        await deleteDownload(decRunId, decName);
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

  return false;
}
