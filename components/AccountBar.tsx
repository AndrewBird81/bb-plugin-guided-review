import { memo, useCallback, useEffect, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Avatar } from "./ui/avatar";

export const AccountBar = memo(function AccountBar() {
  const rpc = useRpc<typeof rpcContract>();
  const [active, setActive] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<{ login: string; active: boolean }[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await rpc.call("getGhAccounts", null);
      setActive(r.active);
      setAccounts(r.accounts);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useRealtime("gh-account", () => {
    void refetch();
  });

  async function switchTo(login: string) {
    setSwitching(login);
    try {
      const res = await rpc.call("switchGhAccount", { login });
      if (res.ok) toast.success(`Switched to @${res.active}`);
      else toast.error(res.error ?? "Couldn't switch account");
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't switch account");
    } finally {
      setSwitching(null);
    }
  }

  const label = loading ? "Checking account…" : failed ? "Account unavailable" : active ? `@${active}` : "Connect GitHub";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" aria-label={`GitHub account: ${label}`}>
          {active && !loading && !failed ? <Avatar login={active} size={18} /> : <Icon name="Github" className="size-4" aria-hidden />}
          <span className="hidden max-w-40 truncate @min-[520px]/review-list:inline">{label}</span>
          <Icon name="ChevronDown" className="size-3" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-24px)] space-y-3 p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">GitHub account</p>
          <p className="text-xs leading-relaxed text-muted-foreground">Reviews are submitted using this BB server’s active account.</p>
        </div>
        <p role="status" className="flex items-center gap-2 rounded-lg border border-border bg-muted/25 px-2.5 py-2 text-sm">{active && !loading && !failed ? <Avatar login={active} size={24} /> : <Icon name="Github" className="size-4 text-muted-foreground" aria-hidden />}{loading ? "Checking account…" : failed ? "Account check unavailable" : active ? `Signed in as @${active}` : "No account connected"}</p>
        {!loading && (failed || !active) && <Button variant="outline" size="sm" onClick={refetch}>Check again</Button>}
        {!loading && !active && <p className="text-xs leading-relaxed text-muted-foreground">Run <code className="font-mono">gh auth login</code> on the BB server to connect GitHub. Local git reviews work without GitHub.</p>}
        {accounts.some((account) => !account.active) && <div className="space-y-1 border-t border-border pt-2">
          {accounts.map((account) => <Button key={account.login} variant="ghost" size="sm" className="w-full justify-between" disabled={switching !== null || account.active} aria-label={account.active ? `Current account @${account.login}` : `Use @${account.login} on this BB server`} onClick={() => void switchTo(account.login)}>
            <span className="flex min-w-0 items-center gap-2"><Avatar login={account.login} size={18} /><span className="truncate">{switching === account.login ? "Switching…" : `@${account.login}`}</span></span>
            {account.active && <Icon name="Check" className="size-4 text-primary" aria-hidden />}
          </Button>)}
        </div>}
      </PopoverContent>
    </Popover>
  );
});
AccountBar.displayName = "AccountBar";
