# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, Cursor Origin, Linear, and Jira Cloud to clone/publish repos, review and merge pull requests, manage issues, and watch CI.

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

Install Git and authenticate on the machine running your T3 Code server (for remote environments, do this on the remote machine), then click **Rescan** in **Settings → Source control & issues**.

| Host                               | Setup                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub**                         | 1) Save a token in **Settings → Source control & issues → GitHub**, 2) set `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` + `GH_HOST` for Enterprise), or 3) sign in with [GitHub CLI](https://cli.github.com/) 2.81.0+ (`gh auth login`; use `--hostname` for Enterprise). Pick accounts or disable hosts in Settings when multiple `gh` logins exist.                                                                                |
| **GitLab**                         | Install [GitLab CLI](https://gitlab.com/gitlab-org/cli) and run `glab auth login`.                                                                                                                                                                                                                                                                                                                                        |
| **Forgejo / Gitea**                | Install [`fj`](https://codeberg.org/forgejo-contrib/forgejo-cli) (`fj --host https://your-server auth add-token`) or [`gt`](https://gitea.com/gitea/cli) 2.0+ (`gt auth login --host https://your-server`; it replaces the archived `tea`, so sign in again). Prefers `fj`, falls back to `gt` (use `gt` for subpath-hosted servers). Use full URLs when multiple servers exist.                                          |
| **Bitbucket**                      | Save a repo/project/workspace **Access token** or **Atlassian email + API token** (with repo/PR read-write, `read:user:bitbucket`, `read:workspace:bitbucket`) in **Settings → Source control & issues → Bitbucket**, or set `T3CODE_BITBUCKET_ACCESS_TOKEN` / `T3CODE_BITBUCKET_EMAIL` + `T3CODE_BITBUCKET_API_TOKEN` in the server env (or [`service.env`](./background-service.md#configure-the-service-environment)). |
| **Azure DevOps**                   | Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), run `az extension add --name azure-devops`, then `az login`.                                                                                                                                                                                                                                                                                           |
| **GitCafe**                        | Save a token in Settings, set `CAFE_TOKEN` (+ `CAFE_HOST`), or install `@gitcafe/cli` and run `cafe auth login --host https://git.cafe/api`. Line comments are not yet supported; stack merges/updates are native.                                                                                                                                                                                                        |
| **Cursor Origin**                  | Install [Origin CLI](https://cursor.com/docs/origin/cli) and run `origin auth login` (`origin auth setup-git` if push prompts for credentials). Uses private HTTPS repos; GitHub-mirrored PRs stay on GitHub.                                                                                                                                                                                                             |
| **TanStack Source** (private beta) | Set `T3CODE_FEATURE_FLAGS=tanstack_source` and restart the server. Save a token in Settings, set `SRC_TOKEN`, or run `src auth login --web`. Supports live CI logs, private PRs on public repos, and issues.                                                                                                                                                                                                              |

> Note: Git `push` and `clone` still require Git SSH/HTTPS credentials on the server, separate from API tokens.

> Note: With several `gt` servers and no `fj` login, `owner/repo` and newly published repositories go to `gt`'s default server (`gt config set default_host https://your-server`). With several `gt` accounts on one server, pick one with `gt auth switch <user> --host https://your-server`. If an SSH remote uses a different host name than the server's web address, run `gt config set ssh_host <ssh-host> --host https://your-server`.

## Start, clone, or publish a project

- **New project**: Run **New project** from the command palette (`Cmd/Ctrl+K`) or **Add Project** to initialize a new Git repo in `~/.t3/projects/<slug>` with a README, icon, and first commit (optionally creating a private GitHub repo).
- **Clone**: Use **Add Project** to pick a host (enable non-GitHub hosts in **Settings → Source control & issues**) or paste a Git URL or web page URL. Cloning runs in the background so you can draft your first prompt immediately; falls back to HTTPS if SSH auth fails. Enable **Clone into host folders** (**Settings → Threads**, or **Source control** on mobile) for `ghq`-style `<host>/<owner>/<repo>` paths.
- **Publish**: For a local repo without a remote, **Publish Repository** creates the remote, adds `origin`, and pushes commits.

## Review turn changes

A turn's diff shows only that turn's own edits, commits, and conflict fixes—excluding unrelated files brought in by a pull, merge, or rebase. Use the branch comparison to view everything changed against your base branch.

- **Commits view** (web/desktop): Switch the Diff pane source picker to **Commits** to inspect the latest 100 local commits one by one.
- **Commit links**: Links to local commits open in the Diff pane (follows **Settings → Diffs → Open pull requests in T3 Code**; `Cmd/Ctrl+Click` opens in browser).
- **Multi-repo projects**: Use the repository picker in the Diff pane and expand per-repo rows in thread details. See [Projects with several repositories](./multi-repo-projects.md).

## Create, review, and merge pull requests

- **Create**: Commit, push, and open PRs from a thread's Git actions. Configure AI-generated commit/PR writing style in **Settings → Source control & issues → Commits & pull requests** (**Repository conventions** or **Custom instructions**).
- **Review**: Open **Pull requests** to inspect diffs, comments, checks, commits, and request reviewers. Draft line comments stay local until submitted. If new commits are pushed while you review, click **Load new commits** before merging or submitting.
- **Saved views**: Save and update filter/sort setups under **Views → Save current view** (stored per device).
- **Mark files viewed**: Check off files in the **Code** tab to collapse them (reopens as **Changed** on new pushes). Syncs natively with GitHub; stored on your T3 Code server for other hosts.
- **Mobile**: Open **Pull requests** across environments (cached lists, details, guides, and diffs stay readable offline). Tap **Work on PR** to start a worktree thread on the PR's branch.
- **Quick actions & options**:
  - Enable **Remove agent credits when merging** in **Settings → Source control & issues** to strip recognized agent co-author/generated-by trailers on GitHub merge/squash commits (keeps human co-authors).
  - Hold `Shift` in the GitHub PR list (web/desktop) to drag-close multiple PRs (`Esc` cancels).
  - GitHub, GitLab, and Azure DevOps support auto-merge; GitHub also supports approving fork workflows and opening revert PRs.
  - Azure DevOps comments must be edited on the host site; Bitbucket cannot reopen declined PRs.

### Review guides (beta)

Turn on **Settings → Source control & issues → Review guides** to add a **Guide** tab to pull requests. Click **Write guide** to have Claude or Codex read the PR in a temporary read-only checkout and produce an ordered tour of the change (highlighting **Look closely** spots and grouping mechanical changes at the end).

- Customize emphasis/ordering via **Review guide instructions** in **Settings → Source control & issues** (project-overridable).
- On web, select lines in any stop to add review comments or ask an agent about that stop.
- Agents can also generate guides for multiple PRs when asked. Choose **Rewrite guide** from the PR's **⋯** menu after new pushes.

### Pull request sharing across environments

Disabled by default. In **Settings → Environments → Pull request sharing** (**Pull request routing** on mobile), opt in trusted environments to **Read PRs** or **Read and act** so review reads/actions can route through another connected environment signed into the same account on the same host (credentials never leave their machines). Enable on both source and target environments; only grant **Read and act** to environments you control.

## Linked pull requests and watching

Threads can link multiple PRs (even across repos on the same host). Creating a PR via Git actions, `gh pr create`, `glab mr create`, or an agent's `link_pull_request` links it automatically; manage links from **Linked items** or the command palette.

- **Agent PR tools**: Agents can read, open, update, comment on, and merge PRs in the thread's repo using your configured sign-in (refusing merges if the head moved since last read).
- **Watch / babysit a PR**: Ask an agent to watch or babysit a PR (or toggle it in **Linked items** / click the eye icon in thread details). The server polls every 2 minutes and wakes the agent on failed checks, passed required checks, new comments/reviews from others, conflicts, merge-queue drops, or merge/close.
  - Watched threads stay in the **Working** section while checks run (or until merge/close if the agent is waiting to act) and never auto-settle.
  - Watching stops automatically on merge/close, Stop, settle/archive, 10 comment-only wakes in a row, or 8 consecutive read failures. Subagents cannot watch PRs—the parent thread watches instead.

## GitHub stacks

The Pull requests page displays stack layer positions and navigation:

- **Merge stack**: Merges the selected PR and every open layer below it together, respecting branch rules and merge queues.
- **Rebase stack**: Updates remote branches bottom-to-top without modifying your local checkout (may rewrite history and restart checks).

## Issues

Open **Issues** from the sidebar utility row or **Open issues** in the command palette to browse, filter, search, save views, comment, edit, and transition issues across GitHub, GitLab, Azure DevOps, Forgejo, Linear, and Jira Cloud.

- **Linear**: Connect an API key in **Settings → Source control & issues** and bind one or more teams per project (supports multiple Linear accounts). Agents file new issues in the first bound team unless another is named. An issue linked by its full URL needs no binding: any thread, No project threads included, can open and change an issue from a connected workspace, as far as your Linear account allows.
- **Jira Cloud**: Connect your site (`yourteam.atlassian.net`), account email, and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) in **Settings → Source control & issues**, then bind Jira projects (supports multiple Jira sites and accounts). Issues move along their workflow's transitions; reactions and linked pull requests are not available, and new issues are filed as a Task. On a Jira Service Management issue, a comment is an **Internal note** the customer never sees unless you switch it to **Reply to customer** before sending.
- **Link to threads**: Click **Link to this thread** on an issue beside a thread (or let agents call `link_issue`) to track it in **Linked items**.
- Remote issue writes require the `source-control:write` scope.

## Troubleshooting

- **Not authenticated**: Run the host's CLI login on the server and click **Rescan** (for Bitbucket/tokens, verify Settings or server env vars).
- **GitHub verification fails**: Upgrade `gh` to 2.81.0+ or save a token in Settings.
- **Push fails**: Check Git SSH/HTTPS credentials separately from API auth.
- **Fork PR badge missing**: Set upstream with `git branch --set-upstream-to=<remote>/<branch>`.
