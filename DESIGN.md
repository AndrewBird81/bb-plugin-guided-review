---
name: Guided Review — BB-native Operate surface
description: Existing BB theme and controls applied to the review list and chapter workspace.
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
rounded:
  control: "calc(var(--radius) - 2px)"
  review-card: "calc(var(--radius) + 4px)"
  start-panel: "var(--radius-2xl)"
components:
  primary-button:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
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

The frontmatter retains live host token references so light and dark themes remain authoritative. Background and card surfaces, muted supporting text, borders, focus rings, hover/active fills, and destructive feedback all use those roles. Small PR/local-type marks and status badges add localized violet, sky, amber, emerald, and destructive treatments with explicit dark variants. Status text and icons accompany color.

[DiffViewer](components/DiffViewer.tsx) uses BB’s light/dark code-theme names when supplied and receives the current mode from the SDK. Preserve that connection rather than hardcoding a syntax palette.

## Typography

Interface text inherits the BB sans family; file paths, line references, and CLI examples use monospace. The list title uses the host extra-large scale, increasing one step on larger screens. Review titles and controls predominantly use the small scale, with extra-small metadata and compact 10–11px badges. Headings rely on medium/semibold weight and modest size changes. Keep explanations readable and reserve truncation for titles and paths with constrained space.

## Layout

The list fills the available panel width with 16px padding, increasing to 24px at the small breakpoint. Account context precedes the PR form and first-run disclosure. Saved reviews use full-width rows with aligned titles, repository metadata, state, one next action, and a trailing Review actions menu (Archive or Unarchive, Delete). Needs review, Reviewed, and Archive filters separate unfinished work, submitted verdicts, and merged, closed, or reviewer-archived reviews. There is no duplicate resume card. The input and primary action stack on narrow screens.

The workspace fills the panel’s height and width. Desktop chapters occupy a resizable sidebar, initially 288px and constrained to 200–560px, beside the flexible diff/thread pane. The separator supports pointer dragging and keyboard adjustment. Focus mode reduces header detail; fullscreen expands the workspace.

At widths of 767px or less, chapters become a collapsible full-width section capped at 40vh, controls wrap, and diffs switch from split to unified. Long code scrolls within its file container. The draft tray remains independently scrollable with a 48vh maximum height.

## Elevation & Depth

Thin host borders separate the header, chapters, toolbar, diff files, and draft tray. Review rows use a quiet hover fill; the floating review-agent window uses stronger elevation. Button fills respond immediately on hover and transition out over 150ms through the shared motion helper. Loading icons and the agent dock include reduced-motion handling.

## Shapes

Controls and diff frames use the host medium radius; review rows and the start form use spacing and thin separators instead of enclosing cards. Pills identify review state. Icons remain compact and secondary to the task labels.

## Components

- **Account and onboarding:** keep the title, compact GitHub account control, and Settings on one header line. Account switching and authentication guidance live in the account popover; Review help sits beside the CLI hint. At narrow widths, account and Settings retain accessible icon controls instead of wrapping.
- **Review workspace:** chapters expose file summaries and risk labels; the toolbar switches Diff/Threads and controls viewed state, focus, and fullscreen. Viewed files collapse, while changed-file indicators preserve re-review context.
- **Draft and agent:** a review panel sits beside the diff when the plugin has at least 1024px available, and below it otherwise. Draft comments and Reviewer notes are distinct views. Line comments also render in the diff under their lines, as compact cards with Edit and Remove; the gutter "+" or a line selection opens the comment box there, and only one comment is written at a time. Choosing a comment in the panel scrolls to its line, opening a collapsed file; file headers count their draft comments, and comments drafted against an older diff carry an Older diff badge. The public Review summary stays with the submission controls. Comments that agents add, edit, or delete change in an open draft as it happens. An agent's comment is labeled Added by agent until the reviewer edits it. Submit refuses comments the page hasn't shown. Reviewer notes never enter GitHub or assistant payloads and stay accessible for submitted/archived reviews. Approve, Comment, and Request changes are visible quick-selection buttons with a highlighted selection; Submit to GitHub remains explicit. A saved receipt replaces the empty submission form after sending. Merged and closed PRs retain their guide, conversation, and unsent drafts in Archive; local reviews show installation-local notes. The Ask agent tool shows the review's hidden BB thread with BB's own chat; file or selected-line context is quoted into its composer, and the first message chooses the agent. Pop out moves the same chat into a draggable, resizable widget; Dock returns it to the panel. BB keeps the draft and any answer in progress across both moves. The thread stays hidden from the BB sidebar.
- **Recovery:** loading skeletons reflect the workspace structure. Load and generation failures offer retry/back actions; draft-load failure pauses editing. Errors stay visible near the relevant action or in an alert/toast, and submission failures preserve the draft.

## Do's and Don'ts

- Do reuse host tokens, shared controls, visible focus, and explicit loading/error states.
- Do retain full-width panel use, responsive chapter access, and unified narrow-screen diffs.
- Do make server account scope and GitHub write actions clear where users act.
- Don’t imply separate team accounts, remote-machine checkout support, or shared review storage beyond the actual BB installation.

## Review lifecycle

Generation and the submitted verdict are stored separately. Successful submissions survive refresh and regeneration. A supervised service checks GitHub once per minute; Refresh and returning focus to the list also reconcile state. Only the authenticated viewer’s review supplies their verdict. New commits retain the earlier verdict while returning the item to Needs review. Terminal PRs appear in Archive and offer View review. A reviewer-archived review stays in Archive through new commits until Unarchive or a restart (new PR link, `bb review`, Re-review). Delete is permanent and confirmed in a dialog. Fullscreen selects, popovers, dialogs, and drawers portal into the fullscreen subtree.

## Review customization

Settings are accessible from the list, workspace, and BB plugin settings. Separate guide generation, assistant behavior, and reading layout into simple sections. Settings are explicit-save, and restoring defaults is staged. Private notes autosave with recoverable text and non-destructive conflict comparison. Keep Ask agent beside draft comments and reviewer notes in a 44px activity rail. On desktop, the rail stays on the right and the open sidebar uses 384px including the rail. Clicking the active icon or its close control collapses the panel while preserving mounted editors; clicking another icon opens that tool. Persist the selected tool and open state per review. Show accessible tooltips, a draft-count badge, and an active indicator. Below 1024px of plugin width, use a horizontal rail above the panel and combine its label and close control in that row. A toolbar shortcut opens Ask agent with current-file context. An optional widget stays within the fullscreen root; Dock returns to the tab, including when the panel was hidden. Derive an opaque page background from the host background color so a translucent host theme cannot show the mobile sidebar through the review.
