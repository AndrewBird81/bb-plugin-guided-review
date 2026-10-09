import { useCallback, useEffect, useState } from "react";
import { useRpc, useBbNavigate, experimental_PermissionModePicker as PermissionModePicker, experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { PreferencesRecord } from "../src/preferences";
import type { Machine } from "../src/machines";
import { defaultPreferences, type AgentExecution } from "../lib/review-preferences";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { useReviewSession } from "../lib/review-session";
import { ReleaseSettings, SetupReadiness } from "./ReleaseSettings";
import { Icon } from "./ui/icon";

type AgentUpdate = (agent: AgentExecution | null) => AgentExecution | null;
/** undefined while loading; null when they couldn't be loaded. */
type Machines = readonly Machine[] | null | undefined;

/** The bb server is the default machine, stored as no machine so the choice follows a server move. */
function MachineSelect({ hostId, machines, disabled, onChange }: {
  hostId?: string; machines: Machines; disabled: boolean; onChange(hostId: string | undefined): void;
}) {
  const server = machines?.find((machine) => machine.server);
  const others = machines?.filter((machine) => !machine.server) ?? [];
  const value = hostId && hostId !== server?.hostId ? hostId : "";
  return <label className="flex min-w-0 items-center gap-2 text-sm">
    <span className="text-muted-foreground">Machine</span>
    <select aria-label="Machine" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value || undefined)} className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground">
      <option value="">{server ? `${server.name} (server)` : "bb server"}</option>
      {others.map((machine) => <option key={machine.hostId} value={machine.hostId}>{machine.connected ? machine.name : `${machine.name} (offline)`}</option>)}
      {value && !others.some((machine) => machine.hostId === value) && <option value={value}>{machines ? "Removed machine" : value}</option>}
    </select>
  </label>;
}

function AgentSelection({ label, agent, machines, disabled, note, onCustomize, onChange }: {
  label: string; agent: AgentExecution | null; machines: Machines; disabled: boolean; note?: string;
  onCustomize(): void; onChange(update: AgentUpdate): void;
}) {
  // The pickers list the providers, models, and permission limit of the chosen machine.
  const routing = agent?.hostId ? { kind: "host" as const, hostId: agent.hostId } : undefined;
  return <div className="space-y-2">
    <p className="text-sm font-medium">Agent</p>
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" className="aria-pressed:border-foreground aria-pressed:bg-state-active" aria-pressed={!agent} onClick={() => onChange(() => null)}>Project defaults</Button>
      <Button variant="outline" size="sm" className="aria-pressed:border-foreground aria-pressed:bg-state-active" aria-pressed={!!agent} onClick={() => { if (!agent) onCustomize(); }}>Custom</Button>
    </div>
    {agent ? <div className="flex flex-wrap items-center gap-2">
      <MachineSelect hostId={agent.hostId} machines={machines} disabled={disabled} onChange={(hostId) => onChange((current) => {
        if (!current) return current;
        const { hostId: _previous, ...selection } = current;
        return hostId ? { hostId, ...selection } : selection;
      })} />
      <ProviderModelPicker disabled={disabled} routing={routing}
        value={{ providerId: agent.providerId, model: agent.model, reasoningLevel: agent.reasoningLevel, ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}) }}
        onChange={(next) => onChange((current) => current && { ...(current.hostId ? { hostId: current.hostId } : {}), providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel, permissionMode: current.permissionMode, ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}) })} />
      <PermissionModePicker disabled={disabled} routing={routing} providerId={agent.providerId} value={agent.permissionMode} onChange={(permissionMode) => onChange((current) => current && { ...current, permissionMode })} />
    </div> : <p className="text-xs text-muted-foreground">Runs on the bb server with the agent, model, effort, and permissions bb remembers for the project the review runs in.</p>}
    {agent && machines === null && <p className="text-xs text-muted-foreground">Couldn’t load your machines. Reload this page to choose another machine.</p>}
    {note && <p className="text-xs text-muted-foreground">{note}</p>}
  </div>;
}

