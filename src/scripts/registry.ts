// 脚本 CRUD：列出 / 读 / 写 / 删 scripts/*.{js,ts}
//
// 不执行脚本 —— 执行只由 sessions 路由通过 loadScriptModule 拿到模块再调。
//
// 文件类型与调用约定：
//   .js  → "brix-api" 约定（新）：runInSession(brix)，brix 是 createBrixScriptApi 注入的 API
//          AST 校验拒所有 import/require/eval/Function；加载走 loader-hook 兜底
//   .ts  → "legacy" 约定（旧）：runInSession(page, args, run)，可任意 import node:* 等
//          仅做 ts.transpileModule 语法检查；保留为内置脚本未迁移期间的桥
//
// 同名 .js 与 .ts 同时存在时，**优先 .js**（迁移期一旦写了 .js 就生效）。
//
// "可执行脚本" 定义：scripts/ 目录下不以 _ 开头、不是 serve 的 .js/.ts 文件。
//   _ 开头 = 开发探索脚本（如 _explore-gemini.ts），不暴露
//   serve = HTTP 服务自己的入口，不能被自己改/删

import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { getEnv } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { isValidScriptName } from '../runs/mime.js';
import { nextId } from '../runs/id.js';
import { BadScriptError, BRIX_SCRIPT_QUERY, ensureLoaderRegistered, validateScriptSource } from './loader.js';

const log = createLogger('script-registry');

export { BadScriptError } from './loader.js';

function scriptsDir(): string {
  return getEnv().SCRIPTS_DIR;
}

export type ScriptLanguage = 'js' | 'ts';

/** 调用约定：决定 sessions 路由怎么调 runInSession */
export type CallingConvention = 'brix-api' | 'legacy';

