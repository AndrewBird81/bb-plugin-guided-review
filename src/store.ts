import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Guide } from "./guide";
import { sameLocation, type CommentLocation, type Discussion, type DiscussionEntry, type Draft, type DraftComment, type Verdict } from "./draft";
import { createHash, randomUUID } from "node:crypto";
import { defaultPreferences, preferencesSchema, type PreferencesRecord, type ReviewPreferences, type ReviewerNotesRecord } from "./preferences";
import type { AssessmentSummary, TurnSignals } from "../lib/turn";
import type { AssessmentItem, AssessmentRun, ReplyDraft } from "../lib/feedback";
import type { FeedbackThread } from "./github/types";
import { diffPositions } from "./review-positions";

export interface ReviewLifecycle {
  prState?: "OPEN" | "CLOSED" | "MERGED";
  archivedAt?: number | null;
  /** Archived by the reviewer. GitHub sync owns archivedAt and never changes this. */
  userArchivedAt?: number | null;
  submittedVerdict?: Verdict | null;
  submittedAt?: number | null;
  submittedHeadSha?: string | null;
  reviewer?: string | null;
  latestHeadSha?: string;
  /** What GitHub says about whose turn it is. */
  signals?: TurnSignals | null;
  /** "Not yet": hidden from Needs review until a newer signal. */
  snoozedAt?: number | null;
  /** The assistant's latest check of your feedback. */
  assessment?: AssessmentSummary | null;
  /** The signal that last alerted Needs You, so one event alerts once. */
  notifiedSignal?: string | null;
  /** The head commit the automatic re-review or check last ran for. */
  autoRunHead?: string | null;
  /** The group the review was last in, so leaving Needs review clears its alert. */
  turnGroup?: "needs" | "waiting" | "reviewed" | "archive" | null;
  /** An alert waiting for its re-review to be prepared. */
  pendingAlert?: { signal: string; since: number } | null;
  /** The assistant is checking your feedback, since this time. */
  verifyingSince?: number | null;
  /** When the automatic re-review or check last finished. */
  preparedAt?: number | null;
  /** Your latest review summaries, newest last, for the assistant. */
  reviewBodies?: Array<{ state: string; at: number; body: string }>;
}

export interface ReviewMeta extends ReviewLifecycle {
  targetKey: string;
  kind: "pr" | "ref";
  number?: number;
  repo?: string;
  title?: string;
  author?: string;
  base?: string;
  head?: string;
  gitRef?: string;
  url?: string;
  /** tracked: found on GitHub, with no guide yet. */
  status: "generating" | "ready" | "error" | "tracked";
  createdAt: number;
  projectId?: string;
  headSha?: string;
  cwd?: string;
}

export interface FileView {
  file: string;
  hash: string;
  viewedAt: number;
}

export interface AgentMessageContext {
  file?: string;
  startLine?: number;
  endLine?: number;
  /** Which column a line range was picked on (new vs old file). */
  side?: "additions" | "deletions";
  code?: string;
  chapterId?: string;
}

export interface AgentMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  context: AgentMessageContext | null;
  createdAt: number;
}

