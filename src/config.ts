// brix 运行时配置：纯环境变量 + 默认值
// 全部 key 以 BRIX_ 开头，不与系统其他环境变量冲突
//
// dotenv/config 在这里副作用 import 一次：所有 script / server 入口都先经
// config.ts 才读环境变量，从这一处统一加载 .env，其它入口零样板。
// dotenv 默认不覆盖已存在的 process.env，所以测试里手动 set 的 BRIX_*
// 不会被 .env 反向覆盖。

import 'dotenv/config';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EnvConfig {
  /** 用户数据目录（profile） */
  USER_DATA_DIR: string;
  /** Chrome remote debugging 端口；0 = 自动挑空闲端口（从 DevToolsActivePort 读真实值） */
  CDP_PORT: number;
  /** Chrome 可执行文件路径，找不到则启动时报错 */
  CHROME_PATH: string | null;
  /** 数据 / 日志 / run 产物根目录 */
  DATA_DIR: string;
  /** 用户脚本根目录（CRUD scripts/*.ts） */
  SCRIPTS_DIR: string;
  /** Chrome 默认下载目录（通过修补 Default/Preferences 的 download.default_directory 实现） */
  DOWNLOAD_DIR: string;
  /** Chrome 磁盘缓存目录（--disk-cache-dir） */
  CACHE_DIR: string;
  /** Chrome crash dumps 目录（--crash-dumps-dir） */
  CRASH_DIR: string;
  /** 控制台日志级别 */
  LOG_LEVEL: LogLevel;
  /** 空闲多少分钟后自动断开 Playwright 连接（不关 Chrome 进程），0 = 不超时 */
  IDLE_TIMEOUT_MIN: number;
  /** snapshot 文本最大字符数 */
  SNAPSHOT_MAX_CHARS: number;
  /** HTTP 服务鉴权 token；server 启动前必须非空，否则拒启 */
  HTTP_TOKEN: string | null;
  /** HTTP 监听 host，默认 0.0.0.0（LAN 可达） */
  HTTP_HOST: string;
  /** HTTP 监听端口，默认 9233 */
  HTTP_PORT: number;
  /** Chrome 启动后是否最小化窗口（通过 CDP Browser.setWindowBounds），默认 true */
  START_MINIMIZED: boolean;
}

const CHROME_CANDIDATES = [
  process.env.BRIX_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean) as string[];

function findChromeExecutable(): string | null {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return def;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return def;
}

function levelEnv(name: string, def: LogLevel): LogLevel {
  const raw = process.env[name]?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return def;
}

let cached: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cached) return cached;

  const userDataDir = process.env.BRIX_USER_DATA_DIR
    ? resolve(process.env.BRIX_USER_DATA_DIR)
    : resolve('user-data-dir/default');
  const dataDir = process.env.BRIX_DATA_DIR ? resolve(process.env.BRIX_DATA_DIR) : resolve('data');
  const scriptsDir = process.env.BRIX_SCRIPTS_DIR
    ? resolve(process.env.BRIX_SCRIPTS_DIR)
    : resolve('scripts');
  const downloadDir = process.env.BRIX_DOWNLOAD_DIR
    ? resolve(process.env.BRIX_DOWNLOAD_DIR)
    : join(dataDir, 'downloads');
  const cacheDir = process.env.BRIX_CACHE_DIR
    ? resolve(process.env.BRIX_CACHE_DIR)
    : join(dataDir, 'chrome-cache');
  const crashDir = process.env.BRIX_CRASH_DIR
    ? resolve(process.env.BRIX_CRASH_DIR)
    : join(dataDir, 'chrome-crashes');
  // 默认 0 = 让 chrome 自动挑空闲端口（spawn 后从 DevToolsActivePort 读出来）。
  // 用固定端口在 Windows 上经常撞 Hyper-V/WSL2 的 excluded port range（如 9178-9277
  // 包含 9222），chrome bind 失败、CDP 永远不上。固定端口仅在外部需要稳定 attach 时配。
  const cdpPort = intEnv('BRIX_CDP_PORT', 0);

  cached = {
    USER_DATA_DIR: userDataDir,
    CDP_PORT: cdpPort,
    CHROME_PATH: findChromeExecutable(),
    DATA_DIR: dataDir,
    SCRIPTS_DIR: scriptsDir,
    DOWNLOAD_DIR: downloadDir,
    CACHE_DIR: cacheDir,
    CRASH_DIR: crashDir,
    LOG_LEVEL: levelEnv('BRIX_LOG_LEVEL', 'info'),
    IDLE_TIMEOUT_MIN: intEnv('BRIX_IDLE_TIMEOUT_MIN', 30),
    SNAPSHOT_MAX_CHARS: intEnv('BRIX_SNAPSHOT_MAX_CHARS', 16000),
    HTTP_TOKEN: process.env.BRIX_TOKEN?.trim() || null,
    HTTP_HOST: process.env.BRIX_HTTP_HOST?.trim() || '0.0.0.0',
    HTTP_PORT: intEnv('BRIX_HTTP_PORT', 9233),
    START_MINIMIZED: boolEnv('BRIX_CHROME_START_MINIMIZED', true),
  };
  return cached;
}
