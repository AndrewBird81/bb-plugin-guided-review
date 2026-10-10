import { useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { ReleaseStatus } from "../src/plugin-updates";
import { Button } from "./ui/button";
import { Badge, TONE_TEXT, type Tone } from "./ui/badge";
import { Icon, type IconName } from "./ui/icon";
import { IconTile } from "./ui/icon-tile";
import { cn } from "../lib/utils";

const descriptions: Record<ReleaseStatus["outcome"], string> = {
  unchecked: "Check for a compatible release.",
  current: "You’re on the latest compatible release.",
  "update-available": "A compatible release is available.",
  incompatible: "A newer release needs a newer BB or Node version. Update your BB server, then check again.",
  pinned: "This is a local or pinned installation. Marketplace installations can follow compatible releases.",
  unavailable: "Updates could not be resolved. Check your connection and try again.",
};

const outcomeLook: Record<ReleaseStatus["outcome"], { tone: Tone; icon: IconName }> = {
  unchecked: { tone: "neutral", icon: "Info" },
  current: { tone: "success", icon: "CircleCheck" },
  "update-available": { tone: "primary", icon: "PackageReceive" },
  incompatible: { tone: "warning", icon: "AlertTriangle" },
  pinned: { tone: "neutral", icon: "Info" },
  unavailable: { tone: "warning", icon: "AlertTriangle" },
};

export function ReleaseSettings({ clientId, disabled, onUpdatingChange }: { clientId: string; disabled: boolean; onUpdatingChange?: (updating: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void rpc.call("getReleaseStatus", null).then(setStatus).catch(() => setError("Couldn’t load update settings. Check again.")); }, [rpc]);
  async function perform(action: "check" | "update" | "toggle") {
    if (busy) return;
    setBusy(action); setError(""); setMessage("");
    if (action === "update") onUpdatingChange?.(true);
    try {
      if (action === "check") setStatus(await rpc.call("checkPluginUpdates", null));
      else if (action === "toggle" && status) setStatus(await rpc.call("setAutomaticUpdates", { enabled: !status.automatic }));
      else if (status?.candidateVersion) {
        const result = await rpc.call("applyPluginUpdate", { clientId, candidateVersion: status.candidateVersion });
        if (result.outcome === "rolled-back") setError("The update failed and BB restored the previous version. Check for updates before retrying.");
        else { setMessage(result.outcome === "updated" ? `Updated${result.version ? ` to ${result.version}` : ""}. Reopen Guided Review to load it.` : "Already on the latest compatible release."); await rpc.call("getReleaseStatus", null).then(setStatus).catch(() => {}); }
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Couldn’t complete the update. Your reviews stay saved in BB."); }
    finally { setBusy(""); if (action === "update") onUpdatingChange?.(false); }
  }
  return <section aria-label="Plugin updates" className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-3"><IconTile tone="primary" icon="PackageReceive" /><h2 className="text-sm font-semibold">Plugin updates</h2></div>{status && <Badge className="font-mono">v{status.installedVersion}</Badge>}</div>
    {status && <p className={cn("flex max-w-[75ch] items-start gap-2 text-sm", TONE_TEXT[outcomeLook[status.outcome].tone])}><Icon name={outcomeLook[status.outcome].icon} className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{descriptions[status.outcome]}{status.latestVersion ? ` Latest: ${status.latestVersion}.` : ""}</span></p>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void perform("check")}>{busy === "check" ? "Checking…" : "Check for updates"}</Button>
      {status?.outcome === "update-available" && <Button size="sm" disabled={!!busy || disabled} onClick={() => void perform("update")}>{busy === "update" ? "Updating…" : "Update now"}</Button>}
      <a className="self-center text-xs text-muted-foreground underline underline-offset-4" href="https://github.com/notpritam/bb-plugin-guided-review/releases" target="_blank" rel="noreferrer">Release notes</a>
    </div>
    {disabled && <p className="text-xs text-muted-foreground">Save or discard your settings edits before updating.</p>}
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 accent-(--primary)" checked={status?.automatic ?? false} disabled={!status || !!busy || (status.outcome === "pinned" && !status.automatic)} onChange={() => void perform("toggle")} /><span><span className="font-medium">Update automatically when idle</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">Off by default. Checks hourly after five idle minutes, once all review and Settings pages are closed. Installs the latest compatible release through BB; saved reviews, drafts, notes, and preferences stay in place.</span></span></label>
    {(error || status?.error) && <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />{error || status?.error}</p>}
    {message && <p role="status" className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-diff-added"><Icon name="CircleCheck" className="mt-0.5 size-4 shrink-0" aria-hidden />{message}</p>}
  </section>;
}

/** One setup check: OK, needs action, or unknown (null). */
function ReadinessRow({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const icon: IconName = ok === true ? "CircleCheck" : ok === false ? "AlertTriangle" : "CircleQuestion";
  const color = ok === true ? "text-diff-added" : ok === false ? "text-warning-text" : "text-muted-foreground";
  return <li className="flex items-start gap-2.5 bg-background/40 px-3 py-2.5"><Icon name={icon} className={cn("mt-0.5 size-4 shrink-0", color)} aria-hidden /><span className="min-w-0">{children}</span></li>;
}

export function SetupReadiness() {
  const rpc = useRpc<typeof rpcContract>();
  const [setup, setSetup] = useState<{ account: string | null; githubCli: boolean; agentAvailable: boolean | null; projectAvailable: boolean | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function check() {
    setBusy(true); setError("");
    try { setSetup(await rpc.call("getSetupStatus", null)); } catch { setError("Couldn’t check setup. Try again."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void check(); }, [rpc]);
  return <section aria-label="Setup" className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-xs">
    <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><IconTile tone="primary" icon="BadgeCheck" /><h2 className="text-sm font-semibold">Ready to review</h2></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check setup"}</Button></div>
    <p className="max-w-[75ch] text-sm text-muted-foreground">Connect GitHub on the machine running BB, then paste a PR link. Guides use your BB agent and its normal usage allowance.</p>
    {setup && <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
      <ReadinessRow ok={setup.githubCli}>{setup.githubCli ? "GitHub CLI installed" : "Install GitHub CLI on the BB server."}</ReadinessRow>
      <ReadinessRow ok={!!setup.account}>{setup.account ? <>GitHub account: <strong>@{setup.account}</strong></> : <>Sign in on the BB server: <code className="break-all text-xs">gh auth login --hostname github.com</code></>}</ReadinessRow>
      <ReadinessRow ok={setup.agentAvailable}>{setup.agentAvailable === true ? "BB agent available" : setup.agentAvailable === false ? "Connect an agent provider in BB Settings before generating a guide." : "Couldn’t verify the agent provider. Check BB Settings."}</ReadinessRow>
      {setup.projectAvailable !== true && <ReadinessRow ok={setup.projectAvailable}>{setup.projectAvailable === false ? "Add a BB project before starting a review." : "Couldn’t verify the BB project. Check your project list."}</ReadinessRow>}
    </ul>}
    <p className="max-w-[75ch] text-xs leading-relaxed text-muted-foreground">Use your own BB installation for your own GitHub identity. On a shared installation, account selection and saved reviews are shared. The selected account must have access to the PR repository.</p>
    {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>}
  </section>;
}
