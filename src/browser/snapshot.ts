// 页面 DOM → 带 [ref=eN] 的结构化文本 snapshot
// 移植自 my-claw src/browser/agent.ts
//
// 输出形如：
//   navigation
//     a [ref=e1] "首页" href="/"
//     a [ref=e2] "登录" href="/login"
//   main
//     heading "搜索结果"
//     ul.results
//       li ...
//       ... 47 more items [ref e10~e57]: "Python tutorial" ...
//
// 每个可交互元素分配 [ref=eN]，refMap 记录 ref → selector，后续 interact.click(ref) 用它定位

import type { Page } from 'patchright';
import { getEnv } from '../config.js';

export interface RefEntry {
  ref: string;
  role: string;
  name: string;
  selector: string;
}

/** ref 上下文：每个 agent / 脚本持有独立实例，避免并发冲突 */
export interface BrowserRefContext {
  refMap: Map<string, RefEntry>;
  refCounter: number;
}

export function createBrowserRefContext(): BrowserRefContext {
  return { refMap: new Map(), refCounter: 0 };
}

/** 模块默认 context（单脚本场景直接用） */
const defaultCtx: BrowserRefContext = createBrowserRefContext();

export function getDefaultRefContext(): BrowserRefContext {
  return defaultCtx;
}

// 在浏览器内执行的 JS（纯字符串，避免 tsx/esbuild 注入 __name 包装）
// 返回 SnapNode 树：{ role, name, interactive?, container?, children?, ... }
const SNAPSHOT_SCRIPT_FN = [
  '((scopeSelector) => {',
  '  const getSelector = (el) => {',
  '    if (el.id) return "#" + CSS.escape(el.id);',
  '    const parts = [];',
  '    let cur = el;',
  '    while (cur && cur !== document.body) {',
  '      let sel = cur.tagName.toLowerCase();',
  '      if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }',
  '      const parent = cur.parentElement;',
  '      if (parent) {',
  '        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);',
  '        if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")";',
  '      }',
  '      parts.unshift(sel);',
  '      cur = parent;',
  '    }',
  '    return parts.join(" > ");',
  '  };',
  '  const ownText = (el) => {',
  '    let t = "";',
  '    for (const n of el.childNodes) {',
  '      if (n.nodeType === 3) t += n.textContent;',
  '    }',
  '    return t.trim().slice(0, 80);',
  '  };',
  '  const skip = new Set(["script","style","noscript","svg","path","meta","link","head"]);',
  '  const interactiveTags = new Set(["a","button","input","select","textarea"]);',
  '  const interactiveRoles = new Set([',
  '    "link","button","textbox","checkbox","radio",',
  '    "combobox","menuitem","tab","switch","searchbox","option"',
  '  ]);',
  '  const headingTags = new Set(["h1","h2","h3","h4","h5","h6"]);',
  '  const containerTags = new Set([',
  '    "nav","main","aside","header","footer","form","dialog",',
  '    "section","article","ul","ol","table","details","fieldset","menu"',
  '  ]);',
  '  const containerRoles = new Set([',
  '    "navigation","dialog","alertdialog","menu","menubar","tablist",',
  '    "toolbar","region","list","listbox","tree","grid","form","search",',
  '    "banner","contentinfo","complementary","main"',
  '  ]);',
  '  const countInteractive = (children) => {',
  '    let n = 0;',
  '    for (const c of children) { if (c && c.interactive) n++; }',
  '    return n;',
  '  };',
  '  const walk = (el) => {',
  '    if (!el || !el.tagName) return null;',
  '    const tag = el.tagName.toLowerCase();',
  '    if (skip.has(tag)) return null;',
  '    if (el.hidden || el.getAttribute("aria-hidden") === "true") return null;',
  '    try {',
  '      const cs = getComputedStyle(el);',
  '      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return null;',
  '    } catch(e) {}',
  '    const rect = el.getBoundingClientRect();',
  '    if (rect.width === 0 && rect.height === 0 && tag !== "input" && tag !== "select") return null;',
  '    const role = el.getAttribute("role") || "";',
  '    const ariaLabel = el.getAttribute("aria-label") || "";',
  '    const placeholder = el.getAttribute("placeholder") || "";',
  '    const cls = el.className && typeof el.className === "string" ? el.className : "";',
  '    const isInteractive = interactiveTags.has(tag) || interactiveRoles.has(role);',
  '    const isHeading = headingTags.has(tag) || role === "heading";',
  '    const isImg = tag === "img";',
  '    const children = [];',
  '    for (const child of el.children) {',
  '      const c = walk(child);',
  '      if (c) children.push(c);',
  '    }',
  '    const isSemantic = containerTags.has(tag) || containerRoles.has(role);',
  '    const hasMultiInteractive = countInteractive(children) >= 2;',
  '    const isRepeatItem = (tag === "tr" || tag === "li" || tag === "dt" || tag === "dd")',
  '      || (tag === "div" && cls && el.parentElement',
  '          && Array.from(el.parentElement.children).filter(s => s.className === cls).length > 1);',
  '    const isContainer = isSemantic',
  '      || (ariaLabel && !isInteractive)',
  '      || (el.id && !isInteractive && children.length > 0)',
  '      || (hasMultiInteractive && !isInteractive)',
  '      || (isRepeatItem && children.length > 0);',
  '    let name = ariaLabel || placeholder || ownText(el);',
  '    if (isImg) name = el.alt || ariaLabel || "";',
  '    const directText = ownText(el);',
  '    const meaningful = isInteractive || isHeading || isImg',
  '      || (role && role !== tag && name);',
  '    if (meaningful && (name || isInteractive)) {',
  '      const entry = {',
  '        role: isHeading ? "heading" : (role && role !== tag ? role : tag),',
  '        name: name.slice(0, 100),',
  '        interactive: isInteractive,',
  '      };',
  '      if (isInteractive) entry.selector = getSelector(el);',
  '      if (el.value) entry.value = el.value;',
  '      if (el.checked !== undefined && el.checked !== false) entry.checked = el.checked;',
  '      if (el.type && isInteractive) entry.type = el.type;',
  '      if (tag === "a" && el.href) entry.href = el.href;',
  '      if (isImg) { entry.width = el.naturalWidth || el.width; entry.height = el.naturalHeight || el.height; if (el.src) entry.src = el.src; }',
  '      if (children.length > 0) entry.children = children;',
  '      return entry;',
  '    }',
  '    if (isContainer && children.length > 0) {',
  '      const label = ariaLabel || (el.id ? "#" + el.id : "");',
  '      const cName = cls ? "." + cls.split(/\\s+/).slice(0, 2).join(".") : "";',
  '      return {',
  '        role: (role || tag) + cName,',
  '        name: label.slice(0, 100),',
  '        container: true,',
  '        children: children',
  '      };',
  '    }',
  '    if (children.length > 0) {',
  '      if (children.length === 1 && !cls) return children[0];',
  '      if (cls && children.length > 1) {',
  '        const cName = "." + cls.split(/\\s+/).slice(0, 2).join(".");',
  '        return { role: tag + cName, name: "", container: true, children: children };',
  '      }',
  '      if (children.length === 1) return children[0];',
  '      return { role: "", name: "", container: true, children: children, passthrough: true };',
  '    }',
  '    if (directText && directText.length > 1) {',
  '      return { role: tag, name: directText.slice(0, 100), text: true };',
  '    }',
  '    return null;',
  '  };',
  '  const root = scopeSelector ? (document.querySelector(scopeSelector) || document.body) : document.body;',
  '  return walk(root);',
  '})',
].join('\n');

