---
name: Guided Review — BB-native Operate surface
description: BB theme tokens, with one semantic tone per status, applied to the review list and chapter workspace.
colors:
  background: "var(--background)"
  foreground: "var(--foreground)"
  card: "var(--card)"
  muted: "var(--muted)"
  muted-foreground: "var(--muted-foreground)"
  border: "var(--border)"
  input: "var(--input)"
  ring: "var(--ring)"
  destructive: "var(--destructive)"
  state-hover: "var(--state-hover)"
  state-active: "var(--state-active)"
  primary: "var(--primary)"
  success: "var(--success)"
  success-text: "var(--diff-added)"
  warning: "var(--warning)"
  warning-text: "var(--warning-text)"
  danger-text: "var(--destructive-text)"
  merged: "var(--pr-merged)"
  agent: "var(--ansi-13)"
rounded:
  control: "calc(var(--radius) - 2px)"
  review-card: "calc(var(--radius) + 4px)"
  start-panel: "var(--radius-2xl)"
components:
  primary-button:
    backgroundColor: "{colors.primary}"
    textColor: "var(--primary-foreground)"
    rounded: "{rounded.control}"
  review-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.review-card}"
---

# Guided Review interface

## Overview

This records the incumbent **Operate** surface inside BB. [app.tsx](app.tsx) registers the sidebar panel; [ReviewList](components/ReviewList.tsx) and [ReviewWorkspace](components/ReviewWorkspace.tsx) provide its two working views. The design inherits BB’s typography, semantic colors, controls, and code themes. It establishes no separate marketing identity.

## Colors

The frontmatter retains live host token references so light and dark themes remain authoritative; no palette colors or `dark:` variants are used. Neutral surfaces, text tiers, borders, and hover/active fills carry the layout. Color marks meaning, in small doses, through one tone per status ([Badge](components/ui/badge.tsx)): primary for the main action, focus, the open chapter, and "ready"; success for approved, passing, and viewed; warning for in progress, pending, medium risk, and changes requested; danger for failures, closed PRs, and high risk; merged for merged PRs; agent (the terminal's bright magenta) for anything the assistant wrote or does. Fills are 10–15% tints; text uses the theme's contrast-safe text roles (`diff-added`, `warning-text`, `destructive-text`). Status text and icons accompany color.

[DiffViewer](components/DiffViewer.tsx) uses BB’s light/dark code-theme names when supplied and receives the current mode from the SDK. Preserve that connection rather than hardcoding a syntax palette.

## Typography

Interface text inherits the BB sans family; file paths, repositories, branches, line references, and CLI examples use monospace, with a path's directory dimmed so its file name leads. Agent-written text (the guide's intent, comments, discussions, and assistant answers) renders through BB's Markdown, as in chat; titles and chapter summaries render their `code` spans inline. The list title uses the host extra-large scale, increasing one step on larger screens. Review titles and controls predominantly use the small scale, with extra-small metadata and compact 10–11px badges. Headings rely on medium/semibold weight and modest size changes. Keep explanations readable and reserve truncation for titles and paths with constrained space.

## Layout

