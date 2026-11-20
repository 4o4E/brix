import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ExperienceError, ExperienceStore, feedbackSchema, publishSchema, querySchema } from '../../experiences/store.js';
import { readJson, sendError, sendJson } from '../util.js';

const ITEM = /^\/experiences\/([a-f0-9-]{36})(\/feedback)?$/;

export function experienceRoutes(dataDir: string) {
  const store = new ExperienceStore(join(dataDir, 'experiences.json'));
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    const item = ITEM.exec(path);
    if (!item && path !== '/experiences' && path !== '/experiences/search') return false;
    const read = item && item[2] === undefined;
    if (req.method !== (read ? 'GET' : 'POST')) { sendError(res, 405, 'method_not_allowed'); return true; }
    let body: unknown;
    if (!read) {
      try { body = await readJson(req); }
      catch { sendError(res, 400, 'bad_request', '需要有效的经验 JSON'); return true; }
    }
    try {
      if (read) {
        sendJson(res, 200, await store.show(item![1]));
      } else if (path === '/experiences/search') {
        const input = querySchema.parse(body);
        sendJson(res, 200, { experiences: await store.search(input) });
      } else if (path === '/experiences') {
        const input = publishSchema.parse(body);
        sendJson(res, 201, await store.publish(input));
      } else {
        const input = feedbackSchema.parse(body);
        sendJson(res, 200, await store.report(item![1], input));
      }
    } catch (error) {
      if (error instanceof ExperienceError) sendJson(res, error.status, { error: error.code, currentVersion: error.currentVersion });
      else if (error instanceof Error && error.name === 'ZodError') sendError(res, 400, 'invalid_experience', '字段缺失、格式不符或含不允许的内容');
      else throw error;
    }
    return true;
  };
}