export interface Store {
  getPreferences(): PreferencesRecord;
  savePreferences(preferences: ReviewPreferences, revision: number): PreferencesRecord;
  getReviewerNotes(targetKey: string): ReviewerNotesRecord;
  saveReviewerNotes(targetKey: string, body: string, revision: number): ReviewerNotesRecord;
  saveReview(meta: ReviewMeta): void;
  getReview(targetKey: string): ReviewMeta | null;
  listReviews(): ReviewMeta[];
  setStatus(targetKey: string, status: ReviewMeta["status"]): void;
  setLifecycle(targetKey: string, state: ReviewLifecycle): void;
  /** Context for the assistant's automatic review, from `bb review --context`. */
  getReviewContext(targetKey: string): string | null;
  /** null removes it. */
  setReviewContext(targetKey: string, text: string | null): void;
  /** Remove the review and everything stored for it. */
  deleteReview(targetKey: string): void;
  savePatch(targetKey: string, patch: string): void;
  readPatch(targetKey: string, offset?: number, limit?: number): { text: string; total: number };
  saveGuide(targetKey: string, guide: Guide): void;
  getGuide(targetKey: string): Guide | null;
  beginGeneration(targetKey: string): string;
  isCurrentGeneration(targetKey: string, generationId: string): boolean;
  interruptGenerations(): void;
  getDraft(targetKey: string): Draft;
  upsertDraftComment(targetKey: string, c: DraftComment): Draft;
  /** Change only a comment's text, keeping who added it and the diff it was drafted against. Null when there's no comment there. */
  editDraftComment(targetKey: string, at: CommentLocation, body: string): Draft | null;
  /** Null when there's no comment there. */
  deleteDraftComment(targetKey: string, at: CommentLocation): Draft | null;
  setVerdict(targetKey: string, verdict: Verdict, body: string): Draft;
  staleDraftComments(targetKey: string): DraftComment[];
  clearSubmittedDraft(draft: Draft): void;
  // Discussions with the review assistant at lines of the diff.
  listDiscussions(targetKey: string): Discussion[];
  /** A reviewer's message waits for the assistant; the assistant's answers it. */
  addDiscussionMessage(targetKey: string, at: CommentLocation, author: DiscussionEntry["author"], body: string, startLine?: number): void;
  /** Record an agent's change to the draft comment at a line that has a discussion, which answers it. */
  noteDiscussionChange(targetKey: string, at: CommentLocation, kind: "added" | "edited" | "removed"): void;
  deleteDiscussion(targetKey: string, at: CommentLocation): void;
  clearDiscussions(targetKey: string): void;
  /** Stop waiting for answers, for example once the assistant finishes. False when none were waiting. */
  stopWaiting(targetKey: string): boolean;
  // Per-file "Viewed" state (Feature 1).
  getFileViews(targetKey: string): FileView[];
  setFileViewed(targetKey: string, file: string, hash: string): void;
  unsetFileViewed(targetKey: string, file: string): void;
  // Legacy review-agent worker and plugin-stored chat log, read-only since
  // conversations moved into bb threads.
  getAgentThread(targetKey: string): string | null;
  clearAgentThread(targetKey: string): void;
  listAgentMessages(targetKey: string): AgentMessage[];
  clearAgentMessages(targetKey: string): void;
  // The hidden bb thread behind a review's assistant chat.
  getAssistantThread(targetKey: string): string | null;
  setAssistantThread(targetKey: string, threadId: string): void;
  clearAssistantThread(targetKey: string): void;
  listAssistantThreads(): Array<{ targetKey: string; threadId: string }>;
  // The PR's diff at commits you reviewed or the sync read, for "since your review".
  saveSnapshot(targetKey: string, headSha: string, patch: string): void;
  getSnapshot(targetKey: string, headSha: string): string | null;
  /** Keep only these heads' snapshots. */
  pruneSnapshots(targetKey: string, keep: readonly string[]): void;
  // Your review threads on the PR, as last read from GitHub.
  saveFeedbackThreads(targetKey: string, threads: FeedbackThread[], prUpdatedAt: number | null): void;
  listFeedbackThreads(targetKey: string): Array<FeedbackThread & { resolvedSeenAt: number | null }>;
  feedbackFetched(targetKey: string): { fetchedAt: number; prUpdatedAt: number | null } | null;
  // The assistant's check of your feedback, per head commit.
  saveAssessmentItems(targetKey: string, headSha: string, items: AssessmentItem[]): void;
  saveAssessmentRun(targetKey: string, run: AssessmentRun): void;
  getAssessment(targetKey: string, headSha: string): { items: AssessmentItem[]; run: AssessmentRun | null };
  /** The latest run for any head. */
  latestAssessmentRun(targetKey: string): AssessmentRun | null;
  // Replies to your threads, drafted here and posted only when you send them.
  setReplyDraft(targetKey: string, threadId: string, body: string, author: ReplyDraft["author"]): void;
  listReplyDrafts(targetKey: string): Map<string, ReplyDraft>;
  deleteReplyDraft(targetKey: string, threadId: string): void;
  // PRs you deleted from the list, which discovery mustn't add back.
  ignoreDiscovery(targetKey: string): void;
  unignoreDiscovery(targetKey: string): void;
  isDiscoveryIgnored(targetKey: string): boolean;
  /** The text a draft comment's line had when it was drafted. */
  draftCommentCode(targetKey: string, at: CommentLocation): string | undefined;
  /** Mark a draft comment as drafted against the current diff, at a possibly new line. */
  rebaseDraftComment(targetKey: string, at: CommentLocation, line: number): void;
}

