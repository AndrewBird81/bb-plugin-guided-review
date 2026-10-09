import { expect, test, vi } from "vitest";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../src/store";
import plugin from "../server";
import { runGh } from "../src/gh";

vi.mock("../src/gh", async (original) => ({ ...await original<typeof import("../src/gh")>(), runGh: vi.fn() }));

// The running BB supplies the real app shell and built plugin. Its plugin RPCs
// are routed through the official test host, with real SQLite and mocked GitHub
// and agent boundaries. No test review, comment or agent is sent to production.
test.skipIf(!process.env.BB_E2E_URL)("fullscreen verdict → submitted → reload → merge → archive, with in-plugin chat", async () => {
  let prState = "OPEN";
  let approved = false;
  vi.mocked(runGh).mockImplementation(async (args) => {
    if (args[0] === "auth") return { code: 0, stderr: "", stdout: "test-token" };
    if (args[1] === "user") return { code: 0, stderr: "", stdout: "reviewer" };
    if (args.includes("graphql")) return { code: 0, stderr: "", stdout: JSON.stringify({ data: { viewer: { login: "reviewer" }, repository: { pullRequest: { state: prState, headRefOid: "sha1", reviews: { nodes: approved ? [{ state: "APPROVED", submittedAt: new Date().toISOString(), author: { login: "reviewer" }, commit: { oid: "sha1" } }] : [] } } } } }) };
    if (args.includes("POST")) { approved = true; return { code: 0, stderr: "", stdout: '{"id":12}' }; }
    return { code: 0, stderr: "", stdout: JSON.stringify({ headRefOid: "sha1", state: prState }) };
  });
  let workerCount = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: {
    get: async () => ({ archivedAt: null, deletedAt: null, status: "idle" }),
    spawn: async () => ({ id: `e2e-hidden-agent-${++workerCount}` }),
    stop: async () => ({}), update: async () => ({}), archive: async () => ({}),
  } } });
  await plugin(bb);
  const store = createStore(bb);
  const key = "e2e-review";
  store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", title: "Validate incoming review data", author: "alice", status: "ready", createdAt: Date.now(), headSha: "sha1", projectId: "test-project" });
  store.saveGuide(key, { title: "Validate incoming review data", intent: "Reject invalid values before they reach storage.", sections: [{ id: "validation", title: "Input validation", overview: "The entry point checks the value before saving it.", diffs: [{ file: "src/input.ts", description: "Reject blank values" }] }], unplacedFiles: [] } as any);
  store.savePatch(key, 'diff --git a/src/input.ts b/src/input.ts\n--- a/src/input.ts\n+++ b/src/input.ts\n@@ -1 +1,2 @@\n+if (!value.trim()) throw new Error("Required");\n save(value);\n');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = "docs/verification/2026-09-09";
  await mkdir(dir, { recursive: true });
  await page.route("**/api/v1/plugins/guided-review/rpc/*", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").pop()!;
    const input = route.request().postDataJSON();
    const helpers: Record<string, unknown> = {
      getSetupStatus: { account: "reviewer", githubCli: true, agentAvailable: true, projectAvailable: true },
      getGhAccounts: { active: "reviewer", accounts: [{ login: "reviewer", active: true }] },
      getChecks: { bucket: "none", checks: [] }, checkRepoAccess: { accessible: true, repo: "acme/web", account: "reviewer" },
    };
    try {
      const result = helpers[method] ?? await harness.behavior.callRpc(method, input);
      await route.fulfill({ json: { ok: true, result } });
    } catch (error) { await route.fulfill({ status: 500, json: { ok: false, error: { message: String(error) } } }); }
  });
  const base = process.env.BB_E2E_URL!;
  try {
    await page.goto(`${base}/plugins/guided-review/review/settings/${key}`);
    // Collapse the unrelated Office overlay through its normal, browser-local control.
    // Otherwise it can cover the plugin's editors in the shared BB test shell.
    const collapseOffice = page.getByRole("button", { name: "Collapse office to current worker", exact: true });
    await collapseOffice.waitFor({ timeout: 5000 }).then(() => collapseOffice.click()).catch(() => {});
    await page.getByRole("textbox", { name: "Guide instructions", exact: true }).fill("Explain compatibility and migrations.");
    await page.getByRole("textbox", { name: "Assistant instructions", exact: true }).fill("Focus on concrete failure cases.");
    await page.getByRole("button", { name: "Detailed", exact: true }).click();
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText("Settings saved", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("textbox", { name: "Guide instructions", exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "Guide instructions", exact: true }).inputValue()).toBe("Explain compatibility and migrations.");
    await page.screenshot({ animations: "disabled", path: `${dir}/settings-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("textbox", { name: "Guide instructions", exact: true }).waitFor();
    expect(await page.getByRole("textbox", { name: "Guide instructions", exact: true }).evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/settings-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Back to review", exact: true }).click();
    await page.getByRole("button", { name: "Reviewer notes", exact: true }).click();
    const notes = page.getByRole("textbox", { name: "Private reviewer notes", exact: true });
    await notes.fill("Private: verify the staged rollout.");
    await notes.blur();
    await page.getByText("Notes saved", { exact: true }).waitFor();
    expect(store.getReviewerNotes(key).body).toBe("Private: verify the staged rollout.");
    await page.screenshot({ animations: "disabled", path: `${dir}/notes-desktop.png` });
    const reviewTools = page.getByRole("complementary", { name: "Review tools", exact: true });
    expect(await reviewTools.evaluate((element) => element.getBoundingClientRect().width)).toBe(384);
    await page.getByRole("button", { name: "Reviewer notes", exact: true }).click();
    await notes.waitFor({ state: "hidden" });
    expect(await reviewTools.evaluate((element) => element.getBoundingClientRect().width)).toBe(44);
    await page.reload();
    await reviewTools.waitFor();
    expect(await reviewTools.evaluate((element) => element.getBoundingClientRect().width)).toBe(44);
    await page.screenshot({ animations: "disabled", path: `${dir}/sidebar-collapsed-desktop.png` });
    const notesTool = page.getByRole("button", { name: "Reviewer notes", exact: true });
    await notesTool.focus();
    await page.getByRole("tooltip", { name: "Reviewer notes", exact: true }).waitFor();
    await notesTool.press("Enter");
    expect(await notes.inputValue()).toBe("Private: verify the staged rollout.");
    await page.getByRole("button", { name: "Draft comments", exact: true }).click();
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Please cover blank input in a test.");
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    await page.getByText("Please cover blank input in a test.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit comment on src/input.ts:1", exact: true }).click();
    await page.getByRole("textbox", { name: "Draft comment", exact: true }).fill("Please test whitespace-only input too.");
    await page.getByRole("button", { name: "Save comment", exact: true }).click();
    await page.getByText("Please test whitespace-only input too.", { exact: true }).waitFor();
    expect(store.getDraft(key).comments).toHaveLength(1);
    await page.getByRole("button", { name: "Review summary", exact: true }).click();
    await page.getByRole("textbox", { name: "Review summary", exact: true }).fill("The validation looks good with this test follow-up.");
    await page.getByRole("textbox", { name: "Review summary", exact: true }).blur();
    await page.getByRole("button", { name: "Review summary", exact: true }).click();
    const verdicts = page.getByRole("group", { name: "Review verdict" });
    await verdicts.getByRole("button", { name: "Approve", exact: true }).waitFor();
    expect(await page.getByRole("combobox", { name: "Review verdict" }).count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await verdicts.waitFor();
    await verdicts.getByRole("button", { name: "Approve", exact: true }).scrollIntoViewIfNeeded();
    expect(await verdicts.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/review-mobile.png` });
    await page.getByRole("button", { name: "Reviewer notes", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Private reviewer notes", exact: true }).inputValue()).toBe("Private: verify the staged rollout.");
    await page.getByRole("button", { name: "Collapse review panel", exact: true }).click();
    await notes.waitFor({ state: "hidden" });
    expect(await reviewTools.isVisible()).toBe(true);
    expect(await reviewTools.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(45);
    await page.screenshot({ animations: "disabled", path: `${dir}/sidebar-collapsed-mobile.png` });
    await page.getByRole("button", { name: "Draft comments", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "src/input.ts:1 · Changed", exact: true }).click();
    await page.getByRole("button", { name: "Full screen", exact: true }).click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    expect(await verdicts.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true);
    await verdicts.getByRole("button", { name: "Request changes", exact: true }).click();
    expect(await verdicts.getByRole("button", { name: "Request changes", exact: true }).getAttribute("aria-pressed")).toBe("true");
    await verdicts.getByRole("button", { name: "Comment", exact: true }).click();
    await verdicts.getByRole("button", { name: "Approve", exact: true }).click();
    expect(await verdicts.getByRole("button", { name: "Approve", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await verdicts.getByRole("button", { name: "Comment", exact: true }).getAttribute("aria-pressed")).toBe("false");
    await page.screenshot({ animations: "disabled", path: `${dir}/fullscreen-verdict.png` });
    await page.getByRole("button", { name: "Submit to GitHub", exact: true }).click();
    await page.getByRole("region", { name: "Submitted review" }).waitFor();
    expect(store.getReview(key)?.submittedVerdict).toBe("APPROVE");
    expect(store.getDraft(key).comments).toHaveLength(0);
    expect(store.getReviewerNotes(key).body).toBe("Private: verify the staged rollout.");
    const submission = vi.mocked(runGh).mock.calls.find(([args]) => args.includes("POST"));
    expect(submission?.[1]?.stdin).not.toContain("Private:");
    expect(submission?.[1]?.stdin).toContain("Please test whitespace-only input too.");
    await page.getByRole("button", { name: "Ask the review agent", exact: true }).click();
    const assistant = page.getByRole("region", { name: "Review assistant", exact: true });
    await assistant.waitFor();
    expect(await page.getByRole("dialog", { name: "Review agent", exact: true }).count()).toBe(0);
    await page.getByPlaceholder(/Ask the agent/).fill("Explain the validation guard");
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await assistant.waitFor({ state: "hidden" });
    expect(await reviewTools.evaluate((element) => element.getBoundingClientRect().width)).toBe(44);
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Ask agent", exact: true }).focus();
    const assistantTooltip = page.getByRole("tooltip", { name: "Ask agent", exact: true });
    await assistantTooltip.waitFor();
    expect(await assistantTooltip.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true);
    await page.getByRole("button", { name: "Ask agent", exact: true }).press("Enter");
    expect(await page.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.getByRole("button", { name: "Open assistant as widget", exact: true }).click();
    const widget = page.getByRole("dialog", { name: "Review agent", exact: true });
    await widget.waitFor();
    expect(await widget.evaluate((element) => document.fullscreenElement?.contains(element))).toBe(true);
    expect(await widget.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-widget.png` });
    await widget.getByRole("button", { name: "Dock in review panel", exact: true }).click();
    await page.getByRole("button", { name: "Reviewer notes", exact: true }).click();
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Ask the agent", exact: true }).inputValue()).toBe("Explain the validation guard");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // bb's ThreadChat takes over. The stubbed worker id has no thread in this bb.
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(harness.inspection.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ visibility: "hidden", title: `Review agent: ${key}`, pluginMetadata: { targetKey: key },
      input: [{ type: "text", text: "Explain the validation guard\n\nAbout `src/input.ts`." }] });
    expect(JSON.stringify(harness.inspection.sdk.callsTo("threads.spawn"))).not.toContain("Private: verify");
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-panel.png` });
    expect(await page.getByText("Open as thread", { exact: true }).count()).toBe(0);
    await page.evaluate(() => document.exitFullscreen());
    await page.reload();
    await assistant.waitFor();
    await page.getByRole("button", { name: "Draft comments", exact: true }).click();
    await page.getByRole("region", { name: "Submitted review" }).waitFor();
    await page.getByRole("button", { name: "Reviewer notes", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Private reviewer notes", exact: true }).inputValue()).toBe("Private: verify the staged rollout.");
    await page.getByRole("button", { name: "All reviews", exact: true }).click();
    await page.getByText("You’re all caught up", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^Reviewed/ }).click();
    await page.getByText("Approved", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/reviewed-desktop.png` });
    prState = "MERGED";
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText("No submitted reviews yet", { exact: true }).waitFor();
    expect(store.getReview(key)?.archivedAt).toBeTypeOf("number");
    // bb cannot send to an archived thread, so the assistant chat stays unarchived.
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    await page.getByRole("group", { name: "Filter reviews" }).getByRole("button", { name: /^Archive/ }).click();
    await page.getByText("Merged", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/archive-desktop.png` });
    await page.getByRole("button", { name: /Validate incoming review data/ }).click();
    await page.getByRole("button", { name: "Draft comments", exact: true }).click();
    await page.getByRole("region", { name: "Archived review" }).waitFor();
    expect(await page.getByRole("button", { name: "Submit to GitHub" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Re-review", exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await assistant.waitFor();
    await assistant.getByText("This thread is no longer available.").waitFor();
    expect(await assistant.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: `${dir}/assistant-mobile.png` });
    await page.getByRole("button", { name: "All reviews", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole("group", { name: "Filter reviews" }).getByRole("button", { name: /^Archive/ }).click();
    await page.getByText("Merged", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: `${dir}/archive-mobile.png` });
    const overflow = await page.locator('[aria-label="Saved reviews"]').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
    expect(vi.mocked(runGh).mock.calls.filter(([args]) => args.includes("POST"))).toHaveLength(1);
  } finally { await browser.close(); await harness.lifecycle.dispose(); }
}, 60_000);
