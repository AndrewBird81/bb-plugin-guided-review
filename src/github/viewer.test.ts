import { expect, test, vi } from "vitest";
import { createViewer } from "./viewer";

const ok = (stdout: string) => ({ code: 0, stderr: "", stdout });
const fail = { code: 1, stderr: "gh: error connecting to api.github.com", stdout: "" };

function fakeGh(login = "Octo-Cat\n", teams = "Acme/Web-Core\nacme/infra\n\n") {
  return vi.fn(async (args: string[]) => (args.includes("user/teams") ? ok(teams) : ok(login)));
}
function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("login and teams read gh and normalize team slugs", async () => {
  const run = fakeGh();
  const viewer = createViewer(run);
  expect(await viewer.login()).toBe("Octo-Cat");
  expect([...await viewer.teams()]).toEqual(["acme/web-core", "acme/infra"]);
  expect(run.mock.calls.map(([args]) => args)).toEqual([
    ["api", "user", "--jq", ".login"],
    ["api", "--paginate", "user/teams", "--jq", '.[] | "\\(.organization.login)/\\(.slug)"'],
  ]);
});

test("reads are cached for the ttl and shared while in flight", async () => {
  const time = clock();
  const run = fakeGh();
  const viewer = createViewer(run, { ttlMs: 1000, now: time.now });
  await Promise.all([viewer.login(), viewer.login()]);
  time.advance(999);
  await viewer.login();
  expect(run).toHaveBeenCalledTimes(1);
  time.advance(1);
  await viewer.login();
  expect(run).toHaveBeenCalledTimes(2);
});

test("a failure returns null or no teams, and retries after retryMs", async () => {
  const time = clock();
  const run = vi.fn(async (_args: string[]) => fail);
  const viewer = createViewer(run, { retryMs: 500, now: time.now });
  expect(await viewer.login()).toBeNull();
  expect((await viewer.teams()).size).toBe(0);
  time.advance(499);
  await viewer.login();
  expect(run).toHaveBeenCalledTimes(2);
  run.mockImplementation(async (args) => (args.includes("user/teams") ? ok("acme/web\n") : ok("me\n")));
  time.advance(1);
  expect(await viewer.login()).toBe("me");
  expect([...await viewer.teams()]).toEqual(["acme/web"]);
});

test("an empty login counts as a failure", async () => {
  expect(await createViewer(fakeGh("\n")).login()).toBeNull();
});

test("reset forgets the account, including a read still in flight", async () => {
  let finish!: (value: { code: number; stderr: string; stdout: string }) => void;
  const run = vi.fn((_args: string[]) => new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => { finish = resolve; }));
  const viewer = createViewer(run);
  const stale = viewer.login();
  viewer.reset();
  finish(ok("old\n"));
  expect(await stale).toBe("old");
  run.mockResolvedValueOnce(ok("new\n"));
  expect(await viewer.login()).toBe("new");
  expect(run).toHaveBeenCalledTimes(2);
});
