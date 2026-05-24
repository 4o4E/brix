// brix 浏览器会话注册表：内存 Map<sessionId, BrixSession>
//
// 会话 = 框架持有一个 tab 的句柄；create 时打 newTab，close 时 page.close + 删表项。
// 会话不写磁盘，进程重启即丢（符合"会话 = 浏览器内"语义）。

import type { Page } from 'rebrowser-playwright';
import { newTab } from '../browser/session.js';
import { nextId } from '../runs/id.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sessions');

export interface BrixSession {
  sessionId: string;
  page: Page;
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, BrixSession>();

export async function createBrixSession(url?: string): Promise<BrixSession> {
  const page = await newTab(url);
  const sessionId = nextId();
  const now = Date.now();
  const s: BrixSession = { sessionId, page, createdAt: now, lastActiveAt: now };
  sessions.set(sessionId, s);
  log.info(`created session ${sessionId} url=${url ?? '(blank)'}`);
  page.on('close', () => {
    if (sessions.delete(sessionId)) log.info(`session ${sessionId} auto-removed (page closed)`);
  });
  return s;
}

export function getBrixSession(sessionId: string): BrixSession | null {
  return sessions.get(sessionId) ?? null;
}

export function touchBrixSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) s.lastActiveAt = Date.now();
}

export function listBrixSessions(): Array<{ sessionId: string; url: string; createdAt: number; lastActiveAt: number }> {
  return Array.from(sessions.values()).map((s) => ({
    sessionId: s.sessionId,
    url: safeUrl(s.page),
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  }));
}

function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ''; }
}

export async function closeBrixSession(sessionId: string): Promise<boolean> {
  const s = sessions.get(sessionId);
  if (!s) return false;
  sessions.delete(sessionId);
  await s.page.close().catch(() => { /* ignore */ });
  log.info(`closed session ${sessionId}`);
  return true;
}