The list is a centered column up to 1152px wide, with 16px padding, increasing to 24px at the small breakpoint. Account context precedes the PR form and first-run disclosure. Saved reviews sit in one bordered list whose header holds the filters and Refresh; each row has a PR-state tile (GitHub's open, merged, and closed colors), the title, repository, author avatar, and age, a status badge, the next action on hover, and a trailing Review actions menu (Archive or Unarchive, Delete). Needs review, Waiting on author, Reviewed, and Archive filters separate your turn, the author's turn, settled verdicts, and merged, closed, or reviewer-archived reviews. Needs review lists the blocker first and the longest-waiting next, with team requests under their own subheading. A row's second line adds only what changes the decision to open it: why it came back (and who asked), feedback progress, new commits, CI, how long it has been your turn, and Blocks merge. The Review actions menu adds Not yet and Back to Needs review, and Start review for a review found on GitHub. There is no duplicate resume card. The input and primary action stack on narrow screens.

The workspace fills the panel’s height and width. Desktop chapters occupy a resizable sidebar, initially 288px and constrained to 200–560px, beside the flexible diff/thread pane. The separator supports pointer dragging and keyboard adjustment. Focus mode reduces header detail; fullscreen expands the workspace.

At widths of 767px or less, chapters become a collapsible full-width section capped at 40vh, controls wrap, and diffs switch from split to unified. Diffs are also unified whenever their pane is narrower than 720px, so neither side of a split clips its code. Long code scrolls within its file container. The draft tray remains independently scrollable with a 48vh maximum height.

## Elevation & Depth

Thin host borders separate the header, chapters, toolbar, diff files, and draft tray. Cards (the review list, diff files, draft comments, settings sections) use the host card surface with a hairline shadow; the chapter sidebar and tool rail sit on the raised surface. Diff file headers stick to the top of the scrolling diff. Review rows use a quiet hover fill; the floating review-agent window uses stronger elevation. Button fills respond immediately on hover and transition out over 150ms through the shared motion helper. Loading icons and the agent dock include reduced-motion handling.

## Shapes

Controls use the host medium radius; cards and icon tiles use the large radius. Pills identify state, risk, CI, and file kind. A colored left edge says whose a comment is: primary for the reviewer's, agent for the assistant's. Icons remain compact and secondary to the task labels.

## Components

- **Account and onboarding:** keep the title, compact GitHub account control, and Settings on one header line. Account switching and authentication guidance live in the account popover; Review help sits beside the CLI hint. At narrow widths, account and Settings retain accessible icon controls instead of wrapping.
- **Review workspace:** the header shows the PR's state tile, title link, CI and status pills, and Re-review on one line, then the author, repository, and branches, then the guide's intent (clamped, with more/less) beside a primary rule. A review you've already reviewed adds its rounds (verdict and age, newest last), a feedback-progress pill that opens the Feedback view, Blocks merge, and Not yet while it's your turn. Chapters are numbered steps on a path: each marker's ring fills green as its files are viewed, the open chapter is solid primary, and a finished one shows a check; a bar above them totals the review's viewed files. Chapters expose file summaries and risk labels; the toolbar switches Diff, Feedback, and Threads and controls viewed state, focus, and fullscreen. Since your review narrows the diff to hunks changed since your last review, marks new lines, and hides unchanged files behind a count; file headers and chapters mark files changed since your review either way. File headers show the path, file kind, draft-comment count, additions and deletions with BB's size bar, and a Viewed toggle that turns green. Viewed files collapse, while changed-file indicators preserve re-review context.
- **Draft and agent:** a review panel sits beside the diff when the plugin has at least 1024px available, and below it otherwise. Draft comments and Reviewer notes are distinct views. Line comments also render in the diff under their lines, as compact cards with Edit and Remove; the gutter "+" or a line selection opens the comment box there, and only one comment is written at a time. Choosing a comment in the panel scrolls to its line, opening a collapsed file; file headers count their draft comments, and comments drafted against an older diff carry an Older diff badge. A line can also hold a discussion with the assistant, apart from its comment: Ask agent on a comment, in the comment box, or on selected lines sends the reviewer's message with the line's context to the review's conversation, and the assistant answers in the discussion or changes the comment there; its changes show in the discussion. The card says while it's waiting, and when the assistant finished without answering there. A comment the assistant removes leaves its discussion until the reviewer dismisses it; removing a comment removes its discussion. Discussions never reach GitHub, and submitting clears them. The public Review summary stays with the submission controls. Comments that agents add, edit, or delete change in an open draft as it happens. An agent's comment is labeled Added by agent until the reviewer edits it. Submit refuses comments the page hasn't shown. Reviewer notes never enter GitHub or assistant payloads and stay accessible for submitted/archived reviews. Approve, Comment, and Request changes are visible quick-selection buttons with a highlighted selection; Submit to GitHub remains explicit. A saved receipt replaces the empty submission form after sending. Merged and closed PRs retain their guide, conversation, and unsent drafts in Archive; local reviews show installation-local notes. The Ask agent tool shows the review's hidden BB thread with BB's own chat; file or selected-text context is quoted into its composer, as are selected lines once a review is archived, and the first message chooses the agent. Pop out moves the same chat into a draggable, resizable widget; Dock returns it to the panel. BB keeps the draft and any answer in progress across both moves. The thread stays hidden from the BB sidebar.
- **Feedback:** one card per thread you started, and per ask from your review summary, ordered by what still needs you. Each shows the assistant's verdict (agent tone when the assistant wrote it; success, warning, or danger by meaning), the thread's GitHub state, your comment, the author's latest replies, and the assistant's one-line evidence, with Resolve, Reply, Follow up, and Show in diff. A reply the assistant drafted is labeled until you edit it. The header tallies what's addressed and when it was checked, with Check again and Refresh; the suggested verdict sits last, with Use as draft and Request what's left. Nothing on this view posts to GitHub without an explicit Send or Resolve.
- **Recovery:** loading skeletons reflect the workspace structure. Load and generation failures offer retry/back actions; draft-load failure pauses editing. Errors stay visible near the relevant action or in an alert/toast, and submission failures preserve the draft.

## Do's and Don'ts

- Do reuse host tokens, shared controls, visible focus, and explicit loading/error states.
- Do retain full-width workspace use, responsive chapter access, and unified narrow diffs.
- Do keep color semantic: one tone per meaning, as tints and small marks, never as large fills.
- Do make server account scope and GitHub write actions clear where users act.
- Don’t imply separate team accounts, remote-machine checkout support, or shared review storage beyond the actual BB installation.

## Review lifecycle

Generation and the submitted verdict are stored separately. Successful submissions survive refresh and regeneration. A supervised service reads GitHub in batches (every two minutes for reviews in progress, sooner when GitHub notifies about a PR); Refresh and returning focus to the list also reconcile state. Only the authenticated viewer’s review supplies their verdict: their latest approve or changes-requested review, never a reply. Whose turn it is comes from one pure rule set (lib/turn.ts) shared by the server and the panel. A push alone never makes it the reviewer's turn; a re-request, a question or mention, feedback handled after new commits, or (opt-in) the assistant's all-addressed check does. Not yet waits for a newer reason. Each reason alerts once through Needs You, after the re-review is prepared, and opening or acting on the review clears it. Terminal PRs appear in Archive and offer View review. A reviewer-archived review stays in Archive through new commits until Unarchive, a restart (new PR link, `bb review`, Re-review), or a re-request. Delete is permanent and confirmed in a dialog. Fullscreen selects, popovers, dialogs, and drawers portal into the fullscreen subtree.

## Review customization

Settings are accessible from the list, workspace, and BB plugin settings. Separate guide generation, assistant behavior, whose turn, and reading layout into simple sections. Settings are explicit-save, and restoring defaults is staged. Private notes autosave with recoverable text and non-destructive conflict comparison. Keep Ask agent beside draft comments and reviewer notes in a 44px activity rail. On desktop, the rail stays on the right and the open sidebar uses 384px including the rail. Clicking the active icon or its close control collapses the panel while preserving mounted editors; clicking another icon opens that tool. Persist the selected tool and open state per review. Show accessible tooltips, a draft-count badge, and an active indicator. Below 1024px of plugin width, use a horizontal rail above the panel and combine its label and close control in that row. A toolbar shortcut opens Ask agent with current-file context. An optional widget stays within the fullscreen root; Dock returns to the tab, including when the panel was hidden. Derive an opaque page background from the host background color so a translucent host theme cannot show the mobile sidebar through the review.
