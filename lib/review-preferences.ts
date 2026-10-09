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
  /** The assistant's first message once a review's guide is ready and it has no conversation; blank skips it. */
  automaticReview: string;
  diffLayout: "split" | "unified";
  /** null uses the execution defaults bb remembers for the review's project. */
  guideAgent: AgentExecution | null;
  assistantAgent: AgentExecution | null;
}

export const defaultPreferences: ReviewPreferences = {
  guideDetail: "standard", guideInstructions: "", assistantInstructions: "",
  automaticReview: "Review this change adversarially. Look up related code or PRs when you need context.\nAdd each finding as an inline draft comment with add_draft_comment. Put general points in your reply.\nKeep every comment terse. Skip nitpicks.",
  diffLayout: "split", guideAgent: null, assistantAgent: null,
};
