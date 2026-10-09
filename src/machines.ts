import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AgentExecution } from "./preferences";

/** A machine an agent can run on, as Review settings lists it. */
export interface Machine { hostId: string; name: string; connected: boolean; server: boolean; }

type Placement = Pick<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0], "projectId" | "environment">;
type Host = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["get"]>>;

const removed = (host: Pick<Host, "lifecycle">) => host.lifecycle.phase === "removing" || host.lifecycle.phase === "destroyed";

async function findHost(bb: BbPluginApi, hostId: string): Promise<Host | null> {
  return bb.sdk.hosts.get({ hostId }).catch((error) => {
    if ((error as { status?: number } | null)?.status === 404 || String(error).includes("HTTP 404")) return null;
    throw error;
  });
}

/** Persistent machines, the bb server first. */
export async function listMachines(bb: BbPluginApi): Promise<Machine[]> {
  const [hosts, config] = await Promise.all([bb.sdk.hosts.list({ type: "persistent" }), bb.sdk.system.config().catch(() => null)]);
  return hosts.filter((host) => !removed(host))
    .map((host) => ({ hostId: host.id, name: host.name, connected: host.status === "connected", server: host.id === config?.primaryHostId }))
    .sort((a, b) => Number(b.server) - Number(a.server) || a.name.localeCompare(b.name));
}

/**
 * Where an agent's thread runs. By default bb places it in the review's project
 * on the server. On a chosen machine it uses that machine's personal workspace,
 * which bb offers only in the personal project; the agents read the review
 * through plugin tools, so they need no checkout.
 */
export async function agentPlacement(bb: BbPluginApi, agent: Pick<AgentExecution, "hostId"> | null, projectId: string): Promise<Placement> {
  if (!agent?.hostId) return { projectId, environment: { type: "project-default" } };
  const personal = (await bb.sdk.projects.list({ includePersonal: true })).find((project) => project.kind === "personal");
  if (!personal) throw new Error("bb has no personal project to run the agent in.");
  return { projectId: personal.id, environment: { type: "host", hostId: agent.hostId, workspace: { type: "personal" } } };
}

/** Why an agent can't start on its chosen machine now, or null when it can. */
export async function machineUnavailable(bb: BbPluginApi, agent: Pick<AgentExecution, "hostId"> | null, role: string): Promise<string | null> {
  if (!agent?.hostId) return null;
  const host = await findHost(bb, agent.hostId);
  if (!host || removed(host)) return `The machine chosen for the ${role} was removed. Choose another in Review settings.`;
  if (host.status !== "connected") return `${host.name} is offline. Wake it, or choose another machine for the ${role} in Review settings.`;
  return null;
}

/** A chosen machine's name and connection for display; null when unknown. */
export async function machineStatus(bb: BbPluginApi, hostId: string | undefined): Promise<{ name: string; connected: boolean } | null> {
  if (!hostId) return null;
  const host = await findHost(bb, hostId).catch(() => null);
  return host && !removed(host) ? { name: host.name, connected: host.status === "connected" } : null;
}
