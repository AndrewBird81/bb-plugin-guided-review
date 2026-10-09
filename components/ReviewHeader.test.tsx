// @vitest-environment jsdom
import { test, expect, afterEach } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { defaultPreferences } from "../src/preferences";
afterEach(() => { cleanup(); localStorage.clear(); });

const url = "https://github.com/acme/web/pull/42";
const guide = {
  title: "Guide", intent: "Serializes token refreshes.", unplacedFiles: [],
  sections: [{ id: "c1", title: "Refresh", overview: "One in-flight refresh.", diffs: [{ file: "src/auth.ts", summary: "Lock" }] }],
};

function renderWorkspace(review: Record<string, unknown>) {
  return loadPluginApp(() => import("../app")).then((app) => renderSlot(app.navPanels[0]!, { subPath: "pr-42" }, { rpc: {
    setReviewPresence: () => ({ ok: true }),
    getReviewBundle: () => ({ review: { targetKey: "pr-42", status: "ready", createdAt: 1, ...review }, guide, patch: "", revision: "r1" }),
    getChecks: () => ({ bucket: "none", checks: [] }),
    getPreferences: () => ({ preferences: defaultPreferences, revision: 0 }),
    getFileViews: () => ({ views: [] }),
    checkRepoAccess: () => ({ accessible: true, repo: "acme/web", account: "me" }),
    checkForUpdates: () => ({ hasNewCommits: false }),
    getDraft: () => ({ draft: { targetKey: "pr-42", verdict: "COMMENT", body: "", comments: [] } }),
    getReviewerNotes: () => ({ body: "", revision: 0 }),
    getAgentMessages: () => ({ messages: [] }),
  } }));
}

test("a PR review's title opens the pull request on GitHub, including in focus mode", async () => {
  const slot = await renderWorkspace({ kind: "pr", number: 42, repo: "acme/web", title: "Fix token refresh race", url });
  const link = await slot.findByRole("link", { name: "Fix token refresh race" });
  expect(link.getAttribute("href")).toBe(url);
  fireEvent.click(link);
  expect(slot.inspection.navigateCalls).toContainEqual({ method: "openUrl", url });

  fireEvent.click(slot.getByRole("button", { name: "Focus mode" }));
  expect(slot.queryByRole("heading", { name: "Fix token refresh race" })).toBeNull();
  expect(slot.getByRole("link", { name: "Fix token refresh race" }).getAttribute("href")).toBe(url);
  slot.lifecycle.unmount();
});

test("a local review's title stays plain text", async () => {
  const slot = await renderWorkspace({ kind: "ref", gitRef: "main...feature", title: "Local change" });
  await slot.findByRole("heading", { name: "Local change" });
  expect(slot.queryByRole("link", { name: "Local change" })).toBeNull();
  slot.lifecycle.unmount();
});
