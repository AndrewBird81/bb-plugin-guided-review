# Guided Review

An agent-authored walkthrough of a GitHub pull request or local Git change, inside [BB](https://getbb.app). Read the change in chapters, inspect the diff, ask questions, and prepare your review in one workspace.

**v0.2.1.** Each reviewer uses their own BB installation and GitHub identity. On a shared BB server, credentials, settings, and saved reviews are shared.

## Install and first run

You need **BB 0.41+ with Node 24+**, a configured BB agent provider, and `git` and GitHub CLI (`gh`) on the **machine running BB**. GitHub features support github.com. Installation uses prebuilt bundles; no npm or build step is needed.

Add the marketplace once, then install Guided Review:

```sh
bb marketplace add git:github.com/notpritam/bb-marketplace@main
bb marketplace refresh notpritam
bb plugin install guided-review@notpritam
```

Or open **Extensions**, search **Guided Review**, and choose **Install** after adding the marketplace. Direct Git installation can also follow compatible releases:

```sh
bb plugin install git:github.com/notpritam/bb-plugin-guided-review@^0.2.0
```

1. Open **Guided Review**. An empty workspace shows setup readiness; you can revisit it in **Settings → Ready to review**.
2. Sign in on the BB server with `gh auth login --hostname github.com`. Check the account displayed in Guided Review and its access to the repository. No token is pasted into the plugin.
3. Paste a GitHub PR link and choose **Review**. Your BB agent writes the chaptered guide using its normal usage allowance. When the guide is ready, the review assistant reviews the change and adds draft comments.
4. Read the chapters and diffs. Edit or remove the assistant's draft comments, add your own, keep private reviewer notes, or ask the assistant about a file or selection.
5. Choose a verdict and **Submit to GitHub**. Drafting, generating, and the assistant never submit a review. Replies and resolve actions on existing GitHub threads are separate, immediate actions.

GitHub account switching affects `gh` on the BB server. Environment tokens can override saved-account selection; the plugin reports when a switch has not taken effect. Review submissions verify the displayed account and use its credential for the entire request.

## Updates

Open **Settings → Plugin updates** to check for a compatible release, read its release notes, and choose **Update now**. Save or discard settings edits and close other Guided Review pages first. BB installs the latest compatible release available at installation time; it may advance beyond the version shown by an earlier check.

**Automatic updates are off by default.** If enabled, the plugin checks hourly after five idle minutes and waits until all Guided Review and Settings pages are closed, with no generation, save, or submission in progress. Assistant conversations run in BB and continue across plugin updates. Reviews, drafts, private notes, conversations, and preferences remain in BB. Failed checks are visible and retried later; BB handles failed-install rollback.

Marketplace installs track `^0.2.0` (compatible 0.2.x releases). Catalog refresh only refreshes listings. You can also update with `bb plugin update guided-review`; close the plugin’s pages first, since BB’s external update command does not use the in-plugin activity guard. Local directories and exact tags are pinned and do not receive automatic updates. Changing a local installation to a marketplace source is a separate migration: this BB version requires removing the old source first, which can clear plugin data. Do not remove an existing installation just to obtain updates; keep its data and arrange a backup/migration with the BB operator. Fresh marketplace installs are ready for normal updates.

An interrupted browser connection can leave an editing session protected. If the updater still asks you to close pages after they are all closed, save any work elsewhere and reload the plugin through BB. Editing sessions intentionally never expire while a laptop might still hold unsaved text.

## Local changes and the command line

Run `bb review` in a BB thread. A PR URL works from a thread on any machine; a PR number or a local ref needs a project checkout on the BB server:

```sh
bb review https://github.com/acme/web/pull/42
bb review 42                           # PR in the current repository
bb review origin/main...HEAD           # local range
bb review my-feature --base main       # branch against main
bb review https://github.com/acme/web/pull/42 --context 'Implements LIN-123: retry once, never twice.'
```

The checkout for a local review must exist on the BB server. A checkout only present on another enrolled machine is not supported by this release. Local reviews retain notes in BB and do not offer GitHub submission.

`--context` adds text, such as the ticket a PR implements, to the assistant's automatic review. It's kept with the review: running `bb review` again without it keeps it, and `--context ''` removes it. It reaches only the automatic review, which runs when a guide is ready and the review has no conversation yet; the command says when it won't.

Other BB threads and scripts can work with a review's draft comments. These commands change only the local draft; nothing is posted to GitHub until you submit:

```sh
bb review comment list   https://github.com/acme/web/pull/42 [--json]
bb review comment add    https://github.com/acme/web/pull/42 src/api.ts:57 --code 'return cache.get(key);' --body 'Stale after a write?'
bb review comment edit   https://github.com/acme/web/pull/42 src/api.ts:57 --body 'Can this return stale data after a write?'
bb review comment delete https://github.com/acme/web/pull/42 src/api.ts:57
```

A review is named by its PR URL or its key. Line numbers count in the new file; add `--side LEFT` for a removed line, numbered in the old file. `--code` is that line's text, and `add` refuses a line that doesn't match it or already has a comment. Comments added this way show as added by an agent.

## What the review workspace includes

- Ordered chapters with intent, file summaries, and risk labels. Every changed file must appear once in the generated guide.
- Syntax-highlighted diffs, viewed-file tracking, a resizable chapter sidebar, and a collapsible chapter list on narrow screens.
- Draft comments in the diff, under their lines, as on GitHub. Click **+** beside a line, or select lines and choose **Add comment**, to write one there; edit or remove it in place. File headers count their draft comments.
- Discussions with the assistant under a line, kept apart from its comment. **Ask agent** on a comment opens a box under it: say what's wrong or ask why, and the assistant answers there, or edits or removes the comment. **Ask agent** in the comment box, or on selected lines, asks about the lines without adding a comment. Discussions stay in BB: submitting sends only the comments, and clears the discussions.
- An Ask agent tool alongside drafts and reviewer notes. The conversation is BB’s own chat: streamed answers, stop, queued messages, approvals, attachments, and a per-message model and effort picker. The assistant can add, edit, and delete draft comments, and the changes appear in Draft comments as it works. Pop it out as a movable, resizable widget and Dock it again.
- CI status, existing GitHub review threads, and a **Feedback** view that checks each piece of your earlier feedback when a PR comes back to you (see [Whose turn](#whose-turn)).
- A collapsible review sidebar with icons for draft comments, private notes, and Ask agent. Click an icon to open its tool; click it again or use the close control to collapse to the icon rail. The rail includes tooltips and a draft-count badge. The selected tool and open state survive reload; editors stay mounted while collapsed. On narrow screens the rail sits above the panel below the diff.
- Visible Approve, Comment, and Request changes buttons, followed by explicit submission and visible save or submission errors.

A review is pinned to the PR snapshot it was generated from. If the PR changes, re-review before submitting. Unsent draft comments follow their lines into the new diff; a comment whose line is gone is marked **Older diff**: remove it, then add any replacement against the current patch. Submission failures retain the draft; repeated clicks cannot submit the same draft concurrently. Unsaved summaries and comments keep a recovery copy in this browser tab, bound to their original review revision. Re-review retains the previous view while its replacement is generated.

## Whose turn

The review list has four tabs:

- **Needs review**: it's your turn. New reviews, requests for your review, and reviews that came back to you, longest-waiting first. Team requests sit under their own heading. **Blocks merge** marks a changes-requested review that's the only thing left: everyone else approved.
- **Waiting on author**: you requested changes, or commented with open threads, and the author hasn't said they're done. Rows show progress (`2/5 addressed`), new commits, and CI.
- **Reviewed**: you approved, or commented with nothing open. A push after your approval adds “updated” but doesn't bring it back.
- **Archive**: merged, closed, or archived by you.

A push alone never makes a review your turn: authors often push one fix at a time. A review comes back to **Needs review** when:

- the author **re-requests** your review (it even leaves your archive);
- the author **asks you something** on one of your threads, or mentions you on the PR and you haven't commented since, whatever your verdict (choose **Any reply** in settings to come back on every reply);
- every thread you opened is **resolved or answered**, there are new commits, CI isn't running or failing, and the author has been quiet for 10 minutes;
- with **After the author pushes → Check, and bring it back** on, the review assistant finds all your feedback addressed;
- GitHub dismisses your review.

Once a review comes back because your feedback was handled, it stays in Needs review until you act, even if the author pushes again. Your verdict is your latest approve or changes-requested review, as GitHub counts it: replying to a thread doesn't change it. If a review came back too early, choose **Not yet** in its **Review actions** menu or top bar. It waits on the author until a newer reason; pushes alone don't wake it.

Guided Review alerts only about what happens after it starts following a PR: after an upgrade, or when it first finds PRs on GitHub, the list fills in quietly, except new requests for your review.

**When a review comes back, it's prepared for you.** An out-of-date guide is rebuilt for the new commits, keeping its chapters where the files still fit and summarizing what changed since your review; if the rebuild fails, the previous guide stays. (For a PR found on GitHub, without a guide of its own, this happens only in your auto-start repositories.) Then the review assistant checks your feedback, in the review's own conversation: for each of your threads, and each ask in your review summary, it records whether the author **addressed** it, partly, not at all, or disagreed, with one line of evidence. It also looks for new problems in the fix commits, drafts replies to your threads, and suggests a verdict. The **Feedback** view shows all of it: your comment, the author's replies, the assistant's evidence, and **Resolve**, **Reply** (prefilled with the drafted reply), **Follow up** (a new draft comment at the line), and **Show in diff**. **Use as draft** puts the suggested verdict and summary in your draft; **Request what's left** drafts a Request changes listing what's still open. Nothing posts to GitHub until you choose Send, Resolve, or Submit. Change the check's instructions, or turn it off, with **Re-review check** in settings.

**Since your review** in the diff toolbar shows only what changed since the commit you last reviewed, with new lines marked. It compares the PR's diff then with its diff now, so rebases and merges from the base branch don't show up as changes. Viewed marks survive a rebase, and chapters show how many of their files changed.

With **Track reviews from GitHub** on (the default), PRs you're asked to review, and open PRs you've reviewed in the last 60 days, join the list without a guide; start one from the review or its menu. List patterns under **Start guides automatically** (`acme/*`, `acme/api`, or `*`) to have the guide ready by the time a request alerts you. A PR you delete isn't added back. Reading GitHub costs about 4 GraphQL points per 10 PRs a pass, out of the 5,000 an hour your account has.

## Customize your reviews

Open **Settings** from the review list or workspace, or use Guided Review’s section in BB’s plugin settings. Choose Concise, Standard, or Detailed guides, add guide-writing instructions, customize the review assistant’s priorities, set how reviews come back to you under **Whose turn**, and select a default diff layout. Save settings to apply them across this installation. Restore defaults stages a change for you to save; it does not change settings immediately.

Guide instructions extend the bundled `guided-review-generate` skill. They apply to new guides and Re-review; the output schema and complete file coverage remain validated. Assistant instructions reach the assistant as hidden instructions; an idle conversation picks up changes on its next message. **Automatic review** is the assistant's first message when a guide is ready and the review has no conversation yet. By default it asks for an adversarial review with terse inline comments and general points in the reply. Leave it blank to turn the automatic review off.

The guide writer and the review assistant each have an **Agent** setting. **Project defaults** runs on the BB server with the provider, model, reasoning effort, and permission mode BB remembers for the review’s project. **Custom** pins all four, plus the service tier where the provider has one, with BB’s pickers, starting from the Personal project’s defaults. Custom also chooses the **Machine**: the BB server or another enrolled machine, such as your laptop. The pickers then list that machine’s providers, models, and permission limit, and the agent runs in its Personal workspace with the agent configuration installed there; within the chosen permission mode, it can reach that machine’s files and credentials. If the machine is offline or removed, starting a guide, Re-review, `bb review`, and a new assistant conversation fail at once and say why. Guide-writer changes apply to new guides and Re-review. The review assistant’s setting seeds the agent picker for a new conversation; within a conversation, change the model and effort per message as in any BB chat. A conversation keeps its provider and machine; to switch, start a **New conversation**. If BB can’t start a custom agent (for example, its provider was disabled), the assistant shows the error; failed generation records it in the plugin log.

**Draft comments** contains line feedback and the **Review summary** that will go to GitHub when you submit. The same comments show in the diff under their lines. Select a comment’s location to jump to its line, or edit/remove it before sending. While you write a comment in the diff, the panel says where, with **Show in diff**. A comment drafted against an older diff is marked **Older diff**: edit and save it, or remove it, before submitting. Changes from the assistant or `bb review comment` appear here and in the diff as they happen. A comment an agent added is labeled **Added by agent** until you edit it. Agents can also edit and delete comments, and are told to change yours only when you ask. Nothing they do posts to GitHub. Submit refuses a draft whose comments changed since the page last showed them. **Reviewer notes** is a separate scratchpad: it is saved in BB and never included in GitHub submissions or assistant prompts. Notes survive submission and archival. If saving fails, unsaved notes have a browser recovery copy; conflicting edits can be compared with the saved version before choosing what to keep. Existing review summaries retain their original public-draft meaning.

## Data and access

Review metadata, patches, generated guides, and drafts are stored in this BB installation’s plugin database. Review agents receive the patch and context through your configured BB provider; that provider’s data handling applies. The review assistant runs in the permission mode of its Agent setting, on a machine whose `gh` login can usually write to GitHub. Its instructions forbid GitHub writes, but text in a PR could try to steer it, and the automatic review runs unattended; choose its permission mode with that in mind. This plugin does not add a separate hosted review service.

GitHub operations use the server’s `gh` credentials. No token needs to be pasted into the plugin. Grant only the repository access your team needs. A shared BB server uses shared server credentials and plugin storage; it is not a multi-tenant review service.

Older saved reviews remain available. New reviews use repository-scoped identifiers, preventing equal PR numbers in different repositories from overwriting each other. Legacy inline drafts must be removed and re-added against the current patch before submission.

## Development

```sh
npm ci
bb plugin types
npm run check
bb plugin install .
bb plugin dev
```

Development checks use the SDK test harness, temporary Git repositories, and mocked GitHub writes. Use a Node.js version compatible with the installed `better-sqlite3` package (this release was verified on Node.js 24).

Build and commit `dist/` before tagging a release. Keep published tags immutable. Read [CHANGELOG.md](CHANGELOG.md) for release changes.

Inspired by [plannotator/guides](https://github.com/plannotator/guides). The viewer and generation workflow here run through BB.

## Review state and archive

Each review’s assistant conversation is a hidden BB thread, shown in the review with BB’s chat. Review context (guide intent, chapters, and your assistant instructions) reaches it as hidden instructions, refreshed when an idle conversation continues after Re-review or an instructions change. Selections and the Ask assistant button quote the file or lines into your message. **New conversation** archives the current one; if a conversation’s thread is archived or deleted, the next question starts a new one. Archived PRs can still be discussed: their conversations stay unarchived because BB cannot send to an archived thread. A conversation from an earlier plugin version stays visible above the chat and reaches the first new message as context. Where a submitted review appears depends on whose turn it is; see [Whose turn](#whose-turn). Merged and closed PRs move to Archive automatically; their guides, conversations, and unsent drafts remain accessible. GitHub is checked every one to two minutes for reviews in progress, sooner when GitHub notifies you about a PR, and through Refresh. A failed GitHub read preserves saved state.

To set aside any other review, choose **Archive** from its **Review actions** menu (⋯) in the list or the review’s top bar. It stays in Archive, even when new commits arrive, until you choose **Unarchive**, start it again with a PR link, `bb review`, or Re-review, or the author re-requests your review. **Delete** permanently removes the review’s guide, drafts, reviewer notes, and assistant conversation, including its hidden worker thread, after confirmation; nothing changes on GitHub. Delete is unavailable while a guide is generating or the assistant is answering. A deleted PR isn't added back from GitHub until you start it again.

## Browser regression test

Use Node 24, matching the installed SQLite native module. Build and reload this plugin in an isolated test BB, then run:

```sh
npm install
npx playwright install chromium
bb plugin build
BB_SERVER_URL=http://127.0.0.1:4331 bb plugin reload guided-review
BB_E2E_URL=http://127.0.0.1:4331 npm test -- --project e2e
```

The browser uses the running BB shell and built plugin UI. Guided Review RPC requests are intercepted into the official SDK test host with real temporary SQLite. GitHub and agent calls are stubbed at their external boundaries, so no real PR review or agent thread is created. The flow covers settings persistence, draft-comment editing, public summaries, private-note isolation, fullscreen verdict buttons, submission, reload, starting an assistant conversation with file context, sidebar collapse/persistence, keyboard tooltips, panel/widget draft preservation, merge archival, and desktop/390px mobile layouts. Without `BB_E2E_URL`, this test is skipped.


## Notifications

With **Needs You 0.2.0-beta.3+** installed, a finished guide appears in your Needs
You inbox with an **Open review** action. Failed generation has its own recovery
message. A review becoming your turn alerts too: re-requested, a request for your
review, a question for you or a mention, or your feedback handled. Each event alerts
once. When Guided Review prepares the re-review first, the alert waits for it (at most
10 minutes) and says how much of your feedback was addressed, for example
`@alice re-requested your review · 4/5 addressed · CI passing · 2 new commits`.
Opening the review, submitting, or choosing **Not yet** clears the alert.
Each review has one inbox item; hidden worker threads do not create extra alerts. Enable **Needs You → Settings → Extension activity** to receive
popups, desktop alerts, or optional Telegram pushes through your chosen channels.
Quiet hours apply, and a popup stays quiet while you are already viewing that guide.

Needs You is optional. If it is disabled, missing, or restarting, Guided Review
keeps the guide successful and retries the same completion event once a minute
for up to 24 hours while loaded. Restarting preserves queued outcomes. A newer
generation supersedes the previous queued result; cancelled workers never ping.
