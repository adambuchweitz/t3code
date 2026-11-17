# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, and Cursor
Origin to clone and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

In a [project with several repositories](multi-repo-projects.md),
a turn's changed files are grouped by repository, and the Diff pane shows every repository the
turn changed. Use the repository picker next to the source picker to narrow the diff to one of
them. Paths in the diff start at the thread's folder, so the same file name in two repositories
stays apart. This works when the project folder itself is not a Git repository; the branch
comparison and uncommitted changes read one repository at a time, chosen from the same picker.

The thread details panel lists each repository the thread has changed, most recent first, with its
branch and uncommitted changes. Expand one to commit, push, or open a pull request in that
repository; a pull request opened there, or already open for its branch when a turn ends, is linked
to the thread. **Other repositories...** adds any other repository of the project to the list until you
reload. In a worktree thread of a project with several repositories it adds a worktree of that
repository to the thread instead; see [Worktree threads](multi-repo-projects.md#worktree-threads). A
worktree thread of a single repository does not offer it.

On web and desktop, open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.

A commit link from a supported code host opens in the Diff pane when the thread's repository has
that commit locally, on any branch. Otherwise a pull request commit link opens the pull request. Other
commit links follow your **Open links in** setting; on web, when that opens a new tab, T3 Code first
shows an **Open link** button. Command/Ctrl+Click always opens the link in your browser. Commit links follow the **Open pull requests in T3 Code**
setting in **Settings → Diffs**.

### GitButler workspaces

When a project uses GitButler's `gitbutler/workspace`, threads show their associated branch. Otherwise they show the
only applied branch, or **GitButler workspace** when several are applied, once Git status loads. To
associate a thread with an applied branch, choose it under **GitButler branches** in the web or
desktop branch picker, or the mobile branch sheet. **Whole GitButler workspace** clears the association.
Choose a branch under **Not applied** to apply it and link the thread, or enter a new name to
create an applied branch. Remote-only branches become local branches when applied.
**Unapply** asks you to confirm removing the branch's whole stack for every thread and agent
sharing the checkout. Thread links are kept and become active again when the branch is applied.
Keep at least one stack applied; use GitButler directly if you want to leave the workspace.
Associated threads show that branch's name and open review on it while it remains applied.
Agents in the shared workspace are told to use `but` for version-control writes and commit only
their own changes to the associated branch, or create and associate a branch if none is set.

Commit, push, create PR, and pull work through the `but` CLI on the server. Commits target the
thread's associated applied branch. With no association, or when committing on a new branch,
T3 Code creates a branch and associates it with the thread.

Uncommitted changes in a shared checkout may belong to another agent or person, so **Commit** always
opens a list with nothing selected. Changes assigned to the branch appear apart from shared changes,
which have no branch and may be anyone's. Files that are conflicted, that also have changes on
another stack, or that another branch has changed since this one, are shown as unavailable; commit
those from GitButler. **Commit on a new branch** can only take shared files, and refuses a file
already changed on any applied branch.

T3 Code commits whole files, with all of a file's current changes. If a change you chose is edited
or committed before the commit runs, nothing is committed and you choose again. To commit only part
of a file, use `but commit` with hunk IDs from `but diff`; T3 Code doesn't check commits made that way.

GitButler can't commit a specific version of a file, so an edit landing in the final moment can
still be included. T3 Code compares the finished commit to what you chose: if a chosen file differs,
another file changed, or the commit can't be read, it names the commit and stops before any push or
PR, leaving the commit in place for you to review or `but uncommit`. T3 Code keeps that commit held
in the repository, including across restarts and if a commit was cut off before it could be checked.
A later push or PR that would send one, including from a branch above it in a stack, stops and asks
you to review it first. Confirming ends the hold and publishes. To end a hold without publishing,
choose **End hold, don't publish** there, or review everything held from the Git menu, which also
works before a repository has a remote. Outside GitButler's workspace the menu doesn't list holds, so
use `git for-each-ref refs/t3/gitbutler-holds/` and `git update-ref -d <ref>` there. Ending a hold changes no commit, and T3 Code won't ask about
that commit again. If a held commit can no longer be found, such as after an uncommit, squash, or
deleted branch, or T3 Code was cut off before it could identify the commit, its changes could be
anywhere, so every push, PR, and new repository from the checkout stops until the hold ends.

While a commit is being made, its hold can't be ended from T3 Code. If the server making it crashes
or loses power, nothing records how it ended, and its `but commit` can keep running and still land
a commit nobody checked. T3 Code can't tell that apart from a commit still in progress, on any
machine, so the hold stays until you end it. The same goes for a commit T3 Code had to stop on
Windows, where it can't confirm the commit ended. Make sure no `but commit` is still running in that
checkout, review the branch for anything that landed, then run the `git update-ref -d` command T3
Code shows, in Git Bash on Windows.

Holds guard what T3 Code publishes and can't guarantee more. `but push` and `git push` run directly
don't see holds, including ones agents run, and `git update-ref -d` ends one without asking. Any
connection with source control access can confirm or end a hold, including an agent using one, so
confirming doesn't prove a person looked. A copy of a held commit's changes under a new identity,
such as a cherry-pick, isn't held. If two T3 Code servers share a checkout, a commit landing on one
the moment the other starts pushing can still go out, and so can one a crashed server's `but commit`
finishes after you end its hold in a terminal.

A change T3 Code can't check this way, such as one of two identical files renamed together, is listed
as unavailable.

PR creation also opens
missing ancestor PRs and uses each branch below as its base. GitButler uses commit messages and
its PR template for the content; authenticate it with `but config forge auth` in a terminal first.

The push action follows the associated branch: **Publish to** names the remote a new branch will go
to, **Push** sends new commits, and **Force push** replaces commits on the remote after you rewrote
them. When the branch already has an open PR, the action opens it unless there are commits to send.
A PR that only shares the branch's name is listed as **Possible PR (unconfirmed)** and never replaces
publishing, because it may be someone else's.

GitButler replaces the remote branch whenever it pushes, even when you did not ask it to force. So
before every push or PR, T3 Code checks the remote for the branch and the stacked branches below it.
If anything there would be overwritten, it shows what would be lost and asks you to confirm. Agents
and scripts using the action get an error instead. This check narrows the risk but cannot close it:
a push that lands right after it can still be overwritten, unless you turn on force push protection
in GitButler's project settings. Agents running `but push` directly do not go through this check.

Pull updates every applied branch onto the latest target. Resolve any resulting conflicted
commits in GitButler. **Automatically pull** works in these workspaces too, but skips when there
are uncommitted changes or GitButler's update check reports conflicts.

T3 Code keeps the shared checkout in GitButler workspace mode. You can also create a new
worktree from a real branch. Picking that worktree's base does not apply or unapply anything.

A branch that points at a commit on an applied stack gets pulled into that stack, and later rewrites
then move it under the worktree that has it checked out. So when a worktree starts from such a commit,
or from the thread's linked branch, T3 Code first makes one empty commit above it, named
`chore(worktree): start from <base>`, and the new branch starts there. It stays in the branch's
history and any PR opened from it. Once the branch has commits of its own you can drop it when
rebasing; dropping it sooner lets GitButler take the branch back into the stack. T3 Code never removes
it for you.

Changes and ahead counts for such a branch compare against that commit, so they show only the
branch's own work, even after the parent is rewritten. A branch with nothing else on it has nothing to
publish. A PR opened from T3 Code targets the parent branch, or the default branch once the parent has
landed there. If the parent isn't published, was rewritten, or can't be checked, T3 Code pushes nothing
for that PR, creates none, and says why. For a worktree PR, it checks again before creating the PR, so
a parent that changes
during the push can leave the branch pushed without a PR, which T3 Code reports. A base you set by short name gets the same check. To choose one that doesn't hold the parent, name it in full: `git config branch.<branch>.t3-merge-base refs/heads/<base>`. A branch you cut from this one in T3 Code keeps the same parent. These checks read the commits themselves, so they also hold in a fresh clone. A branch built on a start commit that also merged another such branch must have a base holding both parents: if one parent holds the other, the PR targets that one; if neither does, T3 Code refuses until you set a base that holds it all or name one in full (`refs/heads/<base>`, or `refs/remotes/<remote>/<base>` for one you only have from a remote), and the PR will show whatever a base named in full lacks. A branch that only merged such a branch into its own history, with no start commit of its own, is an ordinary branch: its PR shows what it merged. A squash can hide or imitate a start commit: `git merge --squash` output is treated as ordinary work, and one that keeps the start note at the beginning of a line counts as a start commit. In a clone, a branch whose start note was reworded or dropped by a rewrite gets no check. If
the branch is deleted while its thread still needs it, T3 Code
recreates it at that same commit. To drop that record once you no longer need it, find it with
`git for-each-ref refs/t3/worktree-starts/` and remove it with `git update-ref -d <ref>`.

That commit is a normal `git commit` under your identity, made in a temporary checkout. Your signing
configuration and commit hooks apply, and hooks run in that fresh checkout, so a hook that needs
installed dependencies or an untracked file sees none. An untracked folder named by a relative
`core.hooksPath` isn't there, so its hooks don't run. If signing fails, a hook rejects the commit or
removes T3 Code's note from its message, or either doesn't finish in time, no worktree is created and
the error says why; signing and hooks get two minutes, and the temporary checkout ten. Git ignores a
post-commit hook's exit status. Signing here says nothing about a remote's rules for protected
branches. With exactly one stack applied, GitButler leaves workspace mode, so only a linked thread
gets this protection.

The diff selector on every client lists applied branches under **GitButler branches**. Each shows
that branch's commits and assigned uncommitted changes. Branch diffs always show whitespace
changes and cannot expand unchanged lines. On web and desktop, the **Changes** row in thread
details totals the same commits and assigned changes for an associated applied branch, so
unassigned changes count only once GitButler assigns them to it. Without an applied association it
reads **Workspace changes** and combines every applied branch. Install the `but` CLI on the machine running T3 Code
to use these features; without it, review shows only the combined workspace changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source control & issues**
and choose **Rescan**.

### GitHub

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source control & issues → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. T3 Code treats a
custom server name as GitHub once it has a credential for that host.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source control & issues**, expand **Bitbucket**, and enter one of:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`) and workspace read access (`read:workspace:bitbucket`).

A field saves when you leave it, and applies right away. The access token wins when both are saved.
Credentials are saved on the environment's server, so select a remote environment to configure
it. Saved tokens can't be viewed again; enter a new one to replace it, or choose **Remove** to clear
everything saved for Bitbucket.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

For a background service, put these `KEY=VALUE` entries in
[`service.env`](./background-service.md#configure-the-service-environment)
under T3 home, then run `t3 service restart`. Service installation and updates
preserve that file.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

### GitCafe

Install the GitCafe CLI and sign in:

```bash
bun install -g @gitcafe/cli
cafe auth login --host https://git.cafe/api
```

Alternatively, open **Settings → Source control & issues**, expand **GitCafe**, and enter a token. It is
kept in the server's secret store, applies right away, and is used before `CAFE_TOKEN` and the
`cafe` login. Or set `CAFE_TOKEN` in the server's environment and restart it. Both tokens are only
sent to `git.cafe`; `CAFE_TOKEN` follows `CAFE_HOST` if you set it. Repositories on
`staging.git.cafe` need their own login with `--host https://staging.git.cafe/api`.

Line comments are not available for GitCafe pull requests yet.
Merging a stack lands it through GitCafe, and updating a branch restacks the layers above it.

### TanStack Source

TanStack Source is in private beta, so the server shows it only when started with
`T3CODE_TANSTACK_SOURCE=1` in its environment. Install its CLI and sign in:

```sh
curl -fsSL https://source.tanstack.com/install | sh
src auth login --web
```

Alternatively, open **Settings → Source control & issues**, expand **TanStack Source**, and enter a token
from `https://source.tanstack.com/settings/tokens`. A saved token is used before `SRC_TOKEN`, which is
used before the `src` login. With several `src` logins, pick the account there too.

Pull requests show the runs of TanStack Source CI with their logs, and update live while open. Issues
can be listed, filed, edited, commented on and closed. Reactions and picking reviewers or assignees
from a list are not available yet.

### Cursor Origin

Install the [Origin CLI](https://cursor.com/docs/origin/cli) and sign in. Signing in also sets up Git
credentials for `origin.cursor.com`:

```bash
curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
origin auth login
```

If cloning or pushing asks for a username, run `origin auth setup-git` to point Git at the CLI's
credentials again. Origin repositories use HTTPS and are published privately. Repositories mirrored
from GitHub keep their pull requests on GitHub; open those from the GitHub remote.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. Only GitHub is listed at first. To list
another provider here and in **Publish Repository**, turn on its switch under
**Settings → Source control & issues**. A branch or file page copied from GitHub,
GitLab, GitCafe, Codeberg or Bitbucket also works: T3 Code clones that repository's default branch.
On other hosts, paste the repository's clone URL. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. When the host refuses the machine's SSH key, T3 Code
clones over HTTPS with Git's credentials for that host instead, and the project's remote uses the
HTTPS URL.

To lay clones out like [ghq](https://github.com/x-motemen/ghq), turn on **Clone into host folders**
under **Settings → Threads** (or **Source control** on mobile). Clones then default to
`<host>/<owner>/<repo>` under **Add project starts in**, so set that to `~/ghq` to share ghq's
folders. You can still change the destination before cloning.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes. Descriptions also draw on the work in
the thread, including the checks it ran.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose how commit messages and pull request titles and descriptions are written in
**Settings → Source control & issues → Commits & pull requests**. **Repository conventions** uses the
project's instructions and recent commit subjects. **Custom instructions** applies your own
instructions to commits and pull requests.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
Where you can edit a description, you can also tick its checkboxes from the Summary tab
(the Overview tab on mobile).
GitLab calls these merge requests.

Save a filter setup with **Views → Save current view** on the Pull Requests page. For example, choose
**Reviewing** (**Your review** on mobile) and save it as "PRs Requesting My Review". Choose a saved view to restore its search,
filters, sort order, and server/project scope. After changing filters, use **Update saved view** to
keep the changes, or save another view. You can also rename or delete views from the same menu.
Saved views stay in the browser or app where you created them and do not sync across devices.

A link to part of a pull request opens that part: a comment or review is marked in the activity, a
changed-line link opens the file at those lines, a checks link opens the checks, and a commit link
opens that commit's changes. On web and desktop, hovering a comment or commit link previews it.

On mobile, **Pull requests** lists reviews across your connected environments. Open a review
to read its description, activity, commits, and changed files. Line comments stay as drafts
until you submit the review. **Work on PR** opens a chat with the review attached; sending
the first message prepares a worktree from the review's branch.

Previously loaded lists, review details, guides, and diff pages remain readable on mobile
without a connection, including after restarting the app. Saved content refreshes when the
environment reconnects; submitting changes requires a connection.

Enable **Remove agent credits when merging** in Settings → Source control & issues to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

Pull request sharing is off by default. In Settings → Environments → Pull request sharing (Pull
request routing under Environments on mobile), choose **Read PRs** or **Read and act** for each
environment you trust to share its source control access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

Review details, linked PR status, and permitted review actions can then use another connected
environment signed in to the same account on the same host. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Review guides

Review guides are in beta. Turn on **Review guides** in Settings → Source control & issues to add the
**Guide** tab to pull requests on that server. On mobile, move between stops with **Next**
and the back button; a stale guide offers a rewrite and hides excerpts that no longer match
the current change.

The **Guide** tab gives you a tour of a pull request without reading it line by line: stops
through the change in reading order. Each stop points at the lines worth reading, and a stop marked
**Look closely** has a call only a maintainer can make. Mechanical changes such as renames and
snapshots are grouped at the end, and every changed file appears somewhere on the tour.
Conversations already resolved in review are left out. For a pull request in a stack, the guide
covers that layer only, and may point out what a lower layer introduced or what a higher one uses.

Choose **Write guide** to have the review guide model from Settings → Source control & issues read the
change in a temporary checkout; without one set, the source control writer model is used. Nothing
in the checkout is changed, and a large pull request takes a few minutes; you can go elsewhere in
the app. On web, you are told when the guide is ready; on mobile, return to the guide to check
its progress. Claude and Codex can write guides. The guide is
kept for everyone using this server. To write it again, for example after a push or after changing
the model or instructions, choose **Rewrite guide** from the pull request's **⋯** menu.

On web, while reading a stop, select lines in an excerpt to add a comment to your review or ask an agent
about them; comments wait with the ones from the **Code** tab until you send the review. Choose a
suggested question, or **Ask about this stop**, to open a thread that already knows which stop you
are on. **Finish review** on the last stop opens the review with everything you collected.

Agents can write guides too: ask one to prepare guides for a set of pull requests, and it starts
them for you. Each is read through the project whose checkout has that repository.

To shape guides to your taste, write **Review guide instructions** in Settings → Source control & issues,
such as what to show first or what to skip; projects can override them. They change emphasis and
ordering, not the guide's layout or which files it covers.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, Azure DevOps, and Cursor Origin expose no record
T3 Code can read, so the server you are connected to keeps them instead: they follow you across the
apps connected to that server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

On mobile, open a changed file and mark it viewed from its header. Viewed files collapse,
and their marks follow the same rules as on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source control & issues, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source control & issues.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked items** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically,
and so does an agent creating one with `gh pr create` or `glab mr create`. Agents can link other
pull requests with the `link_pull_request` tool.

Agents can also read, open, update, reply on, and merge pull requests in the thread's repository
through T3 Code's own tools, which use the same sign-in as the Pull requests page. An agent merges
only the commit it last read: if someone pushed since, the merge is refused. On github.com an
agent can also land a GitHub stack in one merge, like **Merge stack** below.

Use **Link pull request to thread** in the command palette to keep a pull request with the thread. From a review
on the Pull requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked items** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked items** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. Settling a thread refreshes its open and closed reviews once; after that they stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails or waits for a maintainer's approval, the required checks pass, the other checks finish after a failure, someone else comments or reviews, or the branch starts to
conflict. On github.com it also wakes the agent, with GitHub's reason, when the merge queue drops
the pull request without merging it. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. When the pull
request merges or closes, watching ends, and the agent is woken once unless it merged or closed the
pull request itself with the host's CLI. A reopened pull request needs a new watch. Watching also ends after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Watching a pull request again does not repeat check or conflict news its last
watch already reported; unlinking the pull request clears that. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked items** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working while the pull request still has checks running, so it stays in
the **Working** section, including after the agent pushes a fix. Once every check has finished,
including review bots that report as checks, the thread returns to your inbox: what happens next is
up to a person. That includes a workflow waiting for a maintainer to approve it, which runs only
once someone does. If you ask the agent to act on the pull request itself, such as merging it once
a teammate approves, the thread stays in **Working** until the pull request merges or closes. The
watch stays on and still wakes the agent on new comments, failed checks or conflicts, and a watched
thread never auto-settles.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## Issues

The Issues page lists the issues of every project whose remote is on GitHub, GitLab, Azure
DevOps or Forgejo, grouped per tracker account. Open it from the sidebar's utility row or with
**Open issues** in the command palette. Filter by open or closed, by your involvement
(assigned, opened by you, mentioning you), and by tracker. Under **Projects**, uncheck the
projects you do not want to see; the list remembers them, and a project you add later shows.
The search box asks the tracker itself where it can search. Press **Load more** at the end of a group to read further back.
The **Views** menu saves and restores a search, filter, and sort setup, as it does for pull
requests.

To list Linear issues beside a project's, connect Linear with an API key under
Settings → Source control & issues, then pick one or more teams for that project there. Pick
another team at any time to add it; uncheck every team to unbind the project. Each team's
issues appear in the Linear group of the issue list, sorted with the rest by last update, and
each can be loaded further on its own. Agents file new issues in the first team picked.

Select an issue to open it beside the list: description, comments, state changes, linked pull
requests, labels, assignees, and reactions. Linked pull requests open in the same panel. You can
comment, edit the title and description, change labels and assignees, react, and close or
reopen (with a close reason where the tracker records one) when the tracker and your account
allow it. An issue read through a project that does not own its repository is shown read-only.

An issue can be kept with a thread the way a pull request can: open it beside the thread (issue
links in the conversation open there) and use **Link to this thread** in its header; **Unlink**
undoes it. Click the issue badge in the thread sidebar to see its issues and pull requests in
**Linked items**. Select an issue there to open it beside the thread. Agents link the issues they
work on with the `link_issue` tool.

Writing to a tracker over a remote connection requires the `source-control:write` scope.

## GitHub stacks

The Pull requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