const FIND_SCRIPT = [
  '((query) => {',
  '  const getSelector = (el) => {',
  '    if (el.id) return "#" + CSS.escape(el.id);',
  '    const parts = [];',
  '    let cur = el;',
  '    while (cur && cur !== document.body) {',
  '      let sel = cur.tagName.toLowerCase();',
  '      if (cur.id) { parts.unshift("#" + CSS.escape(cur.id)); break; }',
  '      const parent = cur.parentElement;',
  '      if (parent) {',
  '        const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);',
  '        if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(cur) + 1) + ")";',
  '      }',
  '      parts.unshift(sel);',
  '      cur = parent;',
  '    }',
  '    return parts.join(" > ");',
  '  };',
  '  const q = query.toLowerCase();',
  '  const results = [];',
  '  const all = document.querySelectorAll("*");',
  '  for (const el of all) {',
  '    const tag = el.tagName.toLowerCase();',
  '    if (["script","style","noscript","svg","head"].includes(tag)) continue;',
  '    const label = el.getAttribute("aria-label") || "";',
  '    const ph = el.getAttribute("placeholder") || "";',
  '    const text = el.innerText ? el.innerText.slice(0, 200) : "";',
  '    const title = el.getAttribute("title") || "";',
  '    const match = [label, ph, text, title].some(s => s.toLowerCase().includes(q));',
  '    if (!match) continue;',
  '    results.push({',
  '      tag: tag,',
  '      role: el.getAttribute("role") || tag,',
  '      name: label || ph || text.slice(0, 80),',
  '      selector: getSelector(el),',
  '      interactive: ["a","button","input","select","textarea"].includes(tag)',
  '        || ["link","button","textbox","checkbox","radio","combobox","menuitem","tab","switch","searchbox","option"].includes(el.getAttribute("role") || "")',
  '    });',
  '    if (results.length >= 20) break;',
  '  }',
  '  return results;',
  '})',
].join('\n');