export interface ScriptMeta {
  name: string;
  language: ScriptLanguage;
  description?: string;
  argsExample?: unknown;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export class NotFoundError extends Error {
  constructor(msg = 'not_found') { super(msg); this.name = 'NotFoundError'; }
}

function pathOfExt(name: string, ext: ScriptLanguage): string {
  return join(scriptsDir(), `${name}.${ext}`);
}

function isHidden(name: string): boolean {
  return name.startsWith('_') || name === 'serve';
}

/** 解析 name → 实际文件路径 + 语言。优先 .js。返回 null 表示不存在。 */
async function resolveScriptFile(name: string): Promise<{ path: string; language: ScriptLanguage } | null> {
  for (const ext of ['js', 'ts'] as const) {
    const p = pathOfExt(name, ext);
    try {
      const s = await stat(p);
      if (s.isFile()) return { path: p, language: ext };
    } catch { /* try next */ }
  }
  return null;
}

async function tryReadModuleMeta(path: string, language: ScriptLanguage): Promise<{ description?: string; argsExample?: unknown }> {
  try {
    // 探测 meta 也是"加载脚本"，必须走和真正执行一样的隔离：
    //   - .js 带 ?brix-script=1，让 loader-hook 兜底拦截 import（即便 AST 校验有
    //     边角 case 漏判，meta 探测路径也不会执行脚本里的 import）
    //   - .ts 走旧路径，没 hook 拦截（迁移期接受）
    // 仍带 ?v= cache-bust 让运行时改写后能拿到新 meta。
    let url = pathToFileURL(path).href;
    if (language === 'js') {
      ensureLoaderRegistered();
      url += `?${BRIX_SCRIPT_QUERY}&v=${nextId()}`;
    } else {
      url += `?v=${nextId()}`;
    }
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
    log.debug(`read meta failed for ${path} (${language}): ${e instanceof Error ? e.message : e}`);
  }
  return {};
}

export async function listScripts(): Promise<ScriptMeta[]> {
  let entries: string[];
  try { entries = await readdir(scriptsDir()); } catch { return []; }

  // 收集 (name, language) 候选，同名 .js 优先
  const byName = new Map<string, ScriptLanguage>();
  for (const f of entries) {
    let name: string | null = null;
    let lang: ScriptLanguage | null = null;
    if (f.endsWith('.js')) { name = f.slice(0, -3); lang = 'js'; }
    else if (f.endsWith('.ts')) { name = f.slice(0, -3); lang = 'ts'; }
    else continue;
    if (!isValidScriptName(name) || isHidden(name)) continue;
    const existing = byName.get(name);
    // .js 优先：如果已记录 ts，被 js 覆盖；反之 ts 不覆盖 js
    if (!existing || lang === 'js') byName.set(name, lang);
  }

  const out: ScriptMeta[] = [];
  for (const [name, language] of byName) {
    try {
      const p = pathOfExt(name, language);
      const s = await stat(p);
      const meta = await tryReadModuleMeta(p, language);
      out.push({
        name,
        language,
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
  const resolved = await resolveScriptFile(name);
  if (!resolved) throw new NotFoundError();
  const s = await stat(resolved.path);
  const source = await readFile(resolved.path, 'utf-8');
  const m = await tryReadModuleMeta(resolved.path, resolved.language);
  return {
    meta: {
      name,
      language: resolved.language,
      description: m.description,
      argsExample: m.argsExample,
      createdAt: s.birthtimeMs || s.ctimeMs,
      updatedAt: s.mtimeMs,
      bytes: s.size,
    },
    source,
  };
}

/**
 * .ts 旧路径：ts.transpileModule 做纯 parse 检查（与历史行为一致）。
 *
 * 仅当 language='ts' 时调用。BRIX_SKIP_SCRIPT_TSC=1 跳过（测试用）。
 */
function legacyTsSyntaxCheck(source: string): void {
  if (process.env.BRIX_SKIP_SCRIPT_TSC === '1') return;
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
    reportDiagnostics: true,
  });
  const diags = result.diagnostics ?? [];
  if (diags.length === 0) return;
  const msg = diags
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join('\n')
    .slice(0, 4000);
  throw new BadScriptError(msg || 'syntax error');
}

export interface WriteOpts {
  /** 'js'（默认，新约定）或 'ts'（旧约定，仅为兼容内置脚本迁移期保留） */
  language?: ScriptLanguage;
}

export async function writeScript(name: string, source: string, opts: WriteOpts = {}): Promise<ScriptMeta> {
  if (!isValidScriptName(name) || isHidden(name)) throw new BadScriptError('invalid script name');
  if (typeof source !== 'string' || source.length === 0) throw new BadScriptError('empty source');
  if (source.length > 1_000_000) throw new BadScriptError('source too large (>1MB)');

  const language: ScriptLanguage = opts.language ?? 'js';

  if (language === 'js') {
    // AST 校验：拒 import/require/eval/Function，要求 runInSession 导出
    validateScriptSource(source);
  } else {
    legacyTsSyntaxCheck(source);
  }

  const p = pathOfExt(name, language);
  await writeFile(p, source);

  // 对称清理同名另一扩展：否则 .js 优先级会让 PUT(language='ts') 在同名 .js 已存在时
  // 看似成功但实际读取/执行还是 .js，用户困惑。两边都清 → 写谁就是谁。
  const otherExt: ScriptLanguage = language === 'js' ? 'ts' : 'js';
  await rm(pathOfExt(name, otherExt), { force: true }).catch(() => { /* ignore */ });

  log.info(`wrote script ${name}.${language} (${source.length} chars)`);

  const s = await stat(p);
  const m = await tryReadModuleMeta(p, language);
  return {
    name,
    language,
    description: m.description,
    argsExample: m.argsExample,
    createdAt: s.birthtimeMs || s.ctimeMs,
    updatedAt: s.mtimeMs,
    bytes: s.size,
  };
}

export async function deleteScript(name: string): Promise<void> {
  if (!isValidScriptName(name) || isHidden(name)) throw new NotFoundError();
  const resolved = await resolveScriptFile(name);
  if (!resolved) throw new NotFoundError();
  // 同名 .js 与 .ts 都删（同时存在时 resolveScriptFile 优先返回 .js，另一个也应清掉）
  await rm(pathOfExt(name, 'js'), { force: true }).catch(() => { /* ignore */ });
  await rm(pathOfExt(name, 'ts'), { force: true }).catch(() => { /* ignore */ });
  log.info(`deleted script ${name}`);
}

/** sessions 路由用：dynamic-import 取脚本模块，返回模块函数 + 调用约定 */
export interface LoadedScript {
  runInSession: (...args: unknown[]) => Promise<unknown>;
  convention: CallingConvention;
}

export async function loadScriptModule(name: string): Promise<LoadedScript> {
  if (!isValidScriptName(name) || isHidden(name)) throw new NotFoundError();
  const resolved = await resolveScriptFile(name);
  if (!resolved) throw new NotFoundError();

  let url = pathToFileURL(resolved.path).href;
  // brix-api 约定的 .js：URL 标记，让 loader-hook 兜底拦截脚本内部的 import
  if (resolved.language === 'js') {
    ensureLoaderRegistered();
    url += `?${BRIX_SCRIPT_QUERY}&v=${nextId()}`;
  } else {
    url += `?v=${nextId()}`;
  }

  const mod = await import(url);
  const fn = (mod as { runInSession?: unknown }).runInSession;
  if (typeof fn !== 'function') throw new BadScriptError('missing runInSession export');

  return {
    runInSession: fn as (...args: unknown[]) => Promise<unknown>,
    convention: resolved.language === 'js' ? 'brix-api' : 'legacy',
  };
}
