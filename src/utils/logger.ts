// 分渠道 logger：控制台按 LOG_LEVEL 过滤，文件全量按日期滚动
// 移植自 my-claw src/utils/logger.ts，去掉显式 initLogger，懒初始化

import fs from 'node:fs';
import path from 'node:path';
import { getEnv, type LogLevel } from '../config.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABELS: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };
const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let logDir: string | null = null;
const fileStreams = new Map<string, fs.WriteStream>();

function ensureLogDir(): string {
  if (logDir) return logDir;
  logDir = path.join(getEnv().DATA_DIR, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function getDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTimeStr(): string {
  return new Date().toISOString().slice(11, 23);
}

function getFileStream(channel: string): fs.WriteStream {
  const dir = ensureLogDir();
  const dateStr = getDateStr();
  const key = `${channel}:${dateStr}`;
  const existing = fileStreams.get(key);
  if (existing && !existing.destroyed) return existing;

  // 清理同 channel 的旧日期流
  for (const [k, s] of fileStreams) {
    if (k.startsWith(`${channel}:`)) {
      s.end();
      fileStreams.delete(k);
    }
  }
  const stream = fs.createWriteStream(path.join(dir, `${channel}-${dateStr}.log`), { flags: 'a' });
  fileStreams.set(key, stream);
  return stream;
}

function writeLog(channel: string, level: LogLevel, msg: string): void {
  const time = getTimeStr();
  const label = LEVEL_LABELS[level];
  const fileLine = `${time} [${label}] [${channel}] ${msg}\n`;

  try {
    getFileStream(channel).write(fileLine);
    if (channel !== 'all') getFileStream('all').write(fileLine);
  } catch {
    // 文件写失败不应该影响业务
  }

  const consoleLevel = getEnv().LOG_LEVEL;
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[consoleLevel]) {
    const color = LEVEL_COLORS[level];
    const line = `${color}${time} [${label}]${RESET} [${channel}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

function format(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;
  const extra = args.map((a) => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  return `${msg} ${extra}`;
}

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export function createLogger(channel: string): Logger {
  return {
    debug: (msg, ...args) => writeLog(channel, 'debug', format(msg, args)),
    info: (msg, ...args) => writeLog(channel, 'info', format(msg, args)),
    warn: (msg, ...args) => writeLog(channel, 'warn', format(msg, args)),
    error: (msg, ...args) => writeLog(channel, 'error', format(msg, args)),
  };
}

export function closeLogger(): void {
  for (const stream of fileStreams.values()) stream.end();
  fileStreams.clear();
}