interface SnapNode {
  role: string;
  name: string;
  interactive?: boolean;
  container?: boolean;
  passthrough?: boolean;
  text?: boolean;
  selector?: string;
  value?: string;
  checked?: boolean;
  type?: string;
  href?: string;
  src?: string;
  width?: number;
  height?: number;
  children?: SnapNode[];
}

const DEFAULT_REPEAT_SHOW = 3;

export interface FormatOptions {
  /** 只输出可交互节点（容器层级保留） */
  interactiveOnly: boolean;
  /** 最大嵌套深度，0 = 不限 */
  maxDepth: number;
  /** 重复结构展开数量（同结构连续 ≥5 时） */
  repeatShow: number;
  /** 页面 origin，用于压缩同源 href（同源只显示路径） */
  pageOrigin: string;
}

function compressTree(node: SnapNode | null): SnapNode | null {
  if (!node) return null;
  if (node.children) {
    node.children = node.children
      .map((c) => compressTree(c))
      .filter((c): c is SnapNode => c !== null);
  }
  if (node.passthrough) {
    if (!node.children || node.children.length === 0) return null;
    if (node.children.length === 1) return node.children[0];
    return node;
  }
  if (node.container && node.name) return node;
  if (node.container && !node.name && node.children?.length === 1) return node.children[0];
  if (node.container && (!node.children || node.children.length === 0)) return null;
  return node;
}

function getStructSig(node: SnapNode): string {
  if (node.text) return 'T';
  if (node.interactive) return `I:${node.role}`;
  if (node.container || node.passthrough) {
    const types = new Set((node.children ?? []).map(getStructSig));
    return `C{${Array.from(types).sort().join(',')}}`;
  }
  return `N:${node.role}`;
}

function getNodeSummary(node: SnapNode): string {
  if (node.name) return node.name.slice(0, 60);
  for (const child of node.children ?? []) {
    const s = getNodeSummary(child);
    if (s) return s;
  }
  return '';
}

function assignRefsQuietly(node: SnapNode, c: BrowserRefContext): void {
  if (!node) return;
  if (node.interactive) {
    const ref = `e${++c.refCounter}`;
    c.refMap.set(ref, { ref, role: node.role, name: node.name, selector: node.selector || '' });
  }
  for (const child of node.children ?? []) assignRefsQuietly(child, c);
}

function hasInteractiveDescendant(node: SnapNode): boolean {
  if (node.interactive) return true;
  for (const child of node.children ?? []) {
    if (hasInteractiveDescendant(child)) return true;
  }
  return false;
}

function formatChildrenWithFolding(
  children: SnapNode[],
  depth: number,
  lines: string[],
  c: BrowserRefContext,
  opts: FormatOptions,
): void {
  const indent = '  '.repeat(Math.min(depth, 8));
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    const sig = getStructSig(child);
    let runLen = 1;
    while (i + runLen < children.length && getStructSig(children[i + runLen]) === sig) runLen++;

    if (runLen >= 5) {
      const showCount = Math.min(opts.repeatShow, runLen);
      for (let j = 0; j < showCount; j++) formatTree(children[i + j], depth, lines, c, opts);
      const remaining = runLen - showCount;
      if (remaining > 0) {
        const refStart = c.refCounter + 1;
        for (let j = showCount; j < runLen; j++) assignRefsQuietly(children[i + j], c);
        const refEnd = c.refCounter;
        const firstFolded = children[i + showCount];
        const summary = getNodeSummary(firstFolded);
        const refRange = refStart <= refEnd ? ` [ref e${refStart}~e${refEnd}]` : '';
        lines.push(`${indent}... ${remaining} more items${refRange}${summary ? `: "${summary}" ...` : ''}`);
      }
      i += runLen;
    } else {
      formatTree(child, depth, lines, c, opts);
      i++;
    }
  }
}

