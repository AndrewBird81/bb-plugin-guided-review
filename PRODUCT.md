# Guided Review

Guided Review is a BB plugin for understanding a GitHub pull request or local Git change through an agent-authored chapter guide. Reviewers inspect diffs, track viewed files, ask an agent about the change, and prepare comments and a verdict in the same workspace. Its incumbent interface is an **Operate** surface inside BB: the review list starts or resumes work, and the chapter workspace supports the review itself.

## Workflow

The panel accepts complete `github.com` pull-request URLs. The `bb review` command also accepts PR numbers and local Git references when run from a project checkout. A configured BB coding-agent provider generates the guide, with every changed file assigned to one chapter.

First-run help explains provider setup, server-side GitHub authentication, local reviews, and submission. Account checks, review loading, generation, draft loading, saves, and submission expose visible failure states and recovery actions. A failed draft load pauses editing; a failed submission retains the draft.

Drafts stay in BB until the reviewer explicitly submits a GitHub verdict. Replies to existing threads and resolve actions are separate immediate GitHub writes. Reviews are pinned to the inspected PR snapshot; changed patches require re-review, and drafts whose lines are gone must be replaced before submission. The list tracks whose turn each review is: a push alone never makes it the reviewer's turn, while a re-request, a question, or handled feedback does, with one Needs You alert. On re-review the assistant checks each piece of the reviewer's earlier feedback against what changed, and the reviewer decides; replies, resolves, and verdicts still post only on explicit action. Local reviews retain notes in BB and have no GitHub submission action.

## Distribution and operating limits

The release candidate records version **0.2.0**, BB **0.41.0+**, Node **24+**, and plugin SDK **0.4.34+**. Reviewers need their own BB installation and GitHub authentication. It does not provide shared review workspaces or separate user accounts within one server.

Git and `gh` run on the BB server. Local review checkouts must exist there; a checkout only on another enrolled machine is unsupported. GitHub features currently support `github.com`. Account switching affects that server’s `gh` credentials, including other consumers; environment-token overrides must be cleared before switching saved accounts.

Metadata, patches, guides, and drafts reside in the installation’s plugin database. Review agents receive context through the configured provider. Sharing a BB server shares its credentials and plugin storage. See [README.md](README.md) for installation and operations, and [DESIGN.md](DESIGN.md) for the current interface system.

## Updates

The plugin uses BB’s native compatibility checks, installation, and rollback. Manual update controls live in Settings. Automatic updates are opt-in and wait for five idle minutes with no open review/Settings pages and no active work. Unsaved public drafts have per-tab recovery with their original review revision; private notes remain separate.
