import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AgentExecution, ReviewPreferences } from "../lib/review-preferences";
export { defaultPreferences, type AgentExecution, type ReviewPreferences } from "../lib/review-preferences";

export const agentExecutionSchema = z.object({
  hostId: z.string().min(1).max(200).optional(),
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
  permissionMode: z.enum(["accept-edits", "auto", "full"]),
  serviceTier: z.string().min(1).max(200).optional(),
}).strict();
/** "*", "owner/*", or "owner/repo", as GitHub spells them. */
const REPO_PATTERN = /^(\*|[a-z0-9-]+\/(\*|[a-z0-9_.-]+))$/;

export const agentChoiceSchema = agentExecutionSchema.omit({ permissionMode: true });

export const preferencesSchema = z.object({
  guideDetail: z.enum(["concise", "standard", "detailed"]),
  guideInstructions: z.string().max(12000),
  assistantInstructions: z.string().max(12000),
  automaticReview: z.string().max(12000),
  diffLayout: z.enum(["split", "unified"]),
  guideAgent: agentExecutionSchema.nullable(),
  assistantAgent: agentExecutionSchema.nullable(),
  wakeOnReplies: z.enum(["questions", "any"]),
  pushChecks: z.enum(["off", "progress", "ready"]),
  trackGithubReviews: z.boolean(),
  autoStartRepos: z.array(z.string().trim().toLowerCase().regex(REPO_PATTERN, "Use owner/repo, owner/*, or *.")).max(50),
  verificationPrompt: z.string().max(12000),
}).strict();

export interface PreferencesRecord { preferences: ReviewPreferences; revision: number; }
export interface ReviewerNotesRecord { body: string; revision: number; }

type SpawnExecution = Pick<Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0],
  "providerId" | "model" | "reasoningLevel" | "permissionMode" | "serviceTier" | "executionInputSources">;

/**
 * Spawn fields for an agent selection; none for the project's remembered
 * defaults. Without a permission mode, bb resolves the provider's default.
 */
export function spawnExecution(agent: (Omit<AgentExecution, "permissionMode"> & Partial<Pick<AgentExecution, "permissionMode">>) | null): SpawnExecution {
  if (!agent) return {};
  const explicit = "explicit" as const;
  return {
    providerId: agent.providerId, model: agent.model, reasoningLevel: agent.reasoningLevel,
    ...(agent.permissionMode ? { permissionMode: agent.permissionMode } : {}),
    ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}),
    // Unsourced values are replaced with the project's remembered defaults.
    executionInputSources: {
      providerId: explicit, model: explicit, reasoningLevel: explicit,
      ...(agent.permissionMode ? { permissionMode: explicit } : {}),
      ...(agent.serviceTier ? { serviceTier: explicit } : {}),
    },
  };
}

export function guidePreferencesPrompt(preferences: ReviewPreferences): string {
  const detail = {
    concise: "Concise guide: use two short sentences per chapter and brief file summaries.",
    standard: "Standard guide: explain each chapter's change, motivation, and key implications in 2–6 sentences.",
    detailed: "Detailed guide: explain behavioral implications, important contracts, risks, and what deserves a closer read. Use up to six substantive sentences per chapter; keep low-signal changes brief.",
  }[preferences.guideDetail];
  return `${detail}\n${preferences.guideInstructions.trim() ? `Reviewer’s guide instructions:\n${preferences.guideInstructions.trim()}\n` : ""}Keep the required guide schema, exact file coverage, target key, and generation ID unchanged.`;
}

export function assistantPreferencesPrompt(preferences: ReviewPreferences): string {
  return `Current reviewer preferences (replace any earlier preferences):\n${preferences.assistantInstructions.trim() || "Answer concisely, ground claims in the diff, and explain uncertainty. Keep draft comments terse and skip nitpicks."}\nNever post to GitHub, modify code, or include private reviewer notes. Put line feedback in the reviewer's draft with add_draft_comment; only the reviewer submits it.`;
}
