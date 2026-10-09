import { expect, test, vi } from "vitest";
import { bindGhAccount } from "./gh-identity";

test("one submission uses the verified identity even if the global account changes", async () => {
  const run = vi.fn(async (args: string[], opts?: { authToken?: string }) => {
    if (args[0] === "auth") return { code: 0, stdout: "test-only-credential", stderr: "" };
    if (args[1] === "user") return { code: 0, stdout: opts?.authToken === "test-only-credential" ? "casey" : "different-user", stderr: "" };
    return { code: 0, stdout: "{}", stderr: "" };
  });
  const bound = await bindGhAccount(run, "casey");
  await bound(["api", "-X", "POST", "repos/example/project/pulls/1/reviews"]);
  expect(run.mock.calls.at(-1)?.[1]).toMatchObject({ authToken: "test-only-credential" });
  await expect(bindGhAccount(run, "someone-else")).rejects.toThrow(/account changed/i);
});
