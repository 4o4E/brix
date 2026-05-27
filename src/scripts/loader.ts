// brix 脚本加载器：
//   1. validateScriptSource(source)  写入阶段静态校验（AST）—— 拒所有 import/require/eval/Function
//   2. ensureLoaderRegistered()      首次加载时注册 ESM resolve hook 作为底裤
//
// 双层防御：
//   AST 校验给清晰的写入期错误（PUT /scripts/:name 返回 400 bad_script）；
//   resolve hook 兜底：即便 AST 漏掉某种混淆写法（如 Function ctor 里塞 import 字符串
//   再被 eval），脚本运行时也无法解析任何 import target。
//
// 仅作用于 .js 脚本 —— .ts 脚本（旧 built-in）仍走原 ts.transpileModule 路径，
// PR 3 全部迁移后整个 .ts 加载路径会被删除。

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export class BadScriptError extends Error {
  constructor(public details: string) { super('bad_script'); this.name = 'BadScriptError'; }
}

// ---------------------------------------------------------------------------
// AST 校验
// ---------------------------------------------------------------------------

interface Violation {
  kind: string;
  line: number;
  col: number;
  detail: string;
}

const BANNED_GLOBALS = new Set(['require', 'eval', 'Function']);

/**
 * 静态校验一段 JS 脚本源码。
 *   - 拒所有 ImportDeclaration / ImportEqualsDeclaration / ExportDeclaration with from
 *   - 拒动态 import(...)
 *   - 拒任何对全局标识 `require` / `eval` / `Function` 的引用（无论是不是被调用）
 *   - 要求至少有一个 named export 叫 runInSession
 *
 * 通过则 return；不通过则抛 BadScriptError，details 是首批 violation 的可读列表。
 */
export function validateScriptSource(source: string): void {
  if (typeof source !== 'string') throw new BadScriptError('source 必须是字符串');
  if (source.length === 0) throw new BadScriptError('source 为空');

  const sf = ts.createSourceFile('script.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);

  // 先看 parse 错误
  const syntaxDiags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntaxDiags.length > 0) {
    const msg = syntaxDiags
      .slice(0, 5)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new BadScriptError(`语法错误：\n${msg}`);
  }

  const violations: Violation[] = [];
  let hasRunInSession = false;

  const recordAt = (node: ts.Node, kind: string, detail: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push({ kind, line: line + 1, col: character + 1, detail });
  };

  const visit = (node: ts.Node): void => {
    // import X from 'Y' / import 'Y'
    if (ts.isImportDeclaration(node)) {
      recordAt(node, 'import', `禁止 import：${node.moduleSpecifier.getText(sf)}`);
      return;
    }
    // import X = require('Y') (TS-style，按理 JS 里不会有，但兜底)
    if (ts.isImportEqualsDeclaration(node)) {
      recordAt(node, 'import', 'import = require 不允许');
      return;
    }
    // export { x } from 'Y'  /  export * from 'Y'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      recordAt(node, 'reexport', '不允许从其它模块 re-export');
      return;
    }
    // 动态 import('Y')
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      recordAt(node, 'dynamic-import', '动态 import() 不允许');
      return;
    }
    // 对全局标识 require / eval / Function 的引用（不论是不是被调用）
    if (ts.isIdentifier(node) && BANNED_GLOBALS.has(node.text)) {
      const parent = node.parent;
      // 排除 PropertyAccess 的右侧（如 obj.require —— 不是全局 require）
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      // 排除"声明 name 位"：这些位置上的标识是新绑定，不是对全局的引用
      //   - 对象字面量 / 解构：{ require: foo }, { eval }, const { Function: f } = obj
      //   - 变量声明：const require = ...
      //   - 函数 / 类声明 + 参数：function Function() {} / (require) => {}
      //   - 类成员：class { Function() {} }
      if (parent && isDeclarationNamePosition(parent, node)) return;
      recordAt(node, 'banned-global', `不允许引用全局 ${node.text}`);
      return;
    }
    // 检 runInSession export
    // 形态 1: export function runInSession(...)
    // 形态 2: export const runInSession = ...
    // 形态 3: export { runInSession }
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name?.text === 'runInSession') {
      hasRunInSession = true;
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'runInSession') hasRunInSession = true;
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const exported = (spec.name as ts.Identifier).text;
        if (exported === 'runInSession') hasRunInSession = true;
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  if (violations.length > 0) {
    const lines = violations.slice(0, 10).map((v) => `[L${v.line}:${v.col}] ${v.kind}: ${v.detail}`);
    if (violations.length > 10) lines.push(`(还有 ${violations.length - 10} 个未列出)`);
    throw new BadScriptError(lines.join('\n'));
  }

  if (!hasRunInSession) {
    throw new BadScriptError('缺少 export runInSession');
  }
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  const mods = ts.getModifiers(node);
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * `id` 是否处于某种"声明名字位"（绑定，而非引用）。
 * 命中这些位置时，`require` / `eval` / `Function` 之类是作者新建的标识符，
 * 不是对全局的引用，应该放过。
 */
function isDeclarationNamePosition(parent: ts.Node, id: ts.Identifier): boolean {
  // { require: foo } / { Function }（写法）—— PropertyAssignment.name 与 Shorthand 自身
  if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) return true;
  // const { require: x } = obj  —— BindingElement 的 propertyName 或 name 位
  if (ts.isBindingElement(parent) && (parent.name === id || parent.propertyName === id)) return true;
  // const require = ... / let Function = ...
  if (ts.isVariableDeclaration(parent) && parent.name === id) return true;
  // function (require) {} / (Function) => {}
  if (ts.isParameter(parent) && parent.name === id) return true;
  // function Function() {} / class require {}
  if (ts.isFunctionDeclaration(parent) && parent.name === id) return true;
  if (ts.isClassDeclaration(parent) && parent.name === id) return true;
  // class { Function() {} } / class { get require() {} } —— Method / Getter / Setter / Property name
  if ((ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === id) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Resolve hook 注册
// ---------------------------------------------------------------------------

let registered = false;

/** 注册 ESM resolve hook（幂等）。首次加载 .js 脚本前调用一次。 */
export function ensureLoaderRegistered(): void {
  if (registered) return;
  registered = true;
  // pathToFileURL + register(specifier, parent) —— parent 解释 specifier 时用
  const hookUrl = new URL('./loader-hook.mjs', import.meta.url);
  register(hookUrl.href, pathToFileURL(process.cwd() + '/'));
}

/** 标记 query string，registry 拼 URL 时附加，让 hook 能识别"这是脚本上下文" */
export const BRIX_SCRIPT_QUERY = 'brix-script=1';
