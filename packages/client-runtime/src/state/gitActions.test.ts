import {
  GitButlerForcePushConfirmationError,
  GitButlerPublicationHoldError,
  GitManagerServiceError,
  type GitButlerPublicationHold,
  type GitButlerBranchPublication,
  type GitButlerCommitFile,
  SourceControlProviderKind,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "../sourceControlClients.ts";
import {
  buildMenuItems,
  gitButlerActionStatus,
  gitButlerChangeRequestUrl,
  gitButlerCommitSelectionView,
  gitButlerHoldCopy,
  gitButlerHoldReview,
  gitButlerMenuItems,
  gitButlerPublishConfirmation,
  gitButlerForcePushCopy,
  gitButlerForcePushRetryAction,
  type GitButlerChangeRequestLookup,
  getGitActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  reviewedGitButlerCommitSelection,
  toggleGitButlerCommitFiles,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const gitLab = {
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("gitlab"),
    name: "GitLab",
    baseUrl: "https://gitlab.com",
  },
};

const openPr = {
  number: 7,
  title: "Feature",
  url: "https://example.com/pr/7",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

const decodeServiceError = Schema.decodeUnknownSync(GitManagerServiceError);
const encodeServiceError = Schema.encodeUnknownSync(GitManagerServiceError);

describe("GitButler publication holds", () => {
  const hold = (overrides: Partial<GitButlerPublicationHold> = {}): GitButlerPublicationHold => ({
    branch: "api",
    state: "unverified",
    commitSha: "abcdef0123456789",
    found: true,
    ...overrides,
  });
  const error = (holds: ReadonlyArray<GitButlerPublicationHold>, staleApproval = false) =>
    new GitButlerPublicationHoldError({
      cwd: "/repo",
      branch: "api",
      holds,
      approval: "token",
      staleApproval,
    });

  it("survives the RPC error schema and retries with its own approval", () => {
    const received = decodeServiceError(encodeServiceError(error([hold()])));
    expect(gitButlerPublishConfirmation(received)?.approval).toEqual({
      gitbutlerHoldApproval: "token",
    });
  });

  it("says how to inspect a held commit, and why a lost one could be anywhere", () => {
    expect(gitButlerHoldCopy(error([hold()])).description).toContain("git show abcdef012345");
    expect(gitButlerHoldCopy(error([hold({ found: false })])).description).toContain(
      "could be anywhere",
    );
    expect(
      gitButlerHoldCopy(error([hold({ state: "interrupted", commitSha: null })])).description,
    ).toContain("git log api");
    expect(gitButlerHoldCopy(error([hold()], true)).description).toContain("has changed");
  });

  it("offers ending only what isn't possibly still running, apart from publishing", () => {
    expect(
      gitButlerPublishConfirmation(error([hold({ resolution: "one" }), hold()]))?.resolutions,
    ).toEqual(["one"]);

    const review = gitButlerHoldReview([
      { ...hold({ resolution: "one" }) },
      {
        ...hold({ state: "interrupted", commitSha: null, found: false }),
        possiblyRunningRef: "refs/t3/gitbutler-holds/pending/id/-/api",
      },
    ]);
    expect(review.resolutions).toEqual(["one"]);
    expect(review.description).toContain(
      "git update-ref -d 'refs/t3/gitbutler-holds/pending/id/-/api'",
    );
    expect(review.description).toContain("won't clear by itself");
    expect(gitButlerHoldReview([]).resolutions).toEqual([]);
    // An older server can't tell this from a commit still running elsewhere.
    expect(
      gitButlerPublishConfirmation(
        error([hold({ state: "interrupted", commitSha: null, found: false })]),
      ),
    ).toBeNull();
  });

  it("opens a review of held commits from the menu", () => {
    const held = gitButlerMenuItems(
      status({
        workspace: {
          _tag: "gitbutler",
          stacks: [{ branches: ["api"], assignedChangeCount: 0 }],
          unassignedChangeCount: 0,
          heldCommitCount: 2,
        },
      }),
      false,
      true,
    ).find((item) => item.id === "held");
    expect(held?.label).toBe("Review 2 commits held from publishing");
    expect(held).toMatchObject({ disabled: false, kind: "review_holds" });
  });
});

describe("GitButler force-push confirmation", () => {
  const error = (
    overrides: Partial<ConstructorParameters<typeof GitButlerForcePushConfirmationError>[0]> = {},
  ) =>
    new GitButlerForcePushConfirmationError({
      cwd: "/repo",
      branch: "api",
      approval: "token",
      staleApproval: false,
      targets: [
        {
          branch: "api",
          remote: "origin",
          remoteSha: "abc",
          overwrittenCommits: [{ sha: "abcdef0123", message: "theirs\n\nbody" }],
        },
      ],
      ...overrides,
    });

  it("recognizes only the guard's own error", () => {
    expect(gitButlerPublishConfirmation(error())?.approval).toEqual({
      gitbutlerForcePushApproval: "token",
    });
    expect(gitButlerPublishConfirmation(new Error("force"))).toBeNull();
    // Clients receive it through the RPC error schema, not as the server's instance.
    const received = decodeServiceError(encodeServiceError(error()));
    expect(gitButlerPublishConfirmation(received)?.approval).toEqual({
      gitbutlerForcePushApproval: "token",
    });
  });

  it("names the commits a collision removes and admits the remaining race", () => {
    const copy = gitButlerForcePushCopy(error());
    expect(copy.title).toBe("Overwrite origin/api?");
    expect(copy.description).toContain("permanently removes 1 commit");
    expect(copy.description).toContain("abcdef0 theirs");
    expect(copy.description).not.toContain("body");
    expect(copy.description).toContain("can still be overwritten");
  });

  it("describes a rewrite, a stack, and a remote that moved after confirming", () => {
    const rewrite = { branch: "base", remote: "origin", remoteSha: "b", overwrittenCommits: [] };
    const copy = gitButlerForcePushCopy(
      error({
        staleApproval: true,
        targets: [rewrite, { ...rewrite, branch: "api" }],
      }),
    );
    expect(copy.title).toBe("Overwrite 2 remote branches?");
    expect(copy.description).toContain("The remote changed after you confirmed.");
    expect(copy.description).toContain("origin/base: replaces its pushed history");
  });

  it("retries only the send, because any commit already landed", () => {
    expect(gitButlerForcePushRetryAction("commit_push")).toBe("push");
    expect(gitButlerForcePushRetryAction("commit_push_pr")).toBe("create_pr");
    expect(gitButlerForcePushRetryAction("push")).toBe("push");
    expect(gitButlerForcePushRetryAction("create_pr")).toBe("create_pr");
  });
});

describe("GitButler commit selection", () => {
  const file = (
    path: string,
    scope: GitButlerCommitFile["scope"],
    ...changeIds: string[]
  ): GitButlerCommitFile => ({ path, scope, changeIds, insertions: 2, deletions: 1 });
  const own = file("own.ts", "target", "own:1");
  const free = file("free.ts", "shared", "free:1", "free:2");
  const mixed = file("mixed.ts", "mixed", "mixed:1");
  const foreign = file("foreign.ts", "locked", "foreign:1");
  const files = [own, free, mixed, foreign];

  it("starts empty and commits nothing until files are chosen", () => {
    const view = gitButlerCommitSelectionView(files, new Set());
    expect(view.canCommit).toBe(false);
    expect(view.assigned).toEqual([own]);
    expect(view.shared).toEqual([free, mixed]);
    expect(view.locked).toEqual([foreign]);
  });

  it("toggles whole files and only lets shared files move to a new branch", () => {
    const shared = toggleGitButlerCommitFiles([free], new Set());
    expect([...shared]).toEqual(["free:1", "free:2"]);
    const view = gitButlerCommitSelectionView(files, shared);
    expect([view.selectedFileCount, view.insertions, view.deletions]).toEqual([1, 2, 1]);
    expect(view.canCommitOnNewBranch).toBe(true);
    for (const assigned of [own, mixed]) {
      const both = gitButlerCommitSelectionView(
        files,
        toggleGitButlerCommitFiles([assigned], shared),
      );
      expect(both.canCommit).toBe(true);
      expect(both.canCommitOnNewBranch).toBe(false);
    }
    expect(toggleGitButlerCommitFiles([free], shared).size).toBe(0);
  });

  it("does not select a change that appears after the choice", () => {
    const selected = toggleGitButlerCommitFiles([free], new Set());
    const view = gitButlerCommitSelectionView(
      [...files, file("late.ts", "shared", "late:1")],
      selected,
    );
    expect(view.selectedFileCount).toBe(1);
    expect(view.canCommit).toBe(true);
  });

  it("holds the commit when a chosen change is edited, committed, or locked, until reviewed", () => {
    const selected = new Set(["free:1", "free:2", "own:1"]);
    for (const refreshed of [
      [own, { ...free, changeIds: ["free:1", "free:edited"] }],
      [own],
      [own, { ...free, scope: "locked" as const }],
    ]) {
      const view = gitButlerCommitSelectionView(refreshed, selected);
      expect(view.needsReview).toBe(true);
      expect(view.canCommit).toBe(false);
      const reviewed = reviewedGitButlerCommitSelection(refreshed, selected);
      expect([...reviewed]).toEqual(["own:1"]);
      expect(gitButlerCommitSelectionView(refreshed, reviewed).canCommit).toBe(true);
    }
  });
});

describe("git action copy", () => {
  it("targets only the linked applied GitButler branch and ignores the synthetic ref's divergence", () => {
    const workspace = status({
      refName: "gitbutler/workspace",
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 10,
      hasWorkingTreeChanges: true,
      workspace: {
        _tag: "gitbutler",
        unassignedChangeCount: 1,
        stacks: [{ branches: ["api"], assignedChangeCount: 0 }],
      },
    });
    for (const branch of ["api", "removed", null]) {
      const target = gitButlerActionStatus(workspace, branch);
      expect(target?.refName).toBe(branch === "api" ? "api" : null);
      const items = buildMenuItems(target, false);
      expect(items.map((item) => item.disabled)).toEqual([
        false,
        branch !== "api",
        branch !== "api",
      ]);
      expect(resolveQuickAction(target, false)).toEqual({
        label: "Commit",
        disabled: false,
        kind: "open_commit",
      });
    }
    expect(gitButlerActionStatus(status(), "api")?.refName).toBe("feature/test");
  });

  describe("linked GitButler branch", () => {
    const linked = (
      publication: GitButlerBranchPublication | undefined,
      lookup?: GitButlerChangeRequestLookup,
      overrides: Partial<VcsStatusResult> = {},
    ) =>
      gitButlerActionStatus(
        status({
          refName: "gitbutler/workspace",
          hasUpstream: false,
          workspace: {
            _tag: "gitbutler",
            pushRemote: "fork",
            unassignedChangeCount: 0,
            stacks: [{ branches: ["api"], assignedChangeCount: 0 }],
            ...(publication ? { publications: { api: publication } } : {}),
          },
          // The synthetic ref's own pull request never describes the branch.
          pr: { ...openPr, number: 99 },
          ...overrides,
        }),
        "api",
        lookup ?? { status: "ready", pr: null, association: null },
      );
    const pushItem = (target: ReturnType<typeof linked>) =>
      buildMenuItems(target, false).find((item) => item.id === "push")!;

    it.each([
      ["unpublished", "Publish to fork", "push"],
      ["ahead", "Push", "push"],
      ["force_required", "Force push", "push"],
      [undefined, "Push", "push"],
    ] as const)("offers %s as a runnable %s", (publication, label, action) => {
      const target = linked(publication);
      expect(resolveQuickAction(target, false)).toEqual({
        label,
        disabled: false,
        kind: "run_action",
        action,
      });
      expect(pushItem(target)).toMatchObject({ label, disabled: false });
    });

    it.each([
      ["empty", "No commits to publish."],
      ["up_to_date", "Branch is up to date. No commits to push."],
      ["integrated", "Branch is already integrated into the target."],
    ] as const)("does not offer a push for %s", (publication, reason) => {
      const target = linked(publication);
      expect(resolveQuickAction(target, false)).toMatchObject({
        disabled: true,
        kind: "show_hint",
        hint: reason,
      });
      const item = pushItem(target);
      expect(item.disabled).toBe(true);
      expect(
        getGitActionDisabledReason({
          item,
          gitStatus: target,
          isBusy: false,
          hasOriginRemote: true,
        }),
      ).toBe(reason);
    });

    it("says publish without naming a remote it could not read", () => {
      const target = linked("unpublished", undefined, {
        workspace: {
          _tag: "gitbutler",
          unassignedChangeCount: 0,
          stacks: [{ branches: ["api"], assignedChangeCount: 0 }],
          publications: { api: "unpublished" },
        },
      });
      expect(resolveQuickAction(target, false).label).toBe("Publish branch");
    });

    it("shows the branch's own open PR and only pushes ahead of it", () => {
      const ready = { status: "ready", pr: openPr, association: "confirmed" } as const;
      expect(linked("up_to_date", ready)?.pr?.number).toBe(7);
      // Publishing to the push remote is not the next step for a PR that lives on another remote.
      for (const publication of ["up_to_date", "unpublished", undefined] as const) {
        expect(resolveQuickAction(linked(publication, ready), false)).toEqual({
          label: "View PR #7",
          disabled: false,
          kind: "open_pr",
        });
      }
      expect(resolveQuickAction(linked("ahead", ready), false).label).toBe("Push");
      expect(resolveQuickAction(linked("force_required", ready), false).label).toBe("Force push");
      expect(pushItem(linked("unpublished", ready))).toMatchObject({
        label: "Publish to fork",
        disabled: false,
      });
      expect(buildMenuItems(linked("ahead", ready), false).at(-1)).toMatchObject({
        id: "pr",
        kind: "open_pr",
        label: "View PR #7",
      });
    });

    it("names a draft, and a finished PR without treating it as open", () => {
      const pr = (overrides: Partial<NonNullable<VcsStatusResult["pr"]>>) =>
        ({ status: "ready", pr: { ...openPr, ...overrides }, association: "confirmed" }) as const;
      expect(resolveQuickAction(linked("up_to_date", pr({ isDraft: true })), false).label).toBe(
        "View draft PR #7",
      );
      expect(
        resolveQuickAction(linked("up_to_date", pr({ state: "merged" })), false),
      ).toMatchObject({
        disabled: true,
        hint: "PR #7 was merged. Branch is up to date. No commits to push.",
      });
      expect(buildMenuItems(linked("ahead", pr({ state: "closed" })), false).at(-1)).toMatchObject({
        kind: "open_dialog",
        label: "Create PR",
        disabled: false,
      });
    });

    it("holds Create PR while the lookup runs and keeps it after a failed lookup", () => {
      const loading = linked("up_to_date", { status: "loading" });
      const pending = buildMenuItems(loading, false).at(-1)!;
      expect(pending).toMatchObject({ label: "Create PR", disabled: true });
      expect(
        getGitActionDisabledReason({
          item: pending,
          gitStatus: loading,
          isBusy: false,
          hasOriginRemote: true,
        }),
      ).toBe("Checking for an existing PR...");
      expect(resolveQuickAction(loading, false).hint).toBe("Checking for an existing PR...");
      // `but pr new` reuses an existing review, so a failed read cannot create a duplicate.
      const failed = linked("up_to_date", { status: "failed" });
      expect(buildMenuItems(failed, false).find((item) => item.id === "pr")).toMatchObject({
        label: "Create PR",
        disabled: false,
      });
      // A failed lookup says so rather than reading as a branch with no PR.
      expect(buildMenuItems(failed, false).at(-1)).toMatchObject({
        id: "pr_candidate",
        label: "Could not check for a PR",
        disabled: true,
      });
      expect(resolveQuickAction(failed, false).hint).toBe(
        "Could not check for a PR. Branch is up to date. No commits to push.",
      );
      expect(buildMenuItems(linked("up_to_date"), false).at(-1)?.id).toBe("pr");
    });

    it("keeps a name-matched PR an unconfirmed candidate that never replaces publishing", () => {
      const candidate = { status: "ready", pr: openPr, association: "candidate" } as const;
      const target = linked("unpublished", candidate);
      expect(target?.pr).toBeNull();
      expect(resolveQuickAction(target, false)).toEqual({
        label: "Publish to fork",
        disabled: false,
        kind: "run_action",
        action: "push",
      });
      const items = buildMenuItems(target, false);
      expect(items.find((item) => item.id === "pr")).toMatchObject({
        label: "Create PR",
        kind: "open_dialog",
      });
      expect(items.at(-1)).toMatchObject({
        id: "pr_candidate",
        kind: "open_pr",
        label: "Possible PR #7 (unconfirmed)",
        disabled: false,
      });
      expect(gitButlerChangeRequestUrl(target)).toBe(openPr.url);
      expect(resolveQuickAction(linked("up_to_date", candidate), false).hint).toBe(
        "PR #7 may belong to this branch, but that is unconfirmed. Branch is up to date. No commits to push.",
      );
      expect(
        buildMenuItems(
          linked("up_to_date", { ...candidate, pr: { ...openPr, state: "merged" } }),
          false,
        ).at(-1)?.label,
      ).toBe("Possible merged PR #7 (unconfirmed)");
    });

    it("never offers Create PR for a branch with nothing to review", () => {
      for (const publication of ["empty", "integrated"] as const) {
        expect(buildMenuItems(linked(publication), false).at(-1)).toMatchObject({
          label: "Create PR",
          disabled: true,
        });
      }
    });
  });

  it("says PR for a GitHub ref", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false).label).toBe("Push & create PR");
    expect(resolveQuickAction(status({ pr: openPr }), false).label).toBe("View PR");
    const [, , prItem] = buildMenuItems(status(), false);
    expect(prItem?.label).toBe("Create PR");
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in a PR.");
  });

  it("says MR for a GitLab ref", () => {
    expect(resolveQuickAction(status({ ...gitLab, aheadCount: 1 }), false).label).toBe(
      "Push & create MR",
    );
    expect(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
    ).toBe("Commit, push & MR");
    expect(resolveQuickAction(status({ ...gitLab, pr: openPr }), false).label).toBe("View MR");
    const [, , prItem] = buildMenuItems(status(gitLab), false);
    expect(prItem?.label).toBe("Create MR");
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(gitLab),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in an MR.");
  });

  it("offers creating a PR after the feature branch has been fully pushed", () => {
    const pushed = status({ aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 1 });
    expect(resolveQuickAction(pushed, false)).toMatchObject({
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
    expect(resolveQuickAction({ ...pushed, isDefaultRef: true }, false, true).disabled).toBe(true);
  });

  it.each([
    { tracking: "with an upstream", hasUpstream: true },
    { tracking: "without an upstream", hasUpstream: false },
  ])("pushes existing commits from a clean default branch $tracking", ({ hasUpstream }) => {
    const cleanDefaultBranch = status({
      refName: "main",
      isDefaultRef: true,
      hasUpstream,
      aheadCount: 1,
    });
    expect(resolveQuickAction(cleanDefaultBranch, false, true)).toMatchObject({
      disabled: false,
      kind: "run_action",
      action: "push",
    });
  });

  it("names the host's change request in the default-branch dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("github").changeRequest,
      }).title,
    ).toBe("Commit, push & create PR from default branch?");
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("gitlab").changeRequest,
      }).continueLabel,
    ).toBe("Commit, push & create MR");
  });
});
