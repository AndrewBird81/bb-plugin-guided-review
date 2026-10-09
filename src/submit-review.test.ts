import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { createReviewSubmitter } from "./submit-review";
import type { runGh } from "./gh";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
function setup() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  store.saveReview({ targetKey: "pr-test", kind: "pr", repo: "acme/web", number: 7, status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch("pr-test", patch);
  store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" });
  store.setVerdict("pr-test", "COMMENT", "My summary");
  const run = vi.fn<typeof runGh>(async (args) => ({ code: 0, stderr: "", stdout: args[0] === "pr" ? '{"headRefOid":"sha1"}' : '{"id":12}' }));
  return { store, run, submit: createReviewSubmitter(store, run) };
}

test("submission pins the reviewed commit and clears only the submitted draft", async () => {
  const { store, run, submit } = setup();
  store.saveReviewerNotes("pr-test", "Private: ask about rollout", 0);
  expect(await submit("pr-test")).toEqual({ ok: true });
  expect(run).toHaveBeenLastCalledWith(expect.arrayContaining(["repos/acme/web/pulls/7/reviews"]), {
    stdin: JSON.stringify({ event: "COMMENT", body: "My summary", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "Please explain this" }], commit_id: "sha1" }),
  });
  expect(store.getDraft("pr-test")).toMatchObject({ verdict: "COMMENT", body: "", comments: [] });
  expect(store.getReviewerNotes("pr-test").body).toBe("Private: ask about rollout");
  expect(await submit("pr-test")).toMatchObject({ ok: false });
  expect(run).toHaveBeenCalledTimes(2);
});

test("new PR commits block all writes and retain the draft", async () => {
  const { store, run, submit } = setup();
  const draft = store.getDraft("pr-test");
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha2"}' });
  expect(await submit("pr-test")).toMatchObject({ ok: false, error: expect.stringContaining("new commits") });
  expect(run).toHaveBeenCalledTimes(1);
  expect(store.getDraft("pr-test")).toEqual(draft);
});

test("a failed GitHub write keeps the draft and surfaces field errors", async () => {
  const { store, run, submit } = setup();
  const draft = store.getDraft("pr-test");
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' })
    .mockResolvedValueOnce({ code: 1, stderr: "HTTP 422", stdout: '{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}' });
  expect(await submit("pr-test")).toMatchObject({ ok: false, error: expect.stringContaining("line must be part of the diff") });
  expect(store.getDraft("pr-test")).toEqual(draft);
});

test("concurrent submit clicks send one write and retain edits made during the request", async () => {
  const { store, run, submit } = setup();
  let finish!: (value: Awaited<ReturnType<typeof runGh>>) => void;
  run.mockImplementation(async (args) => args[0] === "pr"
    ? { code: 0, stderr: "", stdout: '{"headRefOid":"sha1"}' }
    : new Promise((resolve) => { finish = resolve; }));
  const first = submit("pr-test");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(await submit("pr-test")).toMatchObject({ ok: false, error: expect.stringContaining("already") });
  store.setVerdict("pr-test", "COMMENT", "A new summary");
  store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "RIGHT", body: "Edited while sending" });
  finish({ code: 0, stdout: '{"id":12}', stderr: "" });
  expect(await first).toEqual({ ok: true });
  expect(run).toHaveBeenCalledTimes(2);
  expect(store.getDraft("pr-test")).toMatchObject({ body: "A new summary", comments: [{ body: "Edited while sending" }] });
});

test("re-review cannot silently reuse comments whose line still exists in a changed diff", async () => {
  const { store, run, submit } = setup();
  store.savePatch("pr-test", patch.replace("+new", "+different"));
  expect(await submit("pr-test")).toMatchObject({ ok: false, error: expect.stringContaining("diff changed") });
  expect(run).not.toHaveBeenCalled();
});

test("submission refuses draft comments the reviewer's page hasn't shown", async () => {
  const { store, run, submit } = setup();
  const shown = store.getDraft("pr-test").comments;
  store.upsertDraftComment("pr-test", { file: "a.ts", line: 1, side: "LEFT", body: "Added by the assistant" });
  expect(await submit("pr-test", undefined, undefined, shown)).toMatchObject({ ok: false, error: expect.stringContaining("changed since this page showed them") });
  expect(run).not.toHaveBeenCalled();
  expect(store.getDraft("pr-test").comments).toHaveLength(2);
  expect(await submit("pr-test", undefined, undefined, store.getDraft("pr-test").comments)).toEqual({ ok: true });
});

test("local refs never submit to GitHub", async () => {
  const { store, run, submit } = setup();
  store.saveReview({ targetKey: "local", kind: "ref", gitRef: "HEAD", status: "ready", createdAt: 1 });
  store.setVerdict("local", "APPROVE", "");
  expect(await submit("local")).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
});

test("approval persists separately from the cleared draft and survives metadata refresh", async () => {
  const { store, submit } = setup();
  store.setVerdict("pr-test", "APPROVE", "Looks good");
  expect(await submit("pr-test")).toEqual({ ok: true });
  expect(store.getReview("pr-test")).toMatchObject({ submittedVerdict: "APPROVE", submittedHeadSha: "sha1", submittedAt: expect.any(Number) });
  const { submittedVerdict, submittedHeadSha, submittedAt, ...meta } = store.getReview("pr-test")! as any;
  store.saveReview(meta);
  expect(store.getReview("pr-test")).toMatchObject({ submittedVerdict: "APPROVE" });
});

test("a PR merged since opening the workspace blocks submission and archives the review", async () => {
  const { store, run, submit } = setup();
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1","state":"MERGED"}' });
  expect(await submit("pr-test")).toMatchObject({ ok: false, error: expect.stringContaining("merged") });
  expect(run).toHaveBeenCalledTimes(1);
  expect(store.getReview("pr-test")).toMatchObject({ prState: "MERGED", archivedAt: expect.any(Number) });
  expect(store.getDraft("pr-test").comments).toHaveLength(1);
});

test("submission records the reviewer from GitHub so account switches cannot misattribute it", async () => {
  const { store, run, submit } = setup();
  run.mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"headRefOid":"sha1","state":"OPEN"}' })
    .mockResolvedValueOnce({ code: 0, stderr: "", stdout: '{"id":12,"user":{"login":"reviewer"}}' });
  expect(await submit("pr-test")).toEqual({ ok: true });
  expect(store.getReview("pr-test")?.reviewer).toBe("reviewer");
});
