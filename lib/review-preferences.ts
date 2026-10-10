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
  /** Which author replies on your threads make a review your turn: questions for you, or any reply. */
  wakeOnReplies: "questions" | "any";
  /** After the author pushes, the assistant checks your feedback: never, to show progress, or also to bring the review back when everything is addressed. */
  pushChecks: "off" | "progress" | "ready";
  /** Track PRs you're asked to review or have reviewed on GitHub, not only reviews started in bb. */
  trackGithubReviews: boolean;
  /** Start a guide when your review is requested in these repositories: "owner/repo", "owner/*", or "*". */
  autoStartRepos: string[];
  /** The assistant's first message when a review comes back to you; blank turns the automatic check off. */
  verificationPrompt: string;
}

export const defaultPreferences: ReviewPreferences = {
  guideDetail: "standard", guideInstructions: "", assistantInstructions: "",
  automaticReview: "Review this change adversarially. Look up related code or PRs when you need context.\nAdd each finding as an inline draft comment with add_draft_comment. Put general points in your reply.\nKeep every comment terse. Skip nitpicks.",
  diffLayout: "split", guideAgent: null, assistantAgent: null,
  wakeOnReplies: "questions", pushChecks: "off", trackGithubReviews: true, autoStartRepos: [],
  verificationPrompt: "Check whether the author properly addressed each piece of my earlier feedback. Start with list_feedback and read_changes_since_review, and read files with read_file when you need context.\nRecord a verdict with one line of evidence for every item with assess_feedback.\nThen look for new problems the fix commits introduce, and add each as an inline draft comment.\nDraft a short reply for each of my threads with draft_thread_reply. Keep everything terse.",
};
