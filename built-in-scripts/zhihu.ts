// brix 内置脚本：知乎内容抓取（问答 / 专栏文章 / 想法 + 评论 + 图片）
//
// 执行入口：POST /sessions/:sid/scripts/zhihu
//   body: { args: { url: "https://www.zhihu.com/question/.../answer/..." } }
//
// 支持的 url 类型（自动识别）：
//   问题页      https://www.zhihu.com/question/{qid}                → 标题 + 问题补充 + 多个回答
//   单条回答    https://www.zhihu.com/question/{qid}/answer/{aid}   → 标题 + 该回答（含更多回答）
//   专栏文章    https://zhuanlan.zhihu.com/p/{pid}                  → 标题 + 正文
//   想法 / Pin  https://www.zhihu.com/pin/{pid}                     → 想法正文
//
// 每条内容都尽量给全：正文纯文本、正文图片（原图链接/尺寸/caption）、作者、赞同数、
// 评论数、永久链接、发布/编辑时间，以及评论（顶层 + 嵌套子回复，走知乎 comment_v5 API
// 在页面内 fetch，自动带登录 cookie）。
//
// 图片：知乎图床 *.zhimg.com 公开可取（裸 curl 即可，无需登录），所以默认只回链接不下载；
// 传 downloadImages=true 时把原图落到 downloads/（可经 HTTP /runs/:id/files 取回）。
//
// 知乎对未登录用户有内容墙。脚本会尽力关掉登录弹窗；若仍被拦截 loginWall=true，
// 请先 `npm run zhihu-login` 登录，cookie 留在 USER_DATA_DIR 后续自动复用。
//
// 产物：page.png / page.html / result.json / stage-*.{png,html}（+ downloadImages 时的 img-*）

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'patchright';
import type { Run } from '../src/runs/run.js';

export const meta = {
  description: '抓取知乎问答/专栏/想法的正文、图片与评论（顶层+嵌套回复），结构化返回',
  argsExample: { url: 'https://www.zhihu.com/question/19550225', maxAnswers: 20, comments: true },
};

interface ZhihuArgs {
  /** 知乎链接（问题 / 回答 / 专栏 / 想法） */
  url?: string;
  /** 问题页最多抓多少条回答（滚动加载），默认 20 */
  maxAnswers?: number;
  /** 滚动加载安全上限，默认 60 */
  maxScrolls?: number;
  /** 是否在每条结果里附带正文 HTML（默认 false） */
  includeHtml?: boolean;
  /** 是否抓评论（默认 true） */
  comments?: boolean;
  /** 每条内容最多抓多少顶层评论，默认 20 */
  maxComments?: number;
  /** 每条顶层评论最多抓多少子回复，默认 20 */
  maxReplies?: number;
  /** 是否把正文图片原图下载到 downloads/（默认 false，仅回链接） */
  downloadImages?: boolean;
}

type PageType = 'question' | 'answer' | 'article' | 'pin' | 'unknown';

interface ZhihuImage {
  url: string;
  width?: number;
  height?: number;
  caption?: string;
}

interface ZhihuComment {
  id: string;
  author: string;
  authorUrl?: string;
  content: string;
  images?: string[];
  likeCount?: number;
  createdTime?: string;
  /** 子回复回复的目标用户名（仅子回复有） */
  replyTo?: string;
  /** 该顶层评论的子回复（嵌套） */
  children?: ZhihuComment[];
}

interface ZhihuItem {
  type: 'answer' | 'article' | 'pin';
  id?: string;
  author: string;
  authorUrl?: string;
  authorHeadline?: string;
  authorAvatar?: string;
  content: string;
  contentHtml?: string;
  images: ZhihuImage[];
  voteCount?: number;
  commentCount?: number;
  url?: string;
  createdTime?: string;
  comments: ZhihuComment[];
}

export interface ZhihuOutput {
  pageType: PageType;
  title: string;
  questionDetail?: string;
  questionDetailImages?: ZhihuImage[];
  url: string;
  finalUrl: string;
  loggedIn: boolean;
  loginWall: boolean;
  itemCount: number;
  items: ZhihuItem[];
  durationMs: number;
}

