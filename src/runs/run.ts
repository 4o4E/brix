// 一次脚本执行 = 一个 Run。Run 拥有：
//   dir/           脚本私有工作目录（截图、HTML、stage-*、result.json 都进这里）
//   dir/downloads/ HTTP 通过 /runs/:id/files 唯一暴露的目录
//
// 不维护 manifest 文件 —— 真相直接来自 filesystem readdir+stat。删一个文件 = unlink，无残留索引项。

import { mkdir, readdir, rm, stat, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Download, Page } from 'patchright';
import { getEnv } from '../config.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { createBrowserRefContext, takeSnapshot, type FormatOptions } from '../browser/snapshot.js';
import { nextId } from './id.js';
import { isValidName, isValidRunId, mimeOf, sanitizeName } from './mime.js';

const log = createLogger('run');

export interface DownloadedFile {
  name: string;
  bytes: number;
  mimeType: string;
  downloadedAt: number;
}

export interface SnapshotResult {
  snapshot: string;
  refCount: number;
  refs: Record<string, { role: string; name?: string; selector: string }>;
}

/**
 * 一次 run 的上下文对象。脚本 runInSession 收到它作为第三参数，业务里所有运行时
 * 依赖（log、saveDownload、takeSnapshot 等）都通过这里访问 —— 脚本本身不需要
 * import 任何 brix 内部模块，从 built-in-scripts/ 拷到 data/scripts/ 后仍能跑。
 */
export interface Run {
  runId: string;
  dir: string;
  downloadsDir: string;
  log: Logger;
  saveDownload(d: Download, name?: string): Promise<DownloadedFile>;
  writeArtifact(name: string, data: Buffer | string): Promise<string>;
  listDownloads(): Promise<DownloadedFile[]>;
  takeSnapshot(page: Page, opts?: { scope?: string } & Partial<FormatOptions>): Promise<SnapshotResult>;
}

export class NotFoundError extends Error {
  constructor(msg = 'not_found') { super(msg); this.name = 'NotFoundError'; }
}

function runsRoot(): string {
  return join(getEnv().DATA_DIR, 'runs');
}

function runDirOf(runId: string): string {
  return join(runsRoot(), runId);
}

function downloadsDirOf(runId: string): string {
  return join(runDirOf(runId), 'downloads');
}

export async function createRun(): Promise<Run> {
  const runId = nextId();
  const dir = runDirOf(runId);
  const downloadsDir = downloadsDirOf(runId);
  await mkdir(downloadsDir, { recursive: true });
  log.info(`created run ${runId}`);
  return new RunImpl(runId, dir, downloadsDir);
}

class RunImpl implements Run {
  public readonly log: Logger;
  constructor(
    public readonly runId: string,
    public readonly dir: string,
    public readonly downloadsDir: string,
  ) {
    this.log = createLogger(`run-${runId}`);
  }

  async takeSnapshot(page: Page, opts: { scope?: string } & Partial<FormatOptions> = {}): Promise<SnapshotResult> {
    const { scope, ...formatOpts } = opts;
    const ctx = createBrowserRefContext();
    const snapshot = await takeSnapshot(page, scope, ctx, formatOpts);
    const refs = Object.fromEntries(
      Array.from(ctx.refMap.entries()).map(([k, v]) => [k, { role: v.role, name: v.name, selector: v.selector }]),
    );
    return { snapshot, refCount: ctx.refCounter, refs };
  }

  async saveDownload(d: Download, name?: string): Promise<DownloadedFile> {
    const existing = await readdir(this.downloadsDir).catch(() => []);
    const fallback = `file-${existing.length}.bin`;
    const candidate = name ?? d.suggestedFilename() ?? fallback;
    const finalName = sanitizeName(candidate, fallback);
    const finalPath = join(this.downloadsDir, finalName);
    await d.saveAs(finalPath);
    const s = await stat(finalPath);
    const mimeType = mimeOf(finalName);
    log.info(`saved download ${this.runId}/${finalName} (${s.size} bytes)`);
    return { name: finalName, bytes: s.size, mimeType, downloadedAt: s.mtimeMs };
  }

  async writeArtifact(name: string, data: Buffer | string): Promise<string> {
    if (!isValidName(name)) throw new Error(`invalid artifact name: ${name}`);
    await mkdir(this.dir, { recursive: true });
    const p = join(this.dir, name);
    await writeFile(p, data);
    return p;
  }

  async listDownloads(): Promise<DownloadedFile[]> {
    return listDownloads(this.runId);
  }
}

/** 路由用：列某个 runId 的下载文件 */
export async function listDownloads(runId: string): Promise<DownloadedFile[]> {
  if (!isValidRunId(runId)) throw new NotFoundError();
  const dir = downloadsDirOf(runId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new NotFoundError();
  }
  const out: DownloadedFile[] = [];
  for (const name of names) {
    if (!isValidName(name)) continue;
    try {
      const s = await stat(join(dir, name));
      if (!s.isFile()) continue;
      out.push({ name, bytes: s.size, mimeType: mimeOf(name), downloadedAt: s.mtimeMs });
    } catch { /* race: file vanished between readdir and stat */ }
  }
  out.sort((a, b) => a.downloadedAt - b.downloadedAt);
  return out;
}

/** 路由用：读一个下载文件的元数据 + 校验后的绝对路径 */
export async function readDownload(runId: string, name: string): Promise<{ path: string; bytes: number; mimeType: string }> {
  if (!isValidRunId(runId) || !isValidName(name)) throw new NotFoundError();
  const dir = downloadsDirOf(runId);
  const abs = resolve(dir, name);
  if (!abs.startsWith(dir + sep)) throw new NotFoundError();
  let s;
  try { s = await stat(abs); } catch { throw new NotFoundError(); }
  if (!s.isFile()) throw new NotFoundError();
  return { path: abs, bytes: s.size, mimeType: mimeOf(name) };
}

/** 路由用：硬删除 + 完整清理 */
export async function deleteDownload(runId: string, name: string): Promise<void> {
  if (!isValidRunId(runId) || !isValidName(name)) throw new NotFoundError();
  const dir = downloadsDirOf(runId);
  const abs = resolve(dir, name);
  if (!abs.startsWith(dir + sep)) throw new NotFoundError();

  let bytes = 0;
  try {
    const s = await stat(abs);
    if (!s.isFile()) throw new NotFoundError();
    bytes = s.size;
  } catch {
    throw new NotFoundError();
  }

  await rm(abs, { force: false });

  // 兜底：确认文件确实消失了
  let stillExists = false;
  try { await access(abs, fsConstants.F_OK); stillExists = true; } catch { /* good */ }
  if (stillExists) throw new Error(`delete failed: ${abs} still exists`);

  log.info(`deleted ${runId}/${name} (${bytes} bytes)`);
}