export function createStore(bb: BbPluginApi): Store {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS reviews (
      target_key TEXT PRIMARY KEY, kind TEXT NOT NULL, number INTEGER, repo TEXT,
      title TEXT, author TEXT, base TEXT, head TEXT, git_ref TEXT, url TEXT,
      status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS patches (target_key TEXT PRIMARY KEY, patch TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS guides (target_key TEXT PRIMARY KEY, guide TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS drafts (target_key TEXT PRIMARY KEY, verdict TEXT NOT NULL, body TEXT NOT NULL, comments TEXT NOT NULL)`,
    `ALTER TABLE reviews ADD COLUMN project_id TEXT`,
    `ALTER TABLE reviews ADD COLUMN head_sha TEXT`,
    `ALTER TABLE reviews ADD COLUMN cwd TEXT`,
    `CREATE TABLE IF NOT EXISTS file_views (
      target_key TEXT NOT NULL, file TEXT NOT NULL,
      hash TEXT NOT NULL, viewed_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, file))`,
    `CREATE TABLE IF NOT EXISTS agent_threads (
      target_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL,
      role TEXT NOT NULL, text TEXT NOT NULL, context TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS generations (target_key TEXT PRIMARY KEY, generation_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS draft_comment_revisions (
      target_key TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      patch_hash TEXT NOT NULL, PRIMARY KEY (target_key, file, line, side))`,
    `CREATE TABLE IF NOT EXISTS review_lifecycle (target_key TEXT PRIMARY KEY, state TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_preferences (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL, revision INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS reviewer_notes (target_key TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS assistant_threads (target_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS review_context (target_key TEXT PRIMARY KEY, text TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS discussion_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL,
      file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, start_line INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS discussion_waits (
      target_key TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
      PRIMARY KEY (target_key, file, line, side))`,
    `CREATE TABLE IF NOT EXISTS review_snapshots (
      target_key TEXT NOT NULL, head_sha TEXT NOT NULL, patch TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, head_sha))`,
    `CREATE TABLE IF NOT EXISTS feedback_threads (
      target_key TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, resolved_seen_at INTEGER,
      PRIMARY KEY (target_key, thread_id))`,
    `CREATE TABLE IF NOT EXISTS feedback_fetches (target_key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, pr_updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS assessment_items (
      target_key TEXT NOT NULL, head_sha TEXT NOT NULL, item_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (target_key, head_sha, item_id))`,
    `CREATE TABLE IF NOT EXISTS assessment_runs (
      target_key TEXT NOT NULL, head_sha TEXT NOT NULL, data TEXT NOT NULL, assessed_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, head_sha))`,
    `CREATE TABLE IF NOT EXISTS reply_drafts (
      target_key TEXT NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (target_key, thread_id))`,
    `CREATE TABLE IF NOT EXISTS discovery_ignores (target_key TEXT PRIMARY KEY, ignored_at INTEGER NOT NULL)`,
    `ALTER TABLE draft_comment_revisions ADD COLUMN code TEXT`,
  ]);
  const at = (k: string, { file, line, side }: CommentLocation) => [k, file, line, side] as const;
  const hasDiscussion = (k: string, location: CommentLocation) =>
    !!db.prepare(`SELECT 1 FROM discussion_entries WHERE target_key=? AND file=? AND line=? AND side=? LIMIT 1`).get(...at(k, location));
  const stopWaitingAt = (k: string, location: CommentLocation) =>
    db.prepare(`DELETE FROM discussion_waits WHERE target_key=? AND file=? AND line=? AND side=?`).run(...at(k, location));

  const rowToMeta = (r: any): ReviewMeta => ({
    targetKey: r.target_key, kind: r.kind, number: r.number ?? undefined, repo: r.repo ?? undefined,
    title: r.title ?? undefined, author: r.author ?? undefined, base: r.base ?? undefined,
    head: r.head ?? undefined, gitRef: r.git_ref ?? undefined, url: r.url ?? undefined,
    status: r.status, createdAt: r.created_at, projectId: r.project_id ?? undefined,
    headSha: r.head_sha ?? undefined, cwd: r.cwd ?? undefined,
    ...JSON.parse((db.prepare(`SELECT state FROM review_lifecycle WHERE target_key=?`).get(r.target_key) as any)?.state ?? "{}"),
  });

  return {
    getPreferences() {
      const row = db.prepare(`SELECT value,revision FROM review_preferences WHERE id=1`).get() as { value: string; revision: number } | undefined;
      return { preferences: row ? preferencesSchema.parse({ ...defaultPreferences, ...JSON.parse(row.value) }) : { ...defaultPreferences }, revision: row?.revision ?? 0 };
    },
    savePreferences(preferences, revision) {
      const value = JSON.stringify(preferencesSchema.parse(preferences));
      const result = revision === 0
        ? db.prepare(`INSERT OR IGNORE INTO review_preferences (id,value,revision) VALUES (1,?,1)`).run(value)
        : db.prepare(`UPDATE review_preferences SET value=?,revision=revision+1 WHERE id=1 AND revision=?`).run(value, revision);
      if (!result.changes) throw new Error("Settings changed in another window. Reload settings before saving.");
      return { preferences: JSON.parse(value), revision: revision + 1 };
    },
    getReviewerNotes(targetKey) {
      return (db.prepare(`SELECT body,revision FROM reviewer_notes WHERE target_key=?`).get(targetKey) as ReviewerNotesRecord | undefined) ?? { body: "", revision: 0 };
    },
    saveReviewerNotes(targetKey, body, revision) {
      if (!this.getReview(targetKey)) throw new Error("Review not found.");
      const result = revision === 0
        ? db.prepare(`INSERT OR IGNORE INTO reviewer_notes (target_key,body,revision) VALUES (?,?,1)`).run(targetKey, body)
        : db.prepare(`UPDATE reviewer_notes SET body=?,revision=revision+1 WHERE target_key=? AND revision=?`).run(body, targetKey, revision);
      if (!result.changes) throw new Error("Notes changed in another window. Your text is kept here; reload the saved notes to compare.");
      return { body, revision: revision + 1 };
    },
    saveReview(m) {
      db.prepare(
        `INSERT INTO reviews (target_key,kind,number,repo,title,author,base,head,git_ref,url,status,created_at,project_id,head_sha,cwd)
         VALUES (@targetKey,@kind,@number,@repo,@title,@author,@base,@head,@gitRef,@url,@status,@createdAt,@projectId,@headSha,@cwd)
         ON CONFLICT(target_key) DO UPDATE SET
           kind=@kind,number=@number,repo=@repo,title=@title,author=@author,base=@base,head=@head,
           git_ref=@gitRef,url=@url,status=@status,created_at=@createdAt,project_id=@projectId,
           head_sha=@headSha,cwd=@cwd`,
      ).run({
        targetKey: m.targetKey, kind: m.kind, number: m.number ?? null, repo: m.repo ?? null,
        title: m.title ?? null, author: m.author ?? null, base: m.base ?? null, head: m.head ?? null,
        gitRef: m.gitRef ?? null, url: m.url ?? null, status: m.status, createdAt: m.createdAt,
        projectId: m.projectId ?? null, headSha: m.headSha ?? null, cwd: m.cwd ?? null,
      });
    },
    getReview(k) {
      const r = db.prepare(`SELECT * FROM reviews WHERE target_key=?`).get(k);
      return r ? rowToMeta(r) : null;
    },
    listReviews() {
      return db.prepare(`SELECT * FROM reviews ORDER BY created_at DESC`).all().map(rowToMeta);
    },
    setStatus(k, status) {
      db.prepare(`UPDATE reviews SET status=? WHERE target_key=?`).run(status, k);
    },
    setLifecycle(k, state) {
      const previous = JSON.parse((db.prepare(`SELECT state FROM review_lifecycle WHERE target_key=?`).get(k) as any)?.state ?? "{}");
      db.prepare(`INSERT INTO review_lifecycle VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET state=excluded.state`)
        .run(k, JSON.stringify({ ...previous, ...state }));
    },
    getReviewContext(k) {
      return (db.prepare(`SELECT text FROM review_context WHERE target_key=?`).get(k) as { text: string } | undefined)?.text ?? null;
    },
    setReviewContext(k, text) {
      if (text === null) db.prepare(`DELETE FROM review_context WHERE target_key=?`).run(k);
      else db.prepare(`INSERT INTO review_context VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET text=excluded.text`).run(k, text);
    },
    deleteReview(k) {
      db.transaction(() => {
        for (const table of REVIEW_TABLES) db.prepare(`DELETE FROM ${table} WHERE target_key=?`).run(k);
      })();
    },
    savePatch(k, patch) {
      db.prepare(
        `INSERT INTO patches (target_key,patch) VALUES (?,?)
         ON CONFLICT(target_key) DO UPDATE SET patch=excluded.patch`,
      ).run(k, patch);
    },
    readPatch(k, offset = 0, limit = 200_000) {
      const row: any = db.prepare(`SELECT patch FROM patches WHERE target_key=?`).get(k);
      const text = row?.patch ?? "";
      return { text: text.slice(offset, offset + limit), total: text.length };
    },
    saveGuide(k, guide) {
      db.prepare(
        `INSERT INTO guides (target_key,guide) VALUES (?,?)
         ON CONFLICT(target_key) DO UPDATE SET guide=excluded.guide`,
      ).run(k, JSON.stringify(guide));
    },
    getGuide(k) {
      const row: any = db.prepare(`SELECT guide FROM guides WHERE target_key=?`).get(k);
      return row ? (JSON.parse(row.guide) as Guide) : null;
    },
    beginGeneration(k) {
      const id = randomUUID();
      db.transaction(() => {
        db.prepare(`INSERT INTO generations VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET generation_id=excluded.generation_id`).run(k, id);
        db.prepare(`DELETE FROM guides WHERE target_key=?`).run(k);
        db.prepare(`UPDATE reviews SET status='generating' WHERE target_key=?`).run(k);
        // Restarting a review (new PR link, `bb review`, Re-review) takes it out of the reviewer's archive.
        if (this.getReview(k)?.userArchivedAt) this.setLifecycle(k, { userArchivedAt: null });
      })();
      return id;
    },
    isCurrentGeneration(k, id) {
      return (db.prepare(`SELECT generation_id FROM generations WHERE target_key=?`).get(k) as any)?.generation_id === id;
    },
    interruptGenerations() {
      db.transaction(() => {
        // Completed identities are also durable notification receipts. Only
        // workers interrupted by this reload lose the right to finalize.
        db.prepare(`DELETE FROM generations WHERE target_key IN (SELECT target_key FROM reviews WHERE status='generating')`).run();
        db.prepare(`UPDATE reviews SET status='error' WHERE status='generating'`).run();
      })();
    },
    getDraft(k) {
      const row: any = db.prepare(`SELECT * FROM drafts WHERE target_key=?`).get(k);
      if (!row) return { targetKey: k, verdict: "COMMENT", body: "", comments: [] };
      return { targetKey: k, verdict: row.verdict, body: row.body, comments: JSON.parse(row.comments) };
    },
    upsertDraftComment(k, c) {
      const d = this.getDraft(k);
      const i = d.comments.findIndex((x) => x.file === c.file && x.line === c.line && x.side === c.side);
      if (i >= 0) d.comments[i] = c; else d.comments.push(c);
      writeDraft(db, d);
      const patch = this.readPatch(k, 0, this.readPatch(k, 0, 0).total).text;
      const code = diffPositions(patch).get(c.file)?.[c.side === "LEFT" ? "left" : "right"].get(c.line) ?? null;
      db.prepare(`INSERT INTO draft_comment_revisions (target_key,file,line,side,patch_hash,code) VALUES (?,?,?,?,?,?)
        ON CONFLICT(target_key,file,line,side) DO UPDATE SET patch_hash=excluded.patch_hash, code=excluded.code`)
        .run(k, c.file, c.line, c.side, patchHash(patch), code);
      return d;
    },
    editDraftComment(k, at, body) {
      const d = this.getDraft(k);
      const comment = d.comments.find((c) => sameLocation(c, at));
      if (!comment) return null;
      comment.body = body;
      writeDraft(db, d);
      return d;
    },
    deleteDraftComment(k, at) {
      const d = this.getDraft(k);
      const index = d.comments.findIndex((c) => sameLocation(c, at));
      if (index < 0) return null;
      d.comments.splice(index, 1);
      writeDraft(db, d);
      return d;
    },
    setVerdict(k, verdict, body) {
      const d = this.getDraft(k);
      d.verdict = verdict; d.body = body;
      writeDraft(db, d);
      return d;
    },
    staleDraftComments(k) {
      const hash = patchHash(this.readPatch(k, 0, this.readPatch(k, 0, 0).total).text);
      return this.getDraft(k).comments.filter((c) => {
        const row = db.prepare(`SELECT patch_hash FROM draft_comment_revisions WHERE target_key=? AND file=? AND line=? AND side=?`).get(k, c.file, c.line, c.side) as any;
        return row?.patch_hash !== hash;
      });
    },
    clearSubmittedDraft(submitted) {
      const current = this.getDraft(submitted.targetKey);
      current.comments = current.comments.filter((c) => !submitted.comments.some((old) => JSON.stringify(old) === JSON.stringify(c)));
      if (current.body === submitted.body && current.verdict === submitted.verdict) {
        current.body = "";
        current.verdict = "COMMENT";
      }
      writeDraft(db, current);
    },
    listDiscussions(k) {
      const waiting = db.prepare(`SELECT file,line,side FROM discussion_waits WHERE target_key=?`).all(k) as CommentLocation[];
      const discussions: Discussion[] = [];
      for (const row of db.prepare(`SELECT * FROM discussion_entries WHERE target_key=? ORDER BY id`).all(k) as any[]) {
        const location: CommentLocation = { file: row.file, line: row.line, side: row.side };
        let discussion = discussions.find((d) => sameLocation(d, location));
        if (!discussion) discussions.push(discussion = { ...location, entries: [], waiting: waiting.some((w) => sameLocation(w, location)) });
        discussion.entries.push({ author: row.author, kind: row.kind, body: row.body, createdAt: row.created_at });
        if (row.start_line != null && discussion.startLine === undefined) discussion.startLine = row.start_line;
      }
      return discussions;
    },
    addDiscussionMessage(k, location, author, body, startLine) {
      db.transaction(() => {
        db.prepare(`INSERT INTO discussion_entries (target_key,file,line,side,author,kind,body,start_line,created_at) VALUES (?,?,?,?,?,'message',?,?,?)`)
          .run(...at(k, location), author, body, startLine ?? null, Date.now());
        if (author === "reviewer") db.prepare(`INSERT OR IGNORE INTO discussion_waits VALUES (?,?,?,?)`).run(...at(k, location));
        else stopWaitingAt(k, location);
      })();
    },
    noteDiscussionChange(k, location, kind) {
      if (!hasDiscussion(k, location)) return;
      db.transaction(() => {
        db.prepare(`INSERT INTO discussion_entries (target_key,file,line,side,author,kind,body,created_at) VALUES (?,?,?,?,'agent',?,'',?)`)
          .run(...at(k, location), kind, Date.now());
        stopWaitingAt(k, location);
      })();
    },
    deleteDiscussion(k, location) {
      db.transaction(() => {
        db.prepare(`DELETE FROM discussion_entries WHERE target_key=? AND file=? AND line=? AND side=?`).run(...at(k, location));
        stopWaitingAt(k, location);
      })();
    },
    clearDiscussions(k) {
      db.transaction(() => {
        db.prepare(`DELETE FROM discussion_entries WHERE target_key=?`).run(k);
        db.prepare(`DELETE FROM discussion_waits WHERE target_key=?`).run(k);
      })();
    },
    stopWaiting(k) {
      return db.prepare(`DELETE FROM discussion_waits WHERE target_key=?`).run(k).changes > 0;
    },
    getFileViews(k) {
      return db
        .prepare(`SELECT file, hash, viewed_at FROM file_views WHERE target_key=?`)
        .all(k)
        .map((r: any) => ({ file: r.file, hash: r.hash, viewedAt: r.viewed_at }));
    },
    setFileViewed(k, file, hash) {
      db.prepare(
        `INSERT INTO file_views (target_key,file,hash,viewed_at) VALUES (?,?,?,?)
         ON CONFLICT(target_key,file) DO UPDATE SET hash=excluded.hash, viewed_at=excluded.viewed_at`,
      ).run(k, file, hash, Date.now());
    },
    unsetFileViewed(k, file) {
      db.prepare(`DELETE FROM file_views WHERE target_key=? AND file=?`).run(k, file);
    },
    getAgentThread(k) {
      const row: any = db.prepare(`SELECT thread_id FROM agent_threads WHERE target_key=?`).get(k);
      return row?.thread_id ?? null;
    },
    clearAgentThread(k) {
      db.prepare(`DELETE FROM agent_threads WHERE target_key=?`).run(k);
    },
    listAgentMessages(k) {
      return db
        .prepare(`SELECT id, role, text, context, created_at FROM agent_messages WHERE target_key=? ORDER BY id ASC`)
        .all(k)
        .map((r: any) => ({
          id: r.id,
          role: r.role,
          text: r.text,
          context: r.context ? (JSON.parse(r.context) as AgentMessageContext) : null,
          createdAt: r.created_at,
        }));
    },
    clearAgentMessages(k) {
      db.prepare(`DELETE FROM agent_messages WHERE target_key=?`).run(k);
    },
    getAssistantThread(k) {
      const row: any = db.prepare(`SELECT thread_id FROM assistant_threads WHERE target_key=?`).get(k);
      return row?.thread_id ?? null;
    },
    setAssistantThread(k, threadId) {
      db.prepare(
        `INSERT INTO assistant_threads (target_key,thread_id,created_at) VALUES (?,?,?)
         ON CONFLICT(target_key) DO UPDATE SET thread_id=excluded.thread_id, created_at=excluded.created_at`,
      ).run(k, threadId, Date.now());
    },
    clearAssistantThread(k) {
      db.prepare(`DELETE FROM assistant_threads WHERE target_key=?`).run(k);
    },
    listAssistantThreads() {
      return db.prepare(`SELECT target_key, thread_id FROM assistant_threads`).all()
        .map((r: any) => ({ targetKey: r.target_key, threadId: r.thread_id }));
    },
    saveSnapshot(k, headSha, patch) {
      db.prepare(`INSERT INTO review_snapshots VALUES (?,?,?,?) ON CONFLICT(target_key,head_sha) DO UPDATE SET patch=excluded.patch`)
        .run(k, headSha, patch, Date.now());
    },
    getSnapshot(k, headSha) {
      return (db.prepare(`SELECT patch FROM review_snapshots WHERE target_key=? AND head_sha=?`).get(k, headSha) as { patch: string } | undefined)?.patch ?? null;
    },
    pruneSnapshots(k, keep) {
      const rows = db.prepare(`SELECT head_sha FROM review_snapshots WHERE target_key=?`).all(k) as Array<{ head_sha: string }>;
      for (const { head_sha } of rows) if (!keep.includes(head_sha)) db.prepare(`DELETE FROM review_snapshots WHERE target_key=? AND head_sha=?`).run(k, head_sha);
    },
    saveFeedbackThreads(k, threads, prUpdatedAt) {
      const now = Date.now();
      db.transaction(() => {
        const previous = new Map((db.prepare(`SELECT thread_id, resolved_seen_at FROM feedback_threads WHERE target_key=?`).all(k) as any[])
          .map((row) => [row.thread_id as string, row.resolved_seen_at as number | null]));
        db.prepare(`DELETE FROM feedback_threads WHERE target_key=?`).run(k);
        const insert = db.prepare(`INSERT INTO feedback_threads VALUES (?,?,?,?)`);
        // When a thread was resolved isn't in GitHub's data; the first time bb saw it resolved stands in.
        for (const thread of threads) insert.run(k, thread.id, JSON.stringify(thread), thread.isResolved ? previous.get(thread.id) ?? now : null);
        db.prepare(`INSERT INTO feedback_fetches VALUES (?,?,?) ON CONFLICT(target_key) DO UPDATE SET fetched_at=excluded.fetched_at, pr_updated_at=excluded.pr_updated_at`)
          .run(k, now, prUpdatedAt);
      })();
    },
    listFeedbackThreads(k) {
      return (db.prepare(`SELECT data, resolved_seen_at FROM feedback_threads WHERE target_key=?`).all(k) as any[])
        .map((row) => ({ ...(JSON.parse(row.data) as FeedbackThread), resolvedSeenAt: row.resolved_seen_at ?? null }))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    feedbackFetched(k) {
      const row = db.prepare(`SELECT fetched_at, pr_updated_at FROM feedback_fetches WHERE target_key=?`).get(k) as any;
      return row ? { fetchedAt: row.fetched_at, prUpdatedAt: row.pr_updated_at ?? null } : null;
    },
    saveAssessmentItems(k, headSha, items) {
      const insert = db.prepare(`INSERT INTO assessment_items VALUES (?,?,?,?) ON CONFLICT(target_key,head_sha,item_id) DO UPDATE SET data=excluded.data`);
      db.transaction(() => { for (const item of items) insert.run(k, headSha, item.id, JSON.stringify(item)); })();
    },
    saveAssessmentRun(k, run) {
      db.prepare(`INSERT INTO assessment_runs VALUES (?,?,?,?) ON CONFLICT(target_key,head_sha) DO UPDATE SET data=excluded.data, assessed_at=excluded.assessed_at`)
        .run(k, run.headSha, JSON.stringify(run), run.assessedAt);
    },
    getAssessment(k, headSha) {
      const items = (db.prepare(`SELECT data FROM assessment_items WHERE target_key=? AND head_sha=?`).all(k, headSha) as any[]).map((row) => JSON.parse(row.data) as AssessmentItem);
      const run = db.prepare(`SELECT data FROM assessment_runs WHERE target_key=? AND head_sha=?`).get(k, headSha) as any;
      return { items, run: run ? JSON.parse(run.data) as AssessmentRun : null };
    },
    latestAssessmentRun(k) {
      const row = db.prepare(`SELECT data FROM assessment_runs WHERE target_key=? ORDER BY assessed_at DESC LIMIT 1`).get(k) as any;
      return row ? JSON.parse(row.data) as AssessmentRun : null;
    },
    setReplyDraft(k, threadId, body, author) {
      db.prepare(`INSERT INTO reply_drafts VALUES (?,?,?,?,?) ON CONFLICT(target_key,thread_id) DO UPDATE SET body=excluded.body, author=excluded.author, updated_at=excluded.updated_at`)
        .run(k, threadId, body, author, Date.now());
    },
    listReplyDrafts(k) {
      return new Map((db.prepare(`SELECT thread_id, body, author, updated_at FROM reply_drafts WHERE target_key=?`).all(k) as any[])
        .map((row) => [row.thread_id as string, { body: row.body, author: row.author, updatedAt: row.updated_at } as ReplyDraft]));
    },
    deleteReplyDraft(k, threadId) {
      db.prepare(`DELETE FROM reply_drafts WHERE target_key=? AND thread_id=?`).run(k, threadId);
    },
    ignoreDiscovery(k) {
      db.prepare(`INSERT INTO discovery_ignores VALUES (?,?) ON CONFLICT(target_key) DO UPDATE SET ignored_at=excluded.ignored_at`).run(k, Date.now());
    },
    unignoreDiscovery(k) {
      db.prepare(`DELETE FROM discovery_ignores WHERE target_key=?`).run(k);
    },
    isDiscoveryIgnored(k) {
      return !!db.prepare(`SELECT 1 FROM discovery_ignores WHERE target_key=?`).get(k);
    },
    draftCommentCode(k, { file, line, side }) {
      return (db.prepare(`SELECT code FROM draft_comment_revisions WHERE target_key=? AND file=? AND line=? AND side=?`).get(k, file, line, side) as any)?.code ?? undefined;
    },
    rebaseDraftComment(k, at, line) {
      const patch = this.readPatch(k, 0, this.readPatch(k, 0, 0).total).text;
      db.transaction(() => {
        if (line !== at.line) {
          const d = this.getDraft(k);
          const comment = d.comments.find((c) => sameLocation(c, at));
          if (!comment || d.comments.some((c) => sameLocation(c, { ...at, line }))) return;
          comment.line = line;
          writeDraft(db, d);
          db.prepare(`DELETE FROM draft_comment_revisions WHERE target_key=? AND file=? AND line=? AND side=?`).run(k, at.file, at.line, at.side);
        }
        const code = diffPositions(patch).get(at.file)?.[at.side === "LEFT" ? "left" : "right"].get(line) ?? null;
        db.prepare(`INSERT INTO draft_comment_revisions (target_key,file,line,side,patch_hash,code) VALUES (?,?,?,?,?,?)
          ON CONFLICT(target_key,file,line,side) DO UPDATE SET patch_hash=excluded.patch_hash, code=excluded.code`)
          .run(k, at.file, line, at.side, patchHash(patch), code);
      })();
    },
  };
}

// Every table keyed by target_key. A new per-review table belongs here too.
const REVIEW_TABLES = [
  "reviews", "patches", "guides", "drafts", "file_views", "agent_threads", "agent_messages",
  "generations", "draft_comment_revisions", "review_lifecycle", "reviewer_notes", "assistant_threads", "review_context",
  "discussion_entries", "discussion_waits", "review_snapshots", "feedback_threads", "feedback_fetches",
  "assessment_items", "assessment_runs", "reply_drafts",
] as const;

function patchHash(patch: string) { return createHash("sha256").update(patch).digest("hex"); }

function writeDraft(db: any, d: Draft) {
  db.prepare(
    `INSERT INTO drafts (target_key,verdict,body,comments) VALUES (?,?,?,?)
     ON CONFLICT(target_key) DO UPDATE SET verdict=excluded.verdict,body=excluded.body,comments=excluded.comments`,
  ).run(d.targetKey, d.verdict, d.body, JSON.stringify(d.comments));
}