/** 把 "1.2万" / "1,234" / "赞同 345" 这类计数文本解析成数字 */
function parseCount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/[,\s]/g, '');
  const m = t.match(/([\d.]+)\s*(万|亿|k|w)?/i);
  if (!m) return undefined;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '万' || unit === 'w') n *= 10_000;
  else if (unit === '亿') n *= 100_000_000;
  else if (unit === 'k') n *= 1_000;
  return Math.round(n);
}

function detectPageType(url: string): PageType {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith('zhuanlan.')) return 'article';
    if (/\/p\/\d+/.test(u.pathname)) return 'article';
    if (/\/pin\/\d+/.test(u.pathname)) return 'pin';
    if (/\/question\/\d+\/answer\/\d+/.test(u.pathname)) return 'answer';
    if (/\/question\/\d+/.test(u.pathname)) return 'question';
  } catch { /* ignore */ }
  return 'unknown';
}

/** 从永久链接解析评论 API 需要的资源类型 + id */
function parseResource(url: string | undefined, type: ZhihuItem['type']): { resourceType: string; id: string } | null {
  if (!url) return null;
  let m: RegExpMatchArray | null;
  if (type === 'answer' && (m = url.match(/\/answer\/(\d+)/))) return { resourceType: 'answers', id: m[1] };
  if (type === 'article' && (m = url.match(/\/p\/(\d+)/))) return { resourceType: 'articles', id: m[1] };
  if (type === 'pin' && (m = url.match(/\/pin\/(\d+)/))) return { resourceType: 'pins', id: m[1] };
  return null;
}

// 阶段诊断快照 —— 只在 debug run 落盘（stage-*.png/html 体积大，平时堆满磁盘）。
async function snap(page: Page, run: Run, tag: string) {
  if (!run.debug) return;
  try { await run.writeArtifact(`stage-${tag}.png`, await page.screenshot({ fullPage: true })); } catch { /* ignore */ }
  try { await run.writeArtifact(`stage-${tag}.html`, await page.content()); } catch { /* ignore */ }
  run.log.info(`stage=${tag} url=${page.url()}`);
}

/** 关掉知乎登录引导弹窗 / 顶部 App 横幅（尽力而为） */
async function dismissLoginModal(page: Page, run: Run) {
  try {
    await page.evaluate(() => {
      (Array.from(document.querySelectorAll('button.Modal-closeButton, .Modal-closeButton, [aria-label="关闭"]')) as HTMLElement[])
        .forEach((b) => b.click());
      document.querySelectorAll('.Modal-wrapper, .signFlowModal, .Modal-backdrop').forEach((el) => el.remove());
      document.querySelectorAll('.OpenInAppButton, .TopstoryPageHeader-OpenInAppButton').forEach((el) => el.remove());
    });
    await page.keyboard.press('Escape').catch(() => { /* ignore */ });
  } catch (e) {
    run.log.debug(`dismissLoginModal: ${e instanceof Error ? e.message : e}`);
  }
}

/** 展开所有「阅读全文」，否则 innerText 拿不到完整正文 */
async function expandAll(page: Page) {
  try {
    await page.evaluate(() => {
      (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[])
        .filter((b) => /阅读全文|展开阅读全文|显示全部|展开全部/.test(b.textContent || ''))
        .forEach((b) => b.click());
    });
  } catch { /* ignore */ }
}

/** 问题页：滚动加载更多回答 */
async function scrollToLoad(page: Page, run: Run, maxAnswers: number, maxScrolls: number) {
  let prev = 0;
  let stable = 0;
  for (let i = 0; i < maxScrolls; i++) {
    const count = await page.evaluate(() => document.querySelectorAll('.List-item, .AnswerItem').length).catch(() => 0);
    if (count >= maxAnswers) { run.log.info(`已加载 ${count} 条回答（达到 maxAnswers=${maxAnswers}）`); break; }
    if (count === prev) { if (++stable >= 2) { run.log.info(`回答数量稳定在 ${count}，停止滚动`); break; } }
    else stable = 0;
    prev = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_200);
    await expandAll(page);
  }
}

