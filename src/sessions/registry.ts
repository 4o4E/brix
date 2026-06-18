// brix 浏览器会话注册表：内存 Map<sessionId, BrixSession>
//
// 会话 = 框架持有一个 tab 的句柄；create 时打 newTab，close 时 page.close + 删表项。
// 会话不写磁盘，进程重启即丢（符合"会话 = 浏览器内"语义）。

import type { Page } from 'patchright';
import { newTab } from '../browser/session.js';
import { nextId } from '../runs/id.js';
import { createLogger } from '../utils/logger.js';
import { createBrowserRefContext, type BrowserRefContext } from '../browser/snapshot.js';
import { createRun, type Run } from '../runs/run.js';

const log = createLogger('sessions');

/** 交互动作轨迹的一条记录。供 LLM 回看自己走过的序列、固化成脚本（brix 不替你生成代码）。 */
export interface ActionTraceEntry {
  ts: number;
  op: string;
  /** 已剥离文件字节/base64 的参数摘要 */
  params: Record<string, unknown>;
  ok: boolean;
  resultSummary?: string;
}

const TRACE_CAP = 200;

export interface BrixSession {
  sessionId: string;
  page: Page;
  createdAt: number;
  lastActiveAt: number;
  /** 本 session 的 ref 表（惰性创建）。交互式单步执行靠它让 refs 跨调用存活。 */
  refContext?: BrowserRefContext;
  /** 探索期产物（下载/截图）归属的唯一 run（惰性创建）。 */
  interactiveRun?: Run;
  /** 单 session 串行锁（promise 链尾）。 */
  actionLock?: Promise<unknown>;
  /** 动作轨迹（封顶 TRACE_CAP 条，超出丢最旧）。 */
  trace?: ActionTraceEntry[];
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

/** 惰性建并返回本 session 稳定的 ref 上下文（多次调用返回同一实例）。 */
export function getSessionRefContext(s: BrixSession): BrowserRefContext {
  if (!s.refContext) s.refContext = createBrowserRefContext();
  return s.refContext;
}

/**
 * 惰性建并返回本 session 唯一的交互 run。一个 session 一个 run：所有交互产物堆在同一
 * runId 下，调用方用现有 GET /runs/:id/files 取。debug 只在首次创建时生效。
 */
export async function getInteractiveRun(s: BrixSession, debug?: boolean): Promise<Run> {
  if (!s.interactiveRun) s.interactiveRun = await createRun({ debug });
  return s.interactiveRun;
}

/**
 * 单 session 串行执行：把 fn 接到 session 的 promise 链尾，杜绝并发动作在同一 tab 上互相
 * 踩踏。链尾吞掉前序失败（避免毒化），但调用方仍拿到本次的真实结果/异常。
 * 不编码任何人工接管策略 —— 人何时介入由调用方编排。
 */
export function withSessionLock<T>(s: BrixSession, fn: () => Promise<T>): Promise<T> {
  const prev = s.actionLock ?? Promise.resolve();
  const next = prev.catch(() => { /* 前序失败不阻断后续 */ }).then(fn);
  s.actionLock = next.catch(() => { /* 存一个永不 reject 的尾 */ });
  return next;
}

/** 往 session 轨迹追加一条，超出封顶丢最旧。 */
export function appendTrace(s: BrixSession, entry: ActionTraceEntry): void {
  if (!s.trace) s.trace = [];
  s.trace.push(entry);
  if (s.trace.length > TRACE_CAP) s.trace.splice(0, s.trace.length - TRACE_CAP);
}
