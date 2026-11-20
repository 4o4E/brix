import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { domainToASCII } from 'node:url';
import { z } from 'zod';

const VALID_MS = 30 * 24 * 60 * 60 * 1000;
const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const sessionId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const hostname = z.string().trim().min(1).max(253).regex(/^[\p{L}\p{N}.-]+$/u)
  .transform((value) => domainToASCII(value.replace(/\.$/, '')).toLowerCase())
  .refine((host) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(host), '需要精确 hostname');
const path = z.string().max(512).regex(/^\/(?:[A-Za-z0-9._~%-]+\/)*[A-Za-z0-9._~%-]*$/)
  .refine((value) => !/(?:\/(?:\.|\.\.)(?:\/|$)|%(?![a-f0-9]{2})|%(?:2e|2f|5c|3f|23))/i.test(value), '使用不含查询、片段或转义分隔符的页面路径');
// 这里只拒绝明显粘贴的凭据、代码和内联数据；提交者仍须在提交前脱敏。
const text = z.string().trim().min(1).max(800).refine((value) => !/(?:```|<\/?(?:script|html|body)\b|data:[^,\s]+;base64,|(?:authorization|(?:set-)?cookie|x-brix-token)\s*:|\bBearer\s+\S{8,}|https?:\/\/\S*[?#])/i.test(value), '只上传脱敏摘要');
const conditions = z.object({
  language: z.string().regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/).max(35).transform((value) => value.toLowerCase()).optional(),
  device: z.enum(['desktop', 'mobile']).optional(),
  auth: z.enum(['signed-in', 'signed-out']).optional(),
  variant: key.optional(),
}).strict();

export const querySchema = z.object({ hostname, path, task: key, conditions: conditions.default({}) }).strict();
const scopeSchema = querySchema.extend({ mode: z.enum(['exact', 'prefix']).default('exact') });
const evidenceSchema = z.object({ sessionId, page: querySchema, expected: text, observed: text }).strict();
const confirmedEvidence = evidenceSchema.extend({ ready: z.literal(true) });
const idSchema = z.string().uuid();
const versionSchema = z.number().int().positive();
const noteSchema = z.object({
  scope: scopeSchema, advice: text, check: text, invalidWhen: text, expiresAt: z.string().datetime().optional(),
  evidence: confirmedEvidence,
}).strict();
export const publishSchema = z.union([noteSchema, noteSchema.extend({ id: idSchema, ifVersion: versionSchema })]);
const reportBase = z.object({ version: versionSchema, evidence: confirmedEvidence }).strict();
export const feedbackSchema = z.discriminatedUnion('kind', [
  reportBase.extend({ kind: z.literal('verified') }),
  reportBase.extend({ kind: z.literal('temporary_failure'), evidence: evidenceSchema }),
  reportBase.extend({ kind: z.literal('withdrawn'), evidence: evidenceSchema }),
  reportBase.extend({ kind: z.literal('contradicted'), issue: key }),
  reportBase.extend({ kind: z.literal('resolved'), issue: key, resolution: text }),
]);
const storedVersion = noteSchema.extend({ version: versionSchema, createdAt: z.number(), feedback: z.array(z.object({ at: z.number(), report: feedbackSchema }).strict()) });
const databaseSchema = z.object({ format: z.literal(1), notes: z.array(z.object({ id: idSchema, versions: z.array(storedVersion).min(1) }).strict()) }).strict();
type Database = z.output<typeof databaseSchema>;
type Revision = z.output<typeof storedVersion>;
type Query = z.output<typeof querySchema>;
type Scope = z.output<typeof scopeSchema>;
type Report = z.output<typeof feedbackSchema>;
type Evidence = z.output<typeof evidenceSchema>;

export class ExperienceError extends Error {
  constructor(readonly code: string, readonly status: number, readonly currentVersion?: number) { super(code); }
}

function matches(scope: Scope, page: Query, ignoreConditions = false): boolean {
  if (scope.hostname !== page.hostname || scope.task !== page.task) return false;
  if (scope.path !== page.path && (scope.mode !== 'prefix' || !page.path.startsWith(scope.path.endsWith('/') ? scope.path : `${scope.path}/`))) return false;
  return ignoreConditions || Object.entries(scope.conditions).every(([k, value]) => page.conditions[k as keyof Query['conditions']] === value);
}

function samePage(a: Query, b: Query): boolean {
  return a.hostname === b.hostname && a.path === b.path && a.task === b.task
    && Object.keys(a.conditions).length === Object.keys(b.conditions).length
    && Object.entries(a.conditions).every(([k, value]) => b.conditions[k as keyof Query['conditions']] === value);
}
function conflictKey(report: Extract<Report, { kind: 'contradicted' | 'resolved' }>): string {
  const { hostname, path, task, conditions } = report.evidence.page;
  return JSON.stringify([report.issue, hostname, path, task, conditions]);
}

function assess(revision: Revision, now: number) {
  let lastVerifiedAt = revision.createdAt;
  let withdrawn = false;
  const issues = new Map<string, { evidence: Evidence[]; conflicting: boolean }>();
  for (const { at, report } of revision.feedback) {
    if (report.kind === 'withdrawn') withdrawn = true;
    if (report.kind === 'contradicted') {
      const key = conflictKey(report);
      const issue = issues.get(key);
      if (issue) issue.evidence.push(report.evidence);
      else issues.set(key, { evidence: [report.evidence], conflicting: false });
    }
    if (report.kind === 'resolved') {
      issues.delete(conflictKey(report));
      if (!issues.size) lastVerifiedAt = at;
    }
    if (report.kind === 'verified') {
      if (!issues.size) lastVerifiedAt = at;
      for (const issue of issues.values()) {
        if (issue.evidence.some(({ page }) => samePage(page, report.evidence.page))) issue.conflicting = true;
      }
    }
  }
  const validUntil = Math.min(lastVerifiedAt + VALID_MS, revision.expiresAt === undefined ? Infinity : Date.parse(revision.expiresAt));
  const status = withdrawn ? 'withdrawn'
    : now >= validUntil || [...issues.values()].some(({ evidence, conflicting }) => !conflicting && new Set(evidence.map(({ sessionId }) => sessionId)).size >= 2) ? 'stale'
      : issues.size ? 'review' : 'active';
  return { status, lastVerifiedAt, validUntil, issues };
}

function view(revision: Revision, now: number, latest = true) {
  const { status, lastVerifiedAt, validUntil } = assess(revision, now);
  return { status: latest ? status : 'superseded', lastVerifiedAt, validUntil };
}

export class ExperienceStore {
  #state?: Database;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, private readonly clock = Date.now) {}

  async #load(): Promise<Database> {
    if (this.#state) return this.#state;
    try { this.#state = databaseSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#state = { format: 1, notes: [] };
    }
    return this.#state;
  }

  // 读写共用队列；先原子落盘再切换内存状态，失败不会污染下次读取。
  #operate<T>(fn: (database: Database) => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(async () => fn(await this.#load()));
    this.#tail = result.then(() => {}, () => {});
    return result;
  }

  async #save(database: Database): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, '.experiences-'));
    try {
      const pending = join(dir, 'store.json');
      await writeFile(pending, JSON.stringify(database), { mode: 0o600 });
      await rename(pending, this.path);
      this.#state = database;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  search(query: Query) {
    return this.#operate(({ notes }) => {
      const now = this.clock();
      return notes.flatMap(({ id, versions }) => {
        const current = versions.at(-1)!;
        if (!matches(current.scope, query)) return [];
        const status = view(current, now);
        if (status.status !== 'active') return [];
        const { version, scope, advice, check, invalidWhen } = current;
        return [{ id, version, scope, advice, check, invalidWhen, ...status }];
      }).sort((a, b) => Number(b.scope.mode === 'exact') - Number(a.scope.mode === 'exact')
        || b.scope.path.length - a.scope.path.length
        || Object.keys(b.scope.conditions).length - Object.keys(a.scope.conditions).length
        || b.lastVerifiedAt - a.lastVerifiedAt || a.id.localeCompare(b.id)).slice(0, 3);
    });
  }

  show(id: string) {
    return this.#operate(({ notes }) => {
      const note = notes.find((item) => item.id === id);
      if (!note) throw new ExperienceError('not_found', 404);
      const now = this.clock();
      return { id, versions: note.versions.map((revision, i) => ({ ...revision, ...view(revision, now, i === note.versions.length - 1) })) };
    });
  }

  publish(input: z.output<typeof publishSchema>) {
    return this.#operate(async (database) => {
      const now = this.clock();
      if (!matches(input.scope, input.evidence.page)) throw new ExperienceError('evidence_out_of_scope', 400);
      if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= now) throw new ExperienceError('expired_experience', 400);
      const isRevision = 'id' in input;
      const { scope, advice, check, invalidWhen, expiresAt, evidence } = input;
      const duplicate = database.notes.find((item) => {
        const current = item.versions.at(-1)!;
        return current.advice === advice && current.scope.mode === scope.mode && samePage(current.scope, scope);
      });
      const id = isRevision ? input.id : randomUUID();
      if (duplicate && duplicate.id !== id) throw new ExperienceError('duplicate_experience', 409, duplicate.versions.at(-1)!.version);
      const note = isRevision ? database.notes.find((item) => item.id === id) : undefined;
      if (isRevision && !note) throw new ExperienceError('not_found', 404);
      const current = note?.versions.at(-1);
      if (isRevision && input.ifVersion !== current!.version) throw new ExperienceError('version_conflict', 409, current!.version);
      if (current && duplicate?.id === id && current.check === check && current.invalidWhen === invalidWhen && current.expiresAt === expiresAt) {
        throw new ExperienceError('unchanged_experience', 409, current.version);
      }
      const revision: Revision = { version: (current?.version ?? 0) + 1, scope, advice, check, invalidWhen, expiresAt, evidence, createdAt: now, feedback: [] };
      const changed = { id, versions: [...(note?.versions ?? []), revision] };
      await this.#save({ format: 1, notes: note ? database.notes.map((item) => item === note ? changed : item) : [...database.notes, changed] });
      return { id, version: revision.version, ...view(revision, now) };
    });
  }

  report(id: string, report: Report) {
    return this.#operate(async (database) => {
      const note = database.notes.find((item) => item.id === id);
      const revision = note?.versions.find((item) => item.version === report.version);
      if (!note || !revision) throw new ExperienceError('not_found', 404);
      if (!matches(revision.scope, report.evidence.page, report.kind === 'temporary_failure')) throw new ExperienceError('evidence_out_of_scope', 400);
      const now = this.clock();
      const latest = revision === note.versions.at(-1);
      const result = (current: Revision) => ({ id, version: current.version, ...view(current, now, latest) });
      if (revision.feedback.some(({ report: previous }) => previous.kind === report.kind && previous.evidence.sessionId === report.evidence.sessionId
        && samePage(previous.evidence.page, report.evidence.page)
        && (!('issue' in report) || ('issue' in previous && previous.issue === report.issue)))) return result(revision);
      if (report.kind === 'verified' && revision.evidence.sessionId === report.evidence.sessionId) return result(revision);
      if (report.kind === 'resolved') {
        const issue = assess(revision, now).issues.get(conflictKey(report));
        if (!issue || issue.evidence.some((other) => other.sessionId === report.evidence.sessionId)) {
          throw new ExperienceError('resolution_needs_matching_new_observation', 400);
        }
      }
      const updated = { ...revision, feedback: [...revision.feedback, { at: now, report }] };
      const changed = { ...note, versions: note.versions.map((item) => item === revision ? updated : item) };
      await this.#save({ format: 1, notes: database.notes.map((item) => item === note ? changed : item) });
      return result(updated);
    });
  }
}