/** 在页面内抓正文/图片/作者等（DOM） */
async function extractContent(page: Page, pageType: PageType, includeHtml: boolean) {
  await page.evaluate('window.__name = window.__name || function(fn){return fn;};');
  return await page.evaluate((opts) => {
    const { pageType, includeHtml } = opts as { pageType: PageType; includeHtml: boolean };
    type PageType = 'question' | 'answer' | 'article' | 'pin' | 'unknown';

    const txt = (el: Element | null | undefined): string =>
      (el ? ((el as HTMLElement).innerText || el.textContent || '') : '').replace(/ /g, ' ').trim();
    const abs = (href: string | null | undefined): string | undefined => {
      if (!href) return undefined;
      try { return new URL(href, location.href).href; } catch { return href; }
    };
    const firstText = (root: ParentNode, sels: string[]): string => {
      for (const s of sels) { const v = txt(root.querySelector(s)); if (v) return v; }
      return '';
    };
    const intAttr = (el: Element, name: string): number | undefined => {
      const v = parseInt(el.getAttribute(name) || '', 10);
      return Number.isFinite(v) ? v : undefined;
    };

    type Img = { url: string; width?: number; height?: number; caption?: string };
    const extractImages = (contentEl: Element | null): Img[] => {
      if (!contentEl) return [];
      const out: Img[] = [];
      const seen = new Set<string>();
      for (const img of Array.from(contentEl.querySelectorAll('img')) as HTMLImageElement[]) {
        if (img.classList.contains('ztext-math')) continue; // LaTeX 公式，不是真图
        let src = img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.currentSrc || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        const base = src.split('?')[0];
        if (seen.has(base)) continue;
        seen.add(base);
        const fig = img.closest('figure');
        const caption = fig ? txt(fig.querySelector('figcaption')) : '';
        out.push({
          url: abs(src) || src,
          // 用 || 而非 ??：lazy 图未解码时 naturalWidth=0，应视作“未知”(undefined) 而非 0
          width: intAttr(img, 'data-rawwidth') || img.naturalWidth || undefined,
          height: intAttr(img, 'data-rawheight') || img.naturalHeight || undefined,
          caption: caption || undefined,
        });
      }
      return out;
    };

    const loggedIn = !!document.querySelector('.AppHeader-profileAvatar, [class*="AppHeader-profile"], img.Avatar.AppHeader-profileAvatar');
    const loginWall = !!document.querySelector('.signFlowModal, .Modal-wrapper .SignContainer, .Login-content, [class*="SignFlow"]');

    const title = firstText(document, ['.QuestionHeader-title', '.Post-Title', 'h1.Post-Title', '.PinItem .ContentItem-title', 'h1']);

    let questionDetail = '';
    let questionDetailImages: Img[] = [];
    if (pageType === 'question' || pageType === 'answer') {
      const qd = document.querySelector('.QuestionRichText .RichText, .QuestionHeader-detail .RichText, .QuestionRichText');
      questionDetail = txt(qd);
      questionDetailImages = extractImages(qd);
    }

    type RawItem = {
      type: 'answer' | 'article' | 'pin';
      author: string; authorUrl?: string; authorHeadline?: string; authorAvatar?: string;
      content: string; contentHtml?: string; images: Img[];
      voteRaw?: string; commentRaw?: string;
      url?: string; createdTime?: string;
    };

    const extractOne = (root: ParentNode, type: RawItem['type']): RawItem | null => {
      const contentEl =
        root.querySelector('.RichContent-inner .RichText') ||
        root.querySelector('.RichText.ztext') ||
        root.querySelector('.RichText') ||
        root.querySelector('.Post-RichTextContainer');
      const content = txt(contentEl);
      if (!content) return null;

      const authorLink = root.querySelector('.AuthorInfo-name a, .UserLink-link, .AuthorInfo .UserLink-link') as HTMLAnchorElement | null;
      const author = firstText(root, ['.AuthorInfo-name', '.AuthorInfo .UserLink', '.AuthorInfo']) || '匿名用户';
      const authorHeadline = firstText(root, ['.AuthorInfo-badgeText', '.RichText.ztext.AuthorInfo-badgeText']);
      const avatarImg = root.querySelector('.AuthorInfo .Avatar, .AuthorInfo img.Avatar') as HTMLImageElement | null;
      const authorAvatar = avatarImg ? abs(avatarImg.getAttribute('src') || avatarImg.getAttribute('data-original')) : undefined;

      const voteEl = root.querySelector('.VoteButton--up, button.VoteButton, .Button.VoteButton--up') || root.querySelector('[aria-label*="赞同"]');
      const voteRaw = (voteEl?.getAttribute('aria-label') || txt(voteEl) || '').replace(/赞同|喜欢/g, '').trim() || undefined;
      const commentBtn = Array.from(root.querySelectorAll('button, a')).find((b) => /条评论|添加评论|评论$/.test((b.textContent || '').trim()));
      const commentRaw = commentBtn ? (commentBtn.textContent || '').trim() : undefined;

      // 永久链接：回答时间链接 → meta → 正文外的 /answer/（itemprop=url 的 <a> 是作者主页，正文内 /answer/ 可能指向别的问题）
      let url: string | undefined;
      const timeLink = root.querySelector('.ContentItem-time a[href*="/answer/"]') as HTMLAnchorElement | null;
      if (timeLink) url = abs(timeLink.getAttribute('href'));
      if (!url) {
        const c = root.querySelector('meta[itemprop="url"]')?.getAttribute('content') || '';
        if (/\/(answer|p)\/\d+/.test(c)) url = abs(c);
      }
      if (!url) {
        const cand = (Array.from(root.querySelectorAll('a[href*="/answer/"]')) as HTMLAnchorElement[]).find((a) => !a.closest('.RichText'));
        if (cand) url = abs(cand.getAttribute('href'));
      }
      if (!url && type === 'article') url = location.href;

      const createdTime = txt(root.querySelector('.ContentItem-time, .ContentItem-time span')) || undefined;

      const item: RawItem = {
        type, author, authorUrl: abs(authorLink?.getAttribute('href')), authorHeadline: authorHeadline || undefined,
        authorAvatar, content, images: extractImages(contentEl), voteRaw, commentRaw, url, createdTime,
      };
      if (includeHtml && contentEl) item.contentHtml = (contentEl as HTMLElement).innerHTML;
      return item;
    };

    const items: RawItem[] = [];
    if (pageType === 'article') { const o = extractOne(document, 'article'); if (o) items.push(o); }
    else if (pageType === 'pin') { const o = extractOne(document, 'pin'); if (o) items.push(o); }
    else {
      const cards = Array.from(document.querySelectorAll('.List-item, .AnswerItem'));
      for (const card of (cards.length ? cards : [document])) { const o = extractOne(card as ParentNode, 'answer'); if (o) items.push(o); }
    }

    const seen = new Set<string>();
    const dedup: RawItem[] = [];
    for (const it of items) {
      // 永久链接缺失时（如登录墙）退回 作者+较长正文前缀，避免不同回答因 80 字开头雷同被误删
      const key = it.url || `${it.author}::${it.content.slice(0, 160)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(it);
    }

    return { title, questionDetail, questionDetailImages, loggedIn, loginWall, items: dedup };
  }, { pageType, includeHtml });
}

/** 在页面内走 comment_v5 API 抓评论（顶层 + 嵌套子回复），自动带登录 cookie */
async function fetchComments(
  page: Page, resourceType: string, resourceId: string,
  maxRoot: number, maxChild: number,
): Promise<{ comments: ZhihuComment[]; error?: string }> {
  return await page.evaluate(async (p) => {
    const { resourceType, resourceId, maxRoot, maxChild } = p as { resourceType: string; resourceId: string; maxRoot: number; maxChild: number };
    const headers: Record<string, string> = { 'x-requested-with': 'fetch', accept: 'application/json, text/plain, */*' };

    type C = { id: string; author: string; authorUrl?: string; content: string; images?: string[]; likeCount?: number; createdTime?: string; replyTo?: string; children?: C[]; _childCount?: number };

    const stripHtml = (html: string): { text: string; images: string[] } => {
      const d = document.createElement('div');
      d.innerHTML = html || '';
      const images = (Array.from(d.querySelectorAll('img')) as HTMLImageElement[])
        .map((i) => i.getAttribute('data-original') || i.getAttribute('src') || '')
        .filter((s) => s && !s.startsWith('data:'));
      return { text: (d.textContent || '').replace(/\s+/g, ' ').trim(), images };
    };
    const mapC = (c: any): C => {
      const a = c.author || {};
      const m = a.member || a;
      const { text, images } = stripHtml(c.content || '');
      const rt = c.reply_to_author || {};
      const rtm = rt.member || rt;
      return {
        id: String(c.id ?? ''),
        author: m.name || '匿名用户',
        authorUrl: m.url ? (m.url.startsWith('http') ? m.url : `https://www.zhihu.com/people/${m.url_token || ''}`) : undefined,
        content: text,
        images: images.length ? images : undefined,
        likeCount: typeof c.like_count === 'number' ? c.like_count : undefined,
        createdTime: c.created_time ? new Date(c.created_time * 1000).toISOString() : undefined,
        replyTo: rtm.name || undefined,
        _childCount: typeof c.child_comment_count === 'number' ? c.child_comment_count : 0,
      };
    };

    const getJson = async (url: string): Promise<any | null> => {
      try {
        const r = await fetch(url, { headers, credentials: 'include' });
        if (!r.ok) return { __status: r.status };
        return await r.json();
      } catch { return null; }
    };

    const out: C[] = [];
    const rootSeen = new Set<string>();
    let firstErr: string | undefined;
    let next = `https://www.zhihu.com/api/v4/comment_v5/${resourceType}/${resourceId}/root_comment?order_by=score&limit=20&offset=0`;
    let guard = 0;
    while (next && out.length < maxRoot && guard++ < 20) {
      const j = await getJson(next);
      if (!j) { firstErr = firstErr || 'network'; break; }
      if (j.__status) { firstErr = firstErr || `http ${j.__status}`; break; }
      const rootData = j.data || [];
      if (!rootData.length) break; // 没数据就停，别靠 guard 空转
      for (const raw of rootData) {
        if (out.length >= maxRoot) break;
        const c = mapC(raw);
        const childCount = c._childCount || 0;
        delete c._childCount;
        c.children = [];
        // paging.next 偶尔回放同一页，按 id 去重；id 缺失时不参与去重（否则空 id 会互相坍缩）
        if (c.id && rootSeen.has(c.id)) continue;
        if (c.id) rootSeen.add(c.id);
        if (maxChild > 0) {
          // 先收内联子回复（即便 child_comment_count 缺失/为 0 也别丢）
          const seen = new Set<string>();
          for (const cc of (raw.child_comments || [])) {
            const m = mapC(cc); delete m._childCount;
            if (!seen.has(m.id)) { seen.add(m.id); c.children.push(m); }
          }
          // 仅当计数表明还有更多子回复时才翻页拉取（避免给零子回复评论发无谓请求）
          if (childCount > c.children.length) {
            let cnext: string | null = `https://www.zhihu.com/api/v4/comment_v5/comment/${c.id}/child_comment?order_by=ts&limit=20&offset=0`;
            let cg = 0;
            while (c.children.length < Math.min(childCount, maxChild) && cnext && cg++ < 10) {
              const cj = await getJson(cnext);
              if (!cj || cj.__status) break;
              for (const cc of (cj.data || [])) {
                const m = mapC(cc); delete m._childCount;
                if (!seen.has(m.id)) { seen.add(m.id); c.children.push(m); }
              }
              if (cj.paging?.is_end || !(cj.data || []).length) break;
              cnext = cj.paging?.next || null;
            }
          }
          c.children = c.children.slice(0, maxChild);
        }
        out.push(c);
      }
      if (j.paging?.is_end) break;
      next = j.paging?.next || '';
    }
    return { comments: out as any, error: firstErr };
  }, { resourceType, resourceId, maxRoot, maxChild });
}

