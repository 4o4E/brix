// 脚本 CRUD：列出 / 读 / 写 / 删 scripts/*.ts
//
// 不执行脚本 —— 执行只由 sessions 路由通过 dynamic import 触发。
//
// "可执行脚本" 定义：scripts/ 目录下不以 _ 开头、不是 serve.ts 的 .ts 文件。
//   _ 开头 = 开发探索脚本（如 _explore-gemini.ts），不暴露
//   serve.ts = HTTP 服务自己的入口，不能被自己改/删

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../utils/logger.js';
import { isValidScriptName } from '../runs/mime.js';
import { nextId } from '../runs/id.js';

const log = createLogger('script-registry');

const SCRIPTS_DIR = resolve('scripts');

export interface ScriptMeta {
  name: string;
  description?: string;
  argsExample?: unknown;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export class NotFoundError extends Error {
  constructor(msg = 'not_found') { super(msg); this.name = 'NotFoundError'; }
}

export class BadScriptError extends Error {
  constructor(public details: string) { super('bad_script'); this.name = 'BadScriptError'; }
}

function pathOf(name: string): string {
  return join(SCRIPTS_DIR, `${name}.ts`);
}

function isHidden(name: string): boolean {
  return name.startsWith('_') || name === 'serve';
}

async function tryReadModuleMeta(name: string): Promise<{ description?: string; argsExample?: unknown }> {
  try {
    const url = pathToFileURL(pathOf(name)).href + `?v=${nextId()}`;  // cache-bust
    const mod = await import(url);
    const m = (mod as { meta?: unknown }).meta;
    if (m && typeof m === 'object') {
      const obj = m as { description?: unknown; argsExample?: unknown };
      return {
        description: typeof obj.description === 'string' ? obj.description : undefined,
        argsExample: obj.argsExample,
      };
    }
  } catch (e) {
    log.debug(`read meta failed for ${name}: ${e instanceof Error ? e.message : e}`);
  }
  return {};
}

export async function listScripts(): Promise<ScriptMeta[]> {
  let entries: string[];
  try { entries = await readdir(SCRIPTS_DIR); } catch { return []; }
  const names = entries
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .filter((n) => !isHidden(n) && isValidScriptName(n));

  const out: ScriptMeta[] = [];
  for (const name of names) {
    try {
      const s = await stat(pathOf(name));
      const meta = await tryReadModuleMeta(name);
      out.push({
        name,
        description: meta.description,
        argsExample: meta.argsExample,
        createdAt: s.birthtimeMs || s.ctimeMs,
        updatedAt: s.mtimeMs,
        bytes: s.size,
      });
    } catch { /* skip */ }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readScript(name: string): Promise<{ meta: ScriptMeta; source: string }> {
  if (!isValidScriptName(name) || isHidden(name)) throw new NotFoundError();
  const p = pathOf(name);
  let s, source;
  try {
    s = await stat(p);
    source = await readFile(p, 'utf-8');
  } catch { throw new NotFoundError(); }
  const m = await tryReadModuleMeta(name);
  return {
    meta: { name, description: m.description, argsExample: m.argsExample, createdAt: s.birthtimeMs || s.ctimeMs, updatedAt: s.mtimeMs, bytes: s.size },
    source,
  };
}

/**
 * 用 tsc 语法检查脚本字符串。失败抛 BadScriptError。
 * 写入临时 .ts → spawn tsc --noEmit。tsc 不在则跳过检查（项目应有 typescript devDep，正常情况下都在）。
 */
async function syntaxCheck(name: string, source: string): Promise<void> {
  const tmpDir = join(tmpdir(), `brix-tsc-${nextId()}`);
  await mkdir(tmpDir, { recursive: true });
  const tmpFile = join(tmpDir, `${name}.ts`);
  await writeFile(tmpFile, source);
  try {
    await new Promise<void>((res, rej) => {
      const tsc = spawn('npx', ['tsc', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop', '--skipLibCheck', '--isolatedModules', tmpFile], {
        cwd: process.cwd(),
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      tsc.stdout.on('data', (d) => { stdout += d.toString(); });
      tsc.stderr.on('data', (d) => { stderr += d.toString(); });
      tsc.on('error', () => res());  // tsc not available → skip check
      tsc.on('close', (code) => {
        if (code === 0) return res();
        rej(new BadScriptError((stdout + stderr).trim().slice(0, 4000) || `tsc exit ${code}`));
      });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}

export async function writeScript(name: string, source: string): Promise<ScriptMeta> {
  if (!isValidScriptName(name) || isHidden(name)) throw new BadScriptError('invalid script name');
  if (typeof source !== 'string' || source.length === 0) throw new BadScriptError('empty source');
  if (source.length > 1_000_000) throw new BadScriptError('source too large (>1MB)');

  await syntaxCheck(name, source);

  const p = pathOf(name);
  await writeFile(p, source);
  log.info(`wrote script ${name} (${source.length} chars)`);

  const s = await stat(p);
  const m = await tryReadModuleMeta(name);
  return {
    name,
    description: m.description,
    argsExample: m.argsExample,
    createdAt: s.birthtimeMs || s.ctimeMs,
    updatedAt: s.mtimeMs,
    bytes: s.size,
  };
}

export async function deleteScript(name: string): Promise<void> {
  if (!isValidScriptName(name) || isHidden(name)) throw new NotFoundError();
  const p = pathOf(name);
  try { await stat(p); } catch { throw new NotFoundError(); }
  await rm(p, { force: false });
  log.info(`deleted script ${name}`);
}

/** sessions 路由用：dynamic-import 取脚本模块（要求导出 runInSession） */
export async function loadScriptModule(name: string): Promise<{ runInSession: (page: unknown, args: unknown, run: unknown) => Promise<unknown> }> {
  if (!isValidScriptName(name) || isHidden(name)) throw new NotFoundError();
  const p = pathOf(name);
  try { await stat(p); } catch { throw new NotFoundError(); }
  const url = pathToFileURL(p).href + `?v=${nextId()}`;  // cache-bust 让脚本被改写后下次能拿到新版本
  const mod = await import(url);
  const fn = (mod as { runInSession?: unknown }).runInSession;
  if (typeof fn !== 'function') throw new BadScriptError('missing runInSession export');
  return { runInSession: fn as (page: unknown, args: unknown, run: unknown) => Promise<unknown> };
}