// Plain function: the host slot collector requires a component function.
export function ReviewSettings({ onBack }: { onBack?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const session = useReviewSession();
  const [record, setRecord] = useState<PreferencesRecord | null>(null);
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [machines, setMachines] = useState<Machines>(undefined);
  useEffect(() => {
    rpc.call("listMachines", null).then((result) => setMachines(result.machines), () => setMachines(null));
  }, [rpc]);
  const load = useCallback(async () => {
    setError("");
    try { const result = await rpc.call("getPreferences", null); setRecord(result); setBaseline(JSON.stringify(result.preferences)); }
    catch { setError("Couldn’t load settings. Try again."); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  const dirty = record !== null && baseline !== JSON.stringify(record.preferences);
  // A custom selection is complete once the host pickers resolve a provider and model.
  const incomplete = [record?.preferences.guideAgent, record?.preferences.assistantAgent].some((agent) => agent && (!agent.providerId || !agent.model));
  function setAgent(key: "guideAgent" | "assistantAgent", update: AgentUpdate) {
    setSaved(false);
    // Functional: both pickers can report reconciled values in the same render.
    setRecord((current) => current && { ...current, preferences: { ...current.preferences, [key]: update(current.preferences[key]) } });
  }
  async function customize(key: "guideAgent" | "assistantAgent") {
    let seed: AgentExecution = { providerId: "", model: "", reasoningLevel: "medium", permissionMode: "auto" };
    try { seed = (await rpc.call("getAgentDefaults", null)).defaults ?? seed; }
    catch { /* The pickers resolve bb's own defaults from the empty seed. */ }
    setAgent(key, (agent) => agent ?? seed);
  }
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  async function save() {
    if (!record || busy || updating) return;
    setBusy(true); setError(""); setSaved(false);
    try { const result = await rpc.call("savePreferences", record); setRecord(result); setBaseline(JSON.stringify(result.preferences)); setSaved(true); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn’t save settings. Your edits are still here."); }
    finally { setBusy(false); }
  }
  if (!session.ready) return <div className="space-y-3 p-6"><p role={session.error ? "alert" : "status"}>{session.error || "Opening settings…"}</p>{session.error && <Button onClick={session.retry}>Try again</Button>}</div>;
  return <div className="h-full min-w-0 overflow-y-auto" style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
    <div className="mx-auto w-full max-w-6xl space-y-7 px-4 py-5 sm:px-8">
      <div className="space-y-3">
        {onBack && <Button variant="ghost" size="sm" onClick={onBack} disabled={dirty || busy || updating}><Icon name="ArrowRight" className="size-4 rotate-180" aria-hidden /> Back to review</Button>}
        <div><h1 className="text-xl font-semibold">Review settings</h1><p className="mt-1 text-sm text-muted-foreground">Shape your guides and how the assistant helps you review. Applies across this BB installation.</p></div>
      </div>
      <SetupReadiness />
      <ReleaseSettings clientId={session.clientId} disabled={dirty || busy} onUpdatingChange={setUpdating} />
      <section className="space-y-2 border-t border-border pt-5">
        <h2 className="text-sm font-semibold">Guide notifications</h2>
        <p className="text-sm text-muted-foreground">Needs You can alert you when a guide is ready or generation fails, with a link back to the review. Install or update Needs You to 0.2.0-beta.3 or later, then enable Extension activity in its Settings. Telegram is optional.</p>
        <a className="text-sm underline underline-offset-4" href="/plugins/inbox/inbox/settings" target="_blank" rel="noreferrer">Open Needs You settings</a>
      </section>
      {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button variant="outline" size="sm" disabled={busy || updating} onClick={() => void load()}>Reload saved settings</Button></div>}
      {!record ? !error && <p role="status">Loading settings…</p> : <>
        <fieldset disabled={busy || updating} className="space-y-6">
          <section className="space-y-4 border-t border-border pt-5">
            <div><h2 className="text-sm font-semibold">Guide generation</h2><p className="mt-1 text-sm text-muted-foreground">Used when starting a guide or running Re-review. Existing guides stay as written.</p></div>
            <AgentSelection label="Guide writer agent" agent={record.preferences.guideAgent} machines={machines} disabled={busy || updating} onCustomize={() => void customize("guideAgent")} onChange={(update) => setAgent("guideAgent", update)} />
            <div className="space-y-2"><p id="guide-detail-label" className="text-sm font-medium">Detail level</p><div role="group" aria-labelledby="guide-detail-label" className="flex flex-wrap gap-2">
              {(["concise", "standard", "detailed"] as const).map((value) => <Button key={value} variant="outline" size="sm" className="aria-pressed:border-foreground aria-pressed:bg-state-active" aria-pressed={record.preferences.guideDetail === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, guideDetail: value } }); }}>{value[0].toUpperCase() + value.slice(1)}</Button>)}
            </div></div>
            <label className="block space-y-2"><span className="text-sm font-medium">Guide instructions</span><Textarea aria-label="Guide instructions" maxLength={12000} rows={6} value={record.preferences.guideInstructions} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, guideInstructions: event.target.value } }); }} placeholder="Explain data migrations and compatibility. Keep tests with the behavior they cover. Write for engineers new to this repository." /><span className="block text-xs text-muted-foreground">Add review priorities, language, and team conventions. These extend the built-in guide skill.</span></label>
            <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">About the guide skill</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>The bundled skill reads the complete diff, organizes chapters by meaning, and covers every changed file exactly once. Custom instructions shape its explanations while the required output format stays validated.</p><p>Based on the chaptered walkthrough approach from <a className="underline underline-offset-4" href="https://github.com/plannotator/guides/blob/main/skills/plannotator-guide/SKILL.md" target="_blank" rel="noreferrer">Plannotator’s guide skill</a>, adapted for BB. Guides run through the agent selected above.</p></div></details>
          </section>
          <section className="space-y-4 border-t border-border pt-5">
            <div><h2 className="text-sm font-semibold">Review assistant</h2><p className="mt-1 text-sm text-muted-foreground">Applies to your next message, including conversations already in progress.</p></div>
            <AgentSelection label="Review assistant agent" agent={record.preferences.assistantAgent} machines={machines} disabled={busy || updating} note="Used to start new conversations, which stay on the machine they started on. In a conversation, change the model and effort per message." onCustomize={() => void customize("assistantAgent")} onChange={(update) => setAgent("assistantAgent", update)} />
            <label className="block space-y-2"><span className="text-sm font-medium">Assistant instructions</span><Textarea aria-label="Assistant instructions" maxLength={12000} rows={5} value={record.preferences.assistantInstructions} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, assistantInstructions: event.target.value } }); }} placeholder="Prioritize correctness and security. Show a concrete failure case for suspected bugs. Keep suggestions actionable." /></label>
          </section>
          <section className="space-y-3 border-t border-border pt-5">
            <div><h2 className="text-sm font-semibold">Reading layout</h2><p className="mt-1 text-sm text-muted-foreground">Choose the default diff layout. Narrow screens use a single column.</p></div>
            <div role="group" aria-label="Default diff layout" className="flex flex-wrap gap-2">{([ ["split", "Side by side"], ["unified", "Unified"] ] as const).map(([value, label]) => <Button key={value} variant="outline" size="sm" className="aria-pressed:border-foreground aria-pressed:bg-state-active" aria-pressed={record.preferences.diffLayout === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, diffLayout: value } }); }}>{label}</Button>)}</div>
          </section>
        </fieldset>
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-background py-4">
          <Button disabled={!dirty || incomplete || busy || updating} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</Button>
          {dirty && <Button variant="ghost" disabled={busy || updating} onClick={() => { setRecord({ ...record, preferences: JSON.parse(baseline) }); setError(""); }}>Discard edits</Button>}
          <span role="status" className="text-xs text-muted-foreground">{saved ? "Settings saved" : dirty ? "Unsaved changes" : ""}</span>
          <Button variant="ghost" size="sm" className="ml-auto" disabled={busy || updating} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...defaultPreferences } }); }}>Restore defaults</Button>
        </div>
      </>}
    </div>
  </div>;
}

export function ReviewSettingsPage({ returnTo = "" }: { returnTo?: string }) {
  const navigate = useBbNavigate();
  return <ReviewSettings onBack={() => navigate.toPluginPanel("review", { subPath: returnTo })} />;
}