/** 下载一批图片到 downloads/（仅 downloadImages=true 时）；图床公开，普通 fetch 即可 */
async function downloadImages(page: Page, urls: string[], run: Run): Promise<void> {
  let n = 0;
  for (const url of urls) {
    try {
      const data = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'omit' });
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return btoa(bin);
      }, url);
      if (!data) continue;
      const ext = (url.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i)?.[1] || 'jpg').toLowerCase();
      // 写到 downloads/（经 HTTP /runs/:id/files 暴露、CLI 自动抓回），不是 run.dir 私有产物
      await writeFile(join(run.downloadsDir, `img-${String(n).padStart(3, '0')}.${ext}`), Buffer.from(data, 'base64'));
      n++;
    } catch (e) {
      run.log.debug(`download image failed ${url}: ${e instanceof Error ? e.message : e}`);
    }
  }
  run.log.info(`下载图片 ${n}/${urls.length} 张`);
}

export async function runInSession(page: Page, args: unknown, run: Run): Promise<ZhihuOutput> {
  const a: ZhihuArgs = typeof args === 'string' ? { url: args } : ((args as ZhihuArgs) ?? {});
  const url = a.url?.trim();
  if (!url || !/^https?:\/\//.test(url)) throw new Error('zhihu: args.url 必填，且需为 http(s) 链接');

  const maxAnswers = Math.max(1, a.maxAnswers ?? 20);
  const maxScrolls = Math.max(1, a.maxScrolls ?? 60);
  const includeHtml = a.includeHtml === true;
  const wantComments = a.comments !== false;
  const maxComments = Math.max(0, a.maxComments ?? 20);
  const maxReplies = Math.max(0, a.maxReplies ?? 20);
  const wantDownload = a.downloadImages === true;

  const pageType = detectPageType(url);
  run.log.info(`抓取 ${pageType} 页: ${url}`);
  const t0 = Date.now();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => { /* ignore */ });
  await snap(page, run, '01-loaded');

  await dismissLoginModal(page, run);
  await page.waitForTimeout(800);
  if (pageType === 'question') await scrollToLoad(page, run, maxAnswers, maxScrolls);
  await expandAll(page);
  await page.waitForTimeout(500);
  await dismissLoginModal(page, run);
  await snap(page, run, '02-ready');

  const raw = await extractContent(page, pageType, includeHtml);

  let items: ZhihuItem[] = raw.items.map((it) => {
    const res = parseResource(it.url, it.type);
    return {
      type: it.type,
      id: res?.id,
      author: it.author,
      authorUrl: it.authorUrl,
      authorHeadline: it.authorHeadline || undefined,
      authorAvatar: it.authorAvatar || undefined,
      content: it.content,
      contentHtml: it.contentHtml,
      images: it.images,
      voteCount: parseCount(it.voteRaw),
      commentCount: parseCount(it.commentRaw),
      url: it.url,
      createdTime: it.createdTime,
      comments: [],
    };
  });
  if (pageType === 'question' && items.length > maxAnswers) items = items.slice(0, maxAnswers);

  // 评论：逐条走 API 抓（顶层 + 嵌套子回复）
  if (wantComments && maxComments > 0) {
    for (const it of items) {
      const res = parseResource(it.url, it.type);
      if (!res) continue;
      const { comments, error } = await fetchComments(page, res.resourceType, res.id, maxComments, maxReplies);
      it.comments = comments;
      if (error) run.log.warn(`评论抓取 ${res.resourceType}/${res.id} 部分失败: ${error}`);
    }
    const total = items.reduce((s, it) => s + it.comments.length + it.comments.reduce((x, c) => x + (c.children?.length || 0), 0), 0);
    run.log.info(`评论抓取完成，共 ${total} 条（含子回复）`);
  }

  // 图片下载（可选）
  if (wantDownload) {
    const all = [...(raw.questionDetailImages || []), ...items.flatMap((it) => it.images)].map((i) => i.url);
    await downloadImages(page, Array.from(new Set(all)), run);
  }

  // 结果页 page.png/html 是诊断产物 —— 只 debug run 落盘；result.json + downloads/ 始终保留。
  if (run.debug) {
    await run.writeArtifact('page.png', await page.screenshot({ fullPage: true }));
    await run.writeArtifact('page.html', await page.content());
  }

  const output: ZhihuOutput = {
    pageType,
    title: raw.title,
    questionDetail: raw.questionDetail || undefined,
    questionDetailImages: raw.questionDetailImages?.length ? raw.questionDetailImages : undefined,
    url,
    finalUrl: page.url(),
    loggedIn: raw.loggedIn,
    loginWall: raw.loginWall && !raw.loggedIn,
    itemCount: items.length,
    items,
    durationMs: Date.now() - t0,
  };
  await run.writeArtifact('result.json', JSON.stringify({ runId: run.runId, ...output }, null, 2));
  const imgTotal = (output.questionDetailImages?.length || 0) + items.reduce((s, it) => s + it.images.length, 0);
  run.log.info(
    `done in ${output.durationMs}ms, ${items.length} 条内容, ${imgTotal} 张图` +
    `${output.loginWall ? '（疑似被登录墙拦截，建议先 npm run zhihu-login）' : ''}`,
  );
  return output;
}