function formatTree(
  node: SnapNode,
  depth: number,
  lines: string[],
  c: BrowserRefContext,
  opts: FormatOptions,
): void {
  if (!node) return;
  if (opts.maxDepth > 0 && depth > opts.maxDepth) {
    assignRefsQuietly(node, c);
    return;
  }

  const indent = '  '.repeat(Math.min(depth, 8));

  if (node.container || node.passthrough) {
    const hasContent = opts.interactiveOnly
      ? hasInteractiveDescendant(node)
      : !!(node.children && node.children.length > 0);
    if (!hasContent) return;
    if (node.passthrough) {
      formatChildrenWithFolding(node.children ?? [], depth, lines, c, opts);
      return;
    }
    const label = node.name ? ` "${node.name}"` : '';
    lines.push(`${indent}${node.role}${label}`);
    formatChildrenWithFolding(node.children ?? [], depth + 1, lines, c, opts);
    return;
  }

  if (node.text) {
    if (!opts.interactiveOnly && node.name && node.name.length > 2) {
      if (!/^[\d,.\s·›»«\-|/]+$/.test(node.name)) {
        lines.push(`${indent}"${node.name}"`);
      }
    }
    return;
  }

  if (opts.interactiveOnly && !node.interactive) {
    for (const child of node.children ?? []) formatTree(child, depth, lines, c, opts);
    return;
  }

  let refTag = '';
  if (node.interactive) {
    const ref = `e${++c.refCounter}`;
    c.refMap.set(ref, { ref, role: node.role, name: node.name, selector: node.selector || '' });
    refTag = ` [ref=${ref}]`;
  }

  const value = node.value ? ` value="${node.value}"` : '';
  const checked = node.checked !== undefined ? ` checked=${node.checked}` : '';
  const imgSize = node.width ? ` ${node.width}x${node.height}` : '';
  const typeInfo = node.type ? ` type=${node.type}` : '';
  let hrefInfo = '';
  if (node.href) {
    const shortHref = opts.pageOrigin && node.href.startsWith(opts.pageOrigin)
      ? node.href.slice(opts.pageOrigin.length) || '/'
      : node.href;
    hrefInfo = ` href="${shortHref}"`;
  }
  lines.push(`${indent}${node.role}${refTag}${typeInfo} "${node.name}"${value}${checked}${imgSize}${hrefInfo}`);

  // a 标签自身有 name 时省略子 img（避免冗余）
  const skipChildImg = node.interactive && node.role === 'a' && !!node.name;
  for (const child of node.children ?? []) {
    if (skipChildImg && child.role === 'img') continue;
    formatTree(child, depth + 1, lines, c, opts);
  }
}

/**
 * 生成页面的结构化 snapshot 文本
 * - 每个可交互元素分配 [ref=eN]，可用 interact.click(ref) 等定位
 * - ctx 不传时使用模块默认 context（单脚本场景）
 */
export async function takeSnapshot(
  page: Page,
  scope?: string,
  ctx?: BrowserRefContext,
  formatOpts?: Partial<FormatOptions>,
): Promise<string> {
  const maxChars = getEnv().SNAPSHOT_MAX_CHARS;
  const c = ctx ?? defaultCtx;
  c.refMap.clear();
  c.refCounter = 0;

  const opts: FormatOptions = {
    interactiveOnly: false,
    maxDepth: 0,
    repeatShow: DEFAULT_REPEAT_SHOW,
    pageOrigin: '',
    ...formatOpts,
  };
  if (!opts.pageOrigin) {
    try { opts.pageOrigin = new URL(page.url()).origin; } catch { /* ignore */ }
  }

  const raw = (await page.evaluate(`${SNAPSHOT_SCRIPT_FN}(${JSON.stringify(scope ?? null)})`)) as SnapNode | null;
  if (!raw) return '(页面无可访问内容)';

  const tree = compressTree(raw);
  if (!tree) return '(页面无可访问内容)';

  const lines: string[] = [];
  if (tree.passthrough || tree.container) {
    for (const child of tree.children ?? []) formatTree(child, 0, lines, c, opts);
  } else {
    formatTree(tree, 0, lines, c, opts);
  }

  let result = lines.join('\n');
  if (result.length > maxChars) result = result.slice(0, maxChars) + '\n...(snapshot 已截断)';
  return result || '(页面无可访问内容)';
}

/** 按 query 模糊搜索元素（aria-label / placeholder / text / title） */
export async function findElements(
  page: Page,
  query: string,
  ctx?: BrowserRefContext,
): Promise<string> {
  const c = ctx ?? defaultCtx;
  const results = (await page.evaluate(`${FIND_SCRIPT}(${JSON.stringify(query)})`)) as Array<{
    tag: string;
    role: string;
    name: string;
    selector: string;
    interactive: boolean;
  }>;

  if (results.length === 0) return `未找到包含 "${query}" 的元素`;

  const lines: string[] = [];
  for (const r of results) {
    const ref = `e${++c.refCounter}`;
    c.refMap.set(ref, { ref, role: r.role, name: r.name, selector: r.selector });
    const mark = r.interactive ? ' *' : '';
    lines.push(`[ref=${ref}] ${r.tag}(${r.role})${mark} "${r.name}"`);
  }
  return lines.join('\n');
}
