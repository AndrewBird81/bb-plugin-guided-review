// Shared defaults have no validation/runtime dependencies in the app bundle.

/** A custom agent selection, in bb's terms. Service tiers are provider-defined ids. */
export interface AgentExecution {
  /** The machine the agent runs on; absent runs it on the bb server. */
  hostId?: string;
  providerId: string;
  model: string;
  reasoningLevel: "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra";
  permissionMode: "accept-edits" | "auto" | "full";
  serviceTier?: string;
}

export interface ReviewPreferences {
  guideDetail: "concise" | "standard" | "detailed";
  guideInstructions: string;
  assistantInstructions: string;
  diffLayout: "split" | "unified";
  /** null uses the execution defaults bb remembers for the review's project. */
  guideAgent: AgentExecution | null;
  assistantAgent: AgentExecution | null;
}

export const defaultPreferences: ReviewPreferences = {
  guideDetail: "standard", guideInstructions: "", assistantInstructions: "", diffLayout: "split",
  guideAgent: null, assistantAgent: null,
};
