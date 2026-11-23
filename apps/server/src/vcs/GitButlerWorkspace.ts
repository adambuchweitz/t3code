// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's crypto is async; this fingerprints in a pure map.
import * as NodeCrypto from "node:crypto";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

import {
  GitButlerForcePushConfirmationError,
  GitButlerPublicationHoldError,
  GitCommandError,
  gitButlerEndHoldCommand,
  type GitButlerBranchInput,
  type GitButlerBranchPublication,
  type GitButlerBranchResult,
  type GitButlerCommitChangesResult,
  type GitButlerCommitFile,
  type GitButlerForcePushTarget,
  type GitButlerHeldCommit,
  type GitButlerHoldsResult,
  type GitButlerPublicationHold,
  type GitButlerResolveHoldsInput,
  type GitButlerWorkspaceStatus,
  type GitRunStackedActionResult,
  type ReviewDiffFileStat,
  type VcsPullResult,
  TrimmedNonEmptyString,
  type VcsError,
} from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as VcsProcess from "./VcsProcess.ts";

const STATUS_TIMEOUT_MS = 5_000;
const STATUS_MAX_OUTPUT_BYTES = 1_000_000;
const DIFF_TIMEOUT_MS = 30_000;
// `but diff --json` wraps every hunk in JSON, so the raw output is read whole
// and the synthesized patch is capped instead; truncated JSON cannot decode.
const DIFF_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PATCH_MAX_BYTES = 120_000;
const FILE_PATCH_MAX_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = "\n\n[truncated]";
// Matches GitManager's status cache, so one status refresh starts at most one `but status`.
const STATUS_CACHE_TTL = Duration.seconds(1);
// Long enough for a preview's lazy file reads to reuse its branch read, short
// enough that a refresh after an edit sees it even without an invalidation.
const BRANCH_DIFF_CACHE_TTL = Duration.seconds(2);
// Shared by every client polling one open commit dialog; a poll runs every five seconds.
const COMMIT_CHANGES_CACHE_TTL = Duration.seconds(2);
// The signature can't see what only GitButler knows, such as a file's assignment, so a list that
// looks unchanged is still read again this often. A commit always re-reads, so this bounds only
// how long the dialog can be out of date.
const COMMIT_CHANGES_MAX_REUSE_MS = 30_000;
const CACHE_CAPACITY = 16;
// Refs because a hold must outlive the server and reach every T3 home using this checkout, and
// `but push` sends branch refs only. Names are `<pending|interrupted|unverified>/<id>/<changeId or ->/<branch>`.
// `pending` isn't known to have ended, and a dead owner can't show it has: `but` runs detached and
// outlives a crashed server.
const HOLD_REFS_PREFIX = "refs/t3/gitbutler-holds/";
const HOLD_REF_PATTERN =
  /^refs\/t3\/gitbutler-holds\/(pending|interrupted|unverified)\/([^/]+)\/([^/]+)\/(.+)$/;
const NO_CHANGE_ID = "-";

const StatusOutput = Schema.Struct({
  uncommittedChanges: Schema.Array(Schema.Unknown),
  conflictedFiles: Schema.optional(Schema.Array(Schema.String)),
  /** Where a new branch starts. */
  mergeBase: Schema.optional(Schema.NullOr(Schema.Struct({ commitId: TrimmedNonEmptyString }))),
  worktrees: Schema.optional(
    Schema.Array(
      Schema.Struct({
        uncommittedChanges: Schema.Array(Schema.Unknown),
      }),
    ),
  ),
  stacks: Schema.Array(
    Schema.Struct({
      assignedChanges: Schema.Array(Schema.Unknown),
      branches: Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          branchStatus: Schema.optional(Schema.String),
          commits: Schema.optional(Schema.Array(Schema.Unknown)),
        }),
      ),
    }),
  ),
});
const decodeStatusOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusOutput));
const AssignedChange = Schema.Struct({
  filePath: TrimmedNonEmptyString,
  cliId: TrimmedNonEmptyString,
  changeType: Schema.optional(Schema.String),
});
const decodeAssignedChanges = Schema.decodeUnknownEffect(Schema.Array(AssignedChange));
const decodeCommitOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      commitId: TrimmedNonEmptyString,
      changeId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    }),
  ),
);
const decodeCommitId = Schema.decodeUnknownOption(
  Schema.Struct({
    commitId: Schema.String,
    changeId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodePushDryRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      branches: Schema.Array(
        Schema.Struct({
          branchName: TrimmedNonEmptyString,
          remote: TrimmedNonEmptyString,
          requiresForce: Schema.Boolean,
          upstreamCommits: Schema.optional(
            Schema.Array(Schema.Struct({ sha: Schema.String, message: Schema.String })),
          ),
        }),
      ),
    }),
  ),
);
const decodeTargetOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ branch: TrimmedNonEmptyString })),
);
const decodePushRemoteOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ push_remote: TrimmedNonEmptyString })),
);
const decodeApplyOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ status: Schema.String, appliedBranches: Schema.Array(Schema.String) }),
  ),
);
const decodeNewBranchOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ branch: TrimmedNonEmptyString })),
);
const Review = Schema.Struct({
  sourceBranch: Schema.String,
  targetBranch: Schema.String,
  number: Schema.Number,
  htmlUrl: Schema.String,
  title: Schema.String,
});
const decodePrOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      published: Schema.Array(Review),
      alreadyExisting: Schema.Array(Review),
    }),
  ),
);
const decodePullCheck = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      upToDate: Schema.Boolean,
      hasWorktreeConflicts: Schema.Boolean,
      branchStatuses: Schema.Array(Schema.Struct({ status: Schema.String })),
    }),
  ),
);
const decodePullOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.String,
      conflicts: Schema.Array(Schema.Unknown),
      summary: Schema.Struct({ branchesConflicted: Schema.Number }),
    }),
  ),
);

function branchPublication(branch: {
  readonly branchStatus?: string | undefined;
  readonly commits?: ReadonlyArray<unknown> | undefined;
}): GitButlerBranchPublication | null {
  switch (branch.branchStatus) {
    case "completelyUnpushed":
      // Pushing an empty branch would publish a ref at the target with nothing to review.
      return branch.commits?.length === 0 ? "empty" : "unpublished";
    case "unpushedCommits":
      return "ahead";
    case "unpushedCommitsRequiringForce":
      return "force_required";
    case "nothingToPush":
      return "up_to_date";
    case "integrated":
      return "integrated";
    default:
      return null;
  }
}

/** What a chosen file must look like in the commit. A null mode means deleted. */
interface ExpectedChange {
  readonly path: string;
  readonly mode: string | null;
  readonly blob: string | null;
  /** The path a rename must delete, which `but` doesn't report. */
  readonly renamedFrom: string | null;
}

type StatusBranch = (typeof StatusOutput.Type)["stacks"][number]["branches"][number];

interface StoredHold {
  readonly ref: string;
  readonly sha: string;
  readonly state: GitButlerPublicationHold["state"];
  readonly changeId: string | null;
  readonly branch: string;
  /** False only once the commit is known to have ended. */
  readonly mayBeRunning: boolean;
}

/** A name this version can't read still holds, and may be a newer version's running commit. */
function parseHolds(stdout: string): readonly StoredHold[] {
  const lines = stdout.split("\n").flatMap((line) => {
    const [ref, sha] = line.split("\u0000");
    return ref && sha ? [{ ref, sha, match: HOLD_REF_PATTERN.exec(ref) }] : [];
  });
  // The outcome is written once the commit has ended, before its pending marker is deleted, so a
  // marker beside its outcome only lost that cleanup.
  const ended = new Set(
    lines.flatMap(({ match }) => (match && match[1] !== "pending" ? [match[2]!] : [])),
  );
  return lines.map(({ ref, sha, match }) => ({
    ref,
    sha,
    state: match?.[1] === "unverified" ? "unverified" : "interrupted",
    changeId: match && match[3] !== NO_CHANGE_ID ? match[3]! : null,
    branch: match?.[4] ?? ref.slice(HOLD_REFS_PREFIX.length),
    mayBeRunning: match === null || (match[1] === "pending" && !ended.has(match[2]!)),
  }));
}

const possiblyRunningDetail = (holds: readonly StoredHold[]) =>
  `T3 Code can't tell whether a commit on ${[...new Set(holds.map((hold) => hold.branch))].join(", ")} is still being made, so nothing was pushed. If a T3 Code server is making it, retry once it finishes. If that server stopped, this won't clear by itself: make sure no \`but commit\` is still running in this checkout, review the branch, since a commit may have landed unchecked, then end the hold in a terminal (Git Bash on Windows): ${holds.map((hold) => gitButlerEndHoldCommand(hold.ref)).join("; ")}`;

export interface GitButlerCommitSelection {
  /** As offered to the client, which `commit` checks again. */
  readonly changeIds: readonly string[];
  /** As `but` knows them. */
  readonly cliIds: readonly string[];
  readonly filePaths: readonly string[];
  readonly expected: readonly ExpectedChange[];
}

// A CLI ID can't prove content: `but` shortens IDs outside agent environments, so an edited hunk
// keeps its ID about one time in six, and a change with no hunks (binary, mode, pure rename) keeps
// it always. The ID we offer adds a fingerprint of the file's state, and `@` can't be in a CLI ID.
const cliId = (changeId: string) => changeId.split("@", 1)[0]!;
const fingerprint = (content: string) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex").slice(0, 32);
const expectedFingerprint = ({ mode, blob, renamedFrom }: ExpectedChange) =>
  fingerprint(JSON.stringify([mode, blob, renamedFrom]));

/** Parses `--raw -z --no-renames`, whose records are `:srcMode dstMode srcBlob dstBlob status\0path\0`. */
function parseRawDiff(stdout: string) {
  const fields = stdout.split("\0");
  const entries = new Map<
    string,
    {
      readonly mode: string;
      readonly srcBlob: string;
      readonly blob: string;
      readonly status: string;
    }
  >();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode, srcBlob, blob, status] = fields[index]!.split(" ");
    if (mode && srcBlob && blob && status) {
      entries.set(fields[index + 1]!, { mode, srcBlob, blob, status });
    }
  }
  return entries;
}

/** Parses `--raw -z -M`, where a rename's record is `...status\0source\0path\0`, keyed by path. */
function parseRenames(stdout: string) {
  const fields = stdout.split("\0");
  const renames = new Map<string, string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (!fields[index]!.split(" ")[4]?.startsWith("R")) continue;
    renames.set(fields[index + 2]!, fields[index + 1]!);
    index += 1;
  }
  return renames;
}

/** Paths in `status --porcelain=v2 -z --no-renames` output that should have bytes on disk. */
function porcelainPathsOnDisk(status: string) {
  return status.split("\0").flatMap((record) => {
    if (record.startsWith("? ")) return [record.slice(2)];
    if (record.startsWith("u ")) return [record.split(" ").slice(10).join(" ")];
    if (!record.startsWith("1 ") || record.slice(2, 4).includes("D")) return [];
    return [record.split(" ").slice(8).join(" ")];
  });
}

// Each change decodes on its own so one unfamiliar entry cannot hide a branch.
const DiffOutput = Schema.Struct({ changes: Schema.Array(Schema.Unknown) });
const decodeDiffOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(DiffOutput));
const decodeChange = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.optional(Schema.NullOr(Schema.String)),
    path: Schema.String,
    status: Schema.optional(Schema.String),
    previousPath: Schema.optional(Schema.NullOr(Schema.String)),
    diff: Schema.optional(Schema.Unknown),
  }),
);
const decodePatch = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("patch"),
    // Each hunk's first line is its "@@ ..." header; the rest is the unified
    // body with " ", "+", and "-" prefixes.
    hunks: Schema.Array(Schema.Struct({ diff: Schema.String })),
  }),
);

interface BranchChange {
  /** Content-derived hunk ID, which uncommitted changes carry and branch diffs do not. */
  readonly id: string | null;
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: string | undefined;
  /** `null` when GitButler reported no text patch, such as for binary files. */
  readonly hunks: ReadonlyArray<string> | null;
}

function decodeChanges(changes: ReadonlyArray<unknown>): ReadonlyArray<BranchChange> {
  return changes.flatMap((raw) => {
    const change = decodeChange(raw);
    if (Option.isNone(change)) return [];
    const patch = decodePatch(change.value.diff);
    return [
      {
        id: change.value.id ?? null,
        path: change.value.path,
        previousPath: change.value.previousPath ?? null,
        status: change.value.status,
        hunks: Option.isSome(patch) ? patch.value.hunks.map((hunk) => hunk.diff) : null,
      },
    ];
  });
}

interface GitButlerBranchDiff {
  readonly patch: string;
  readonly files: ReadonlyArray<ReviewDiffFileStat>;
  readonly truncated: boolean;
}

/**
 * Builds a unified patch from GitButler's changes. GitButler reports hunk
 * headers and prefixed body lines, so only the per-file envelope is written
 * here. It reports no file modes, so the envelope claims none.
 */
function unifiedPatchFromChanges(changes: ReadonlyArray<BranchChange>): {
  readonly patch: string;
  readonly files: ReadonlyArray<ReviewDiffFileStat>;
} {
  const lines: string[] = [];
  const files: ReviewDiffFileStat[] = [];
  for (const change of changes) {
    const oldPath = change.previousPath ?? change.path;
    const oldSide = change.status === "added" ? "/dev/null" : quoteGitPatchPath(`a/${oldPath}`);
    const newSide =
      change.status === "deleted" ? "/dev/null" : quoteGitPatchPath(`b/${change.path}`);
    lines.push(
      `diff --git ${quoteGitPatchPath(`a/${oldPath}`)} ${quoteGitPatchPath(`b/${change.path}`)}`,
    );
    if (change.previousPath !== null && change.previousPath !== change.path) {
      lines.push(
        `rename from ${quoteGitPatchPath(change.previousPath)}`,
        `rename to ${quoteGitPatchPath(change.path)}`,
      );
    }
    let additions = 0;
    let deletions = 0;
    if (change.hunks === null) {
      lines.push(`Binary files ${oldSide} and ${newSide} differ`);
    } else {
      lines.push(`--- ${oldSide}`, `+++ ${newSide}`);
      for (const hunk of change.hunks) {
        const hunkLines = hunk.split("\n");
        // Hunk bodies end with a newline; a real empty line keeps its " " prefix.
        if (hunkLines.length > 1 && hunkLines.at(-1) === "") hunkLines.pop();
        for (const [index, line] of hunkLines.entries()) {
          if (index > 0 && line.startsWith("+")) additions += 1;
          else if (index > 0 && line.startsWith("-")) deletions += 1;
          lines.push(line);
        }
      }
    }
    files.push({ path: change.path, previousPath: change.previousPath, additions, deletions });
  }
  return { patch: lines.length === 0 ? "" : `${lines.join("\n")}\n`, files };
}

export class GitButlerWorkspace extends Context.Service<
  GitButlerWorkspace,
  {
    /** Applied stacks of the GitButler workspace checked out at `cwd`. */
    readonly readStatus: (
      cwd: string,
    ) => Effect.Effect<GitButlerWorkspaceStatus, VcsError | GitCommandError>;
    /**
     * One applied branch's commits plus its assigned uncommitted changes,
     * against the GitButler target, optionally limited to one file.
     */
    readonly readBranchDiff: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly file?: { readonly path: string; readonly previousPath: string | null };
    }) => Effect.Effect<GitButlerBranchDiff, VcsError | GitCommandError>;
    /** Drops cached status, branch diffs, and commit lists for `cwd` so the next read is fresh. */
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
    readonly apply: (
      input: GitButlerBranchInput,
    ) => Effect.Effect<GitButlerBranchResult, GitCommandError>;
    readonly unapply: (input: GitButlerBranchInput) => Effect.Effect<void, GitCommandError>;
    readonly createBranch: (
      input: GitButlerBranchInput,
    ) => Effect.Effect<GitButlerBranchResult, GitCommandError>;
    /** What can be chosen for a commit from `branch`, with the hunk IDs that name each file. */
    readonly readCommitChanges: (input: {
      readonly cwd: string;
      readonly branch?: string | undefined;
    }) => Effect.Effect<GitButlerCommitChangesResult, GitCommandError>;
    readonly prepareCommit: (input: {
      readonly cwd: string;
      readonly branch: string | null;
      readonly changeIds: readonly string[];
    }) => Effect.Effect<GitButlerCommitSelection, GitCommandError>;
    readonly readCommitContext: (
      cwd: string,
      selection: GitButlerCommitSelection,
      includePatch: boolean,
    ) => Effect.Effect<
      { readonly stagedSummary: string; readonly stagedPatch: string } | null,
      GitCommandError
    >;
    readonly commit: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly message: string;
      readonly createBranch?: boolean;
      readonly changeIds: readonly string[];
    }) => Effect.Effect<
      {
        readonly commitSha: string;
        /** The commit exists but differs from the selection, so nothing may build on it unreviewed. */
        readonly selectionMismatch?: string;
      } | null,
      GitCommandError
    >;
    /** This branch and those below it, nearest first, which `but pr new` publishes together. */
    readonly readPublishedBranches: (input: {
      readonly cwd: string;
      readonly branch: string;
    }) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    /** Whether `sha` is one of the branch's commits or the upstream it last pushed to. */
    readonly branchHasRevision: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly sha: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly push: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly forcePushApproval?: string;
      readonly holdApproval?: string;
    }) => Effect.Effect<
      GitRunStackedActionResult["push"],
      GitCommandError | GitButlerForcePushConfirmationError | GitButlerPublicationHoldError
    >;
    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly draft?: boolean;
      readonly forcePushApproval?: string;
      readonly holdApproval?: string;
    }) => Effect.Effect<
      GitRunStackedActionResult["pr"],
      GitCommandError | GitButlerForcePushConfirmationError | GitButlerPublicationHoldError
    >;
    /** Runs a push made outside workspace mode, where nothing says what it sends, so any hold stops it. */
    readonly publishOutsideWorkspace: <A, E, R>(
      input: { readonly cwd: string; readonly branch: string; readonly holdApproval?: string },
      publish: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitCommandError | GitButlerPublicationHoldError, R>;
    readonly readHolds: (cwd: string) => Effect.Effect<GitButlerHoldsResult, GitCommandError>;
    /** Ends holds that are still as they were shown, changing and publishing nothing else. */
    readonly resolveHolds: (
      input: GitButlerResolveHoldsInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pull: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly autoPull: (cwd: string) => Effect.Effect<VcsPullResult | null, GitCommandError>;
  }
>()("t3/vcs/GitButlerWorkspace") {}

const BUT_LOCK_RETRY_COMMANDS = new Set([
  "status",
  "--format",
  "diff",
  "config",
  "apply",
  "unapply",
  "branch",
  "switch",
]);

const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const mutations = yield* KeyedLock.make<string>();
  const publications = yield* KeyedLock.make<string>();

  const decodeError = (operation: string, cwd: string, command: string, cause: unknown) =>
    new GitCommandError({
      operation,
      command,
      cwd,
      detail: "GitButler returned output T3 Code could not read.",
      cause,
    });

  const runBut = Effect.fn("GitButlerWorkspace.run")(function* (
    cwd: string,
    args: readonly string[],
  ) {
    const operation = `GitButlerWorkspace.${args[0]}`;
    return yield* runButOnce(operation, cwd, args).pipe(
      // `but` leaves a background sync writing its database, and SQLite then refuses the next
      // write outright instead of waiting. Only reads and local workspace changes are retried.
      Effect.retry({
        times: 4,
        while: (error) =>
          BUT_LOCK_RETRY_COMMANDS.has(args[0] ?? "") && /database is locked/i.test(error.detail),
        schedule: Schedule.exponential("250 millis"),
      }),
    );
  });

  // runBut's span already covers every attempt.
  const runButOnce = Effect.fnUntraced(function* (
    operation: string,
    cwd: string,
    args: readonly string[],
  ) {
    const result = yield* process
      .run({
        operation,
        cwd,
        command: "but",
        args,
        stdin: "",
        allowNonZeroExit: true,
        timeoutMs:
          args[0] === "commit"
            ? 10 * 60_000
            : args[0] === "status" || args[0] === "--format" || args[0] === "config"
              ? STATUS_TIMEOUT_MS
              : 120_000,
        maxOutputBytes: args[0] === "diff" ? DIFF_MAX_OUTPUT_BYTES : STATUS_MAX_OUTPUT_BYTES,
        env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation,
              cwd,
              command: "but",
              cause,
              detail: "GitButler could not run. Install the but CLI on the server and retry.",
            }),
        ),
      );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim() || result.stdout.trim() || "GitButler command failed.";
      const authHint =
        args[0] === "pr" && /auth|token|credential|log.?in|terminal/i.test(stderr)
          ? " Run `but config forge auth` in a terminal on the server, then retry."
          : "";
      return yield* new GitCommandError({
        operation,
        cwd,
        command: "but",
        exitCode: result.exitCode,
        detail: `${stderr}${authHint}`,
      });
    }
    return result;
  });

  const readActionStatus = Effect.fn("GitButlerWorkspace.readActionStatus")(function* (
    cwd: string,
  ) {
    const result = yield* runBut(cwd, ["status", "--json"]).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          error.exitCode === undefined
            ? Effect.fail(error)
            : runBut(cwd, ["--format", "json", "status"]),
      }),
    );
    return yield* decodeStatusOutput(result.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.status", cwd, "but status", cause),
      ),
    );
  });

  const runGit = Effect.fn("GitButlerWorkspace.git")(function* (
    cwd: string,
    args: readonly string[],
    options?: {
      readonly indexFile?: string;
      readonly stdin?: string;
      readonly large?: boolean;
      /** For output whose trailing whitespace means something. */
      readonly untrimmed?: boolean;
    },
  ) {
    const result = yield* process
      .run({
        operation: "GitButlerWorkspace.git",
        command: "git",
        cwd,
        args,
        ...(options?.indexFile === undefined && !options?.large
          ? { timeoutMs: STATUS_TIMEOUT_MS, maxOutputBytes: STATUS_MAX_OUTPUT_BYTES }
          : // Hashing runs clean filters, and a cut-off listing must not read as a missing path.
            {
              timeoutMs: DIFF_TIMEOUT_MS,
              maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
              outputMode: "error" as const,
              ...(options?.indexFile === undefined
                ? {}
                : { env: { GIT_INDEX_FILE: options.indexFile } }),
            }),
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitButlerWorkspace.git",
              command: "git",
              cwd,
              cause,
              detail: "Could not read the GitButler checkout's refs.",
            }),
        ),
      );
    return options?.untrimmed ? result.stdout : result.stdout.trim();
  });

  const readTargetRefs = Effect.fn("GitButlerWorkspace.readTargetRefs")(function* (cwd: string) {
    const result = yield* runBut(cwd, ["config", "target", "--json"]);
    const target = yield* decodeTargetOutput(result.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.readTargetRefs", cwd, "but config target", cause),
      ),
    );
    const localRefs = yield* runGit(cwd, [
      "for-each-ref",
      "--format=%(refname:short)%00%(upstream:short)",
      "refs/heads/",
    ]);
    return [
      target.branch,
      ...localRefs.split("\n").flatMap((line) => {
        const [name, upstream] = line.split("\u0000");
        return name && upstream === target.branch ? [name] : [];
      }),
    ];
  });

  const readPushRemote = Effect.fn("GitButlerWorkspace.readPushRemote")(function* (cwd: string) {
    const result = yield* runBut(cwd, ["config", "push-remote", "--json"]);
    const decoded = yield* decodePushRemoteOutput(result.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.readPushRemote", cwd, "but config push-remote", cause),
      ),
    );
    return decoded.push_remote;
  });

  // Keyed by the repository, since nested projects and linked worktrees share its refs and holds.
  const withPublicationLock = Effect.fn("GitButlerWorkspace.withPublicationLock")(function* <
    A,
    E,
    R,
  >(cwd: string, effect: Effect.Effect<A, E, R>) {
    const repository = yield* runGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return yield* publications.withLock(repository, effect);
  });

  const readStoredHolds = Effect.fn("GitButlerWorkspace.readStoredHolds")(function* (cwd: string) {
    return parseHolds(
      yield* runGit(
        cwd,
        ["for-each-ref", "--format=%(refname)%00%(objectname)", HOLD_REFS_PREFIX],
        {
          large: true,
        },
      ),
    );
  });
  // This process's own unfinished commits, which a status read shouldn't call stuck.
  const holdsInFlight = new Set<string>();

  // Cache keys follow GitManager: aliases of one checkout share an entry.
  const cacheKey = (cwd: string) => fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  const diffKeyPrefix = (cwd: string) => `${cwd}\u0000`;

  const statusCache = yield* Cache.makeWith(
    Effect.fn("GitButlerWorkspace.readStatus.uncached")(function* (cwd: string) {
      const input = {
        operation: "GitButlerWorkspace.readStatus",
        command: "but",
        cwd,
        timeoutMs: STATUS_TIMEOUT_MS,
        maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
      } as const;
      const result = yield* process.run({ ...input, args: ["status", "--json"] }).pipe(
        Effect.catchTags({
          VcsProcessExitError: () =>
            process.run({ ...input, args: ["--format", "json", "status"] }),
        }),
      );
      const status = yield* decodeStatusOutput(result.stdout).pipe(
        Effect.mapError((cause) =>
          decodeError("GitButlerWorkspace.readStatus", cwd, "but status", cause),
        ),
      );
      const [targetRefs, pushRemote, holds] = yield* Effect.all(
        [
          readTargetRefs(cwd).pipe(Effect.orElseSucceed(() => [])),
          readPushRemote(cwd).pipe(Effect.orElseSucceed(() => null)),
          // Only for display; a push reads them itself and refuses if it can't.
          readStoredHolds(cwd).pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: "unbounded" },
      );
      const publications = status.stacks
        .flatMap((stack) => stack.branches)
        .flatMap((branch) => {
          const publication = branchPublication(branch);
          return publication === null ? [] : [[branch.name, publication] as const];
        });
      const heldCommitCount = holds.filter((hold) => !holdsInFlight.has(hold.ref)).length;
      return {
        _tag: "gitbutler",
        targetRefs,
        ...(heldCommitCount === 0 ? {} : { heldCommitCount }),
        ...(pushRemote === null ? {} : { pushRemote }),
        ...(publications.length === 0 ? {} : { publications: Object.fromEntries(publications) }),
        stacks: status.stacks.map((stack) => ({
          branches: stack.branches.map((branch) => branch.name),
          assignedChangeCount: stack.assignedChanges.length,
        })),
        unassignedChangeCount: status.uncommittedChanges.length,
      } satisfies GitButlerWorkspaceStatus;
    }),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_CACHE_TTL : Duration.zero),
    },
  );

  // A preview and its lazy per-file reads share one `but diff` of the branch.
  const branchChangesCache = yield* Cache.makeWith(
    Effect.fn("GitButlerWorkspace.readBranchChanges.uncached")(function* (key: string) {
      const separator = key.indexOf("\u0000");
      const cwd = key.slice(0, separator);
      const branch = key.slice(separator + 1);
      const result = yield* process.run({
        operation: "GitButlerWorkspace.readBranchDiff",
        command: "but",
        args: ["diff", branch, "--json"],
        cwd,
        timeoutMs: DIFF_TIMEOUT_MS,
        maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      });
      const decoded = yield* decodeDiffOutput(result.stdout).pipe(
        Effect.mapError((cause) =>
          decodeError("GitButlerWorkspace.readBranchDiff", cwd, "but diff", cause),
        ),
      );
      return decodeChanges(decoded.changes);
    }),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? BRANCH_DIFF_CACHE_TTL : Duration.zero),
    },
  );

  const readStatus: GitButlerWorkspace["Service"]["readStatus"] = Effect.fn(
    "GitButlerWorkspace.readStatus",
  )(function* (cwd) {
    return yield* Cache.get(statusCache, yield* cacheKey(cwd));
  });

  const readBranchDiff: GitButlerWorkspace["Service"]["readBranchDiff"] = Effect.fn(
    "GitButlerWorkspace.readBranchDiff",
  )(function* (input) {
    // Git ref names never start with "-"; a request that does would reach `but` as an option.
    if (input.branch.startsWith("-")) {
      return yield* new GitCommandError({
        operation: "GitButlerWorkspace.readBranchDiff",
        command: "but diff",
        cwd: input.cwd,
        detail: "GitButler branch names cannot start with '-'.",
      });
    }
    const cwd = yield* cacheKey(input.cwd);
    const allChanges = yield* Cache.get(branchChangesCache, `${diffKeyPrefix(cwd)}${input.branch}`);
    // `but diff` takes one CLI ID, so a file request filters the branch output.
    const file = input.file;
    const changes = file
      ? allChanges.filter(
          (change) =>
            change.path === file.path ||
            (file.previousPath !== null && change.previousPath === file.previousPath),
        )
      : allChanges;
    const { patch, files } = unifiedPatchFromChanges(changes);
    const limit = file ? FILE_PATCH_MAX_BYTES : PATCH_MAX_BYTES;
    const truncated = Buffer.byteLength(patch) > limit;
    return {
      patch: truncated
        ? `${Buffer.from(patch).subarray(0, limit).toString("utf8")}${TRUNCATION_MARKER}`
        : patch,
      files,
      truncated,
    };
  });

  // Invalidation removes in-flight entries too, and a lookup that finishes
  // after it never writes back, so a read started before an edit cannot linger.
  const invalidate: GitButlerWorkspace["Service"]["invalidate"] = Effect.fn(
    "GitButlerWorkspace.invalidate",
  )(function* (rawCwd) {
    const cwd = yield* cacheKey(rawCwd);
    yield* Cache.invalidate(statusCache, cwd);
    const prefix = diffKeyPrefix(cwd);
    for (const key of yield* Cache.keys(branchChangesCache)) {
      if (key.startsWith(prefix)) yield* Cache.invalidate(branchChangesCache, key);
    }
    commitChangesInvalidations += 1;
    for (const key of commitChangesReads.keys()) {
      if (key.startsWith(prefix)) commitChangesReads.delete(key);
    }
    for (const key of yield* Cache.keys(commitChangesCache)) {
      if (key.startsWith(prefix)) yield* Cache.invalidate(commitChangesCache, key);
    }
  });

  const inWorkspace = Effect.fn("GitButlerWorkspace.inWorkspace")(function* <A>(
    input: GitButlerBranchInput,
    action: Effect.Effect<A, GitCommandError>,
  ) {
    const cwd = yield* cacheKey(input.cwd);
    return yield* mutations.withLock(
      cwd,
      Effect.gen(function* () {
        if (
          (yield* runGit(cwd, ["symbolic-ref", "--quiet", "HEAD"])) !==
          "refs/heads/gitbutler/workspace"
        ) {
          return yield* new GitCommandError({
            operation: "GitButlerWorkspace.edit",
            command: "but",
            cwd,
            detail:
              "Apply, unapply, and create require a GitButler workspace checkout. Refresh and try again.",
          });
        }
        const requestedBranch = input.branch.replace(/^refs\/(?:heads|remotes)\//, "");
        if (
          input.branch.startsWith("-") ||
          requestedBranch.startsWith("gitbutler/") ||
          (yield* readTargetRefs(cwd)).includes(requestedBranch)
        ) {
          return yield* new GitCommandError({
            operation: "GitButlerWorkspace.edit",
            command: "but",
            cwd,
            detail: "Choose a branch outside GitButler's internal refs and target branch.",
          });
        }
        return yield* action;
      }).pipe(Effect.ensuring(invalidate(cwd))),
    );
  });

  const apply: GitButlerWorkspace["Service"]["apply"] = Effect.fn("GitButlerWorkspace.apply")(
    (input) =>
      inWorkspace(
        input,
        Effect.gen(function* () {
          const ref = yield* runGit(input.cwd, [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            input.branch,
          ]);
          const remote = ref.startsWith("refs/remotes/")
            ? (yield* runGit(input.cwd, ["remote"]))
                .split("\n")
                .filter((name) => ref.startsWith(`refs/remotes/${name}/`))
                .sort((a, b) => b.length - a.length)[0]
            : undefined;
          const branch = remote
            ? ref.slice(`refs/remotes/${remote}/`.length)
            : ref.startsWith("refs/heads/")
              ? ref.slice("refs/heads/".length)
              : "";
          if (!branch || branch.startsWith("gitbutler/")) {
            return yield* new GitCommandError({
              operation: "GitButlerWorkspace.apply",
              command: "but apply",
              cwd: input.cwd,
              detail: "Select a local or remote branch to apply.",
            });
          }
          const result = yield* runBut(input.cwd, ["apply", "--json", "--", input.branch]);
          const output = yield* decodeApplyOutput(result.stdout).pipe(
            Effect.mapError((cause) =>
              decodeError("GitButlerWorkspace.apply", input.cwd, "but apply", cause),
            ),
          );
          if (output.status !== "applied" && output.status !== "alreadyApplied") {
            return yield* new GitCommandError({
              operation: "GitButlerWorkspace.apply",
              command: "but apply",
              cwd: input.cwd,
              detail:
                "GitButler could not apply this branch. Resolve its conflicts in GitButler and retry.",
            });
          }
          const applied = output.appliedBranches.map((name) => name.replace(/^refs\/heads\//, ""));
          return { branch: applied.length === 1 ? applied[0]! : branch };
        }),
      ),
  );

  const unapply: GitButlerWorkspace["Service"]["unapply"] = Effect.fn("GitButlerWorkspace.unapply")(
    (input) =>
      inWorkspace(
        input,
        Effect.gen(function* () {
          const status = yield* readActionStatus(input.cwd);
          if (
            !status.stacks.some((stack) =>
              stack.branches.some((branch) => branch.name === input.branch),
            )
          ) {
            return yield* new GitCommandError({
              operation: "GitButlerWorkspace.unapply",
              command: "but unapply",
              cwd: input.cwd,
              detail: "This GitButler branch is no longer applied. Refresh and try again.",
            });
          }
          if (status.stacks.filter((stack) => stack.branches.length > 0).length <= 1) {
            return yield* new GitCommandError({
              operation: "GitButlerWorkspace.unapply",
              command: "but unapply",
              cwd: input.cwd,
              detail:
                "Keep at least one stack applied. Unapplying the last applied stack checks out the target branch; use GitButler directly to leave the workspace.",
            });
          }
          yield* runBut(input.cwd, ["unapply", "--json", "--", input.branch]);
          // GitButler also leaves workspace mode when just one stack remains.
          if (
            (yield* runGit(input.cwd, ["symbolic-ref", "--quiet", "HEAD"])) !==
            "refs/heads/gitbutler/workspace"
          ) {
            yield* runBut(input.cwd, ["switch", "--workspace", "--json"]);
          }
        }),
      ),
  );

  const createBranch: GitButlerWorkspace["Service"]["createBranch"] = Effect.fn(
    "GitButlerWorkspace.createBranch",
  )((input) =>
    inWorkspace(
      input,
      Effect.gen(function* () {
        const result = yield* runBut(input.cwd, ["branch", "new", "--json", "--", input.branch]);
        return yield* decodeNewBranchOutput(result.stdout).pipe(
          Effect.mapError((cause) =>
            decodeError("GitButlerWorkspace.createBranch", input.cwd, "but branch new", cause),
          ),
        );
      }),
    ),
  );

  const ensureApplied = Effect.fn("GitButlerWorkspace.ensureApplied")(function* (
    cwd: string,
    branch: string,
  ) {
    const status = yield* readActionStatus(cwd);
    const stack = status.stacks.find((stack) =>
      stack.branches.some((entry) => entry.name === branch),
    );
    if (branch.startsWith("-") || !stack) {
      return yield* new GitCommandError({
        operation: "GitButlerWorkspace.target",
        cwd,
        command: "but",
        detail:
          "Select an applied GitButler branch for this thread before pushing or creating a PR.",
      });
    }
    return stack;
  });

  // A throwaway index gives what `git add` would store, so filters, symlinks, and modes count the
  // way they do in a commit, without touching the real index or writing objects.
  const readExpectedChanges = Effect.fn("GitButlerWorkspace.readExpectedChanges")(
    function* (
      cwd: string,
      paths: readonly string[],
      changeTypes: ReadonlyMap<string, string | undefined>,
      exactRenamesOnly: boolean,
    ) {
      const changes = new Map<string, ExpectedChange>();
      if (paths.length === 0) return changes;
      // Change paths are relative to the repository root, which `cwd` may be below.
      const root = yield* runGit(cwd, ["rev-parse", "--show-toplevel"]);
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gitbutler-" });
      const indexFile = `${directory}/index`;
      const git = (args: readonly string[], stdin?: string) =>
        runGit(root, ["-c", "core.splitIndex=false", ...args], {
          indexFile,
          ...(stdin === undefined ? {} : { stdin }),
        });
      yield* git(["read-tree", "HEAD"]);
      // Only a rename needs the deleted paths, and this runs on every poll of an open dialog.
      const hasRenames = paths.some((path) => changeTypes.get(path) === "renamed");
      const deleted = parseRawDiff(
        hasRenames
          ? yield* git(["diff-files", "--raw", "-z", "--no-renames", "--diff-filter=D"])
          : "",
      );
      // `but` lists a deleted path of its own unless a rename consumed it.
      const consumed = [...deleted].filter(([source]) => !changeTypes.has(source));
      yield* git(
        ["update-index", "--add", "--remove", "--replace", "--info-only", "-z", "--stdin"],
        // Git pairs an edited rename against every other one, as `but` did, chosen or not.
        (exactRenamesOnly || !hasRenames
          ? paths
          : [
              ...new Set([
                ...paths,
                ...consumed.map(([source]) => source),
                ...[...changeTypes].flatMap(([path, type]) => (type === "renamed" ? path : [])),
              ]),
            ]
        ).join("\0"),
      );
      const current = parseRawDiff(
        yield* git(["diff-index", "--cached", "--raw", "-z", "--no-renames", "HEAD", "--"]),
      );
      const needsPairing = !exactRenamesOnly && hasRenames;
      // An edited rename only has a source by similarity, so ask git to pair it. A pairing `but`
      // made differently shows up as a mismatch rather than passing unnoticed.
      const pairs = needsPairing
        ? parseRenames(yield* git(["diff-index", "--cached", "--raw", "-z", "-M", "HEAD", "--"]))
        : new Map<string, string>();
      for (const path of paths) {
        const entry = current.get(path);
        const changeType = changeTypes.get(path);
        // Left out means it can't be checked, and callers then refuse to commit it.
        if (!entry || (exactRenamesOnly && changeType === undefined)) continue;
        if (entry.status === "D") {
          changes.set(path, { path, mode: null, blob: null, renamedFrom: null });
          continue;
        }
        const sources = exactRenamesOnly
          ? consumed.filter(([, { srcBlob }]) => srcBlob === entry.blob).map(([source]) => source)
          : [pairs.get(path)].flatMap((source) => source ?? []);
        if (changeType !== "renamed" || sources.length === 1) {
          changes.set(path, {
            path,
            mode: entry.mode,
            blob: entry.blob,
            renamedFrom: changeType === "renamed" ? sources[0]! : null,
          });
        }
      }
      return changes;
    },
    Effect.scoped,
    (effect) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the state of GitButler changes", { cause }).pipe(
            Effect.as(new Map<string, ExpectedChange>()),
          ),
        ),
      ),
  );

  const readCommitFiles = Effect.fn("GitButlerWorkspace.readCommitFiles")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const status = yield* readActionStatus(cwd);
    const target =
      branch === null
        ? undefined
        : status.stacks.find((stack) => stack.branches.some((entry) => entry.name === branch));
    if (branch !== null && (branch.startsWith("-") || !target)) {
      return yield* new GitCommandError({
        operation: "GitButlerWorkspace.commit",
        cwd,
        command: "but commit",
        detail:
          "The thread's GitButler branch is no longer applied. Select an applied branch or commit on a new branch.",
      });
    }
    const changeTypes = new Map<string, string | undefined>();
    const decodePaths = (changes: readonly unknown[]) =>
      decodeAssignedChanges(changes).pipe(
        Effect.map((decoded) =>
          decoded.map((change) => {
            changeTypes.set(change.filePath, change.changeType);
            return change.filePath;
          }),
        ),
        Effect.mapError((cause) =>
          decodeError("GitButlerWorkspace.readCommitFiles", cwd, "but status", cause),
        ),
      );
    const unassigned = new Set(yield* decodePaths(status.uncommittedChanges));
    const assignedToTarget = new Set(yield* decodePaths(target?.assignedChanges ?? []));
    const assignedElsewhere = new Map<string, string>();
    for (const stack of status.stacks) {
      if (stack === target) continue;
      for (const path of yield* decodePaths(stack.assignedChanges)) {
        assignedElsewhere.set(path, stack.branches[0]?.name ?? "another stack");
      }
    }
    const conflicted = new Set(status.conflictedFiles ?? []);
    const diff = yield* runBut(cwd, ["diff", "--json"]);
    const decoded = yield* decodeDiffOutput(diff.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.readCommitFiles", cwd, "but diff", cause),
      ),
    );
    const changesByPath = new Map<string, BranchChange[]>();
    for (const change of decodeChanges(decoded.changes)) {
      const changes = changesByPath.get(change.path);
      if (changes) changes.push(change);
      else changesByPath.set(change.path, [change]);
    }
    const hunkless = [...changesByPath.entries()]
      .filter(([, changes]) =>
        changes.some((change) => change.id !== null && !change.hunks?.length),
      )
      .map(([path]) => path);
    // Only exact renames have no hunks, so one that can't name a single source can't be checked.
    const hunklessChanges = yield* readExpectedChanges(cwd, hunkless, changeTypes, true);
    const textChanges = yield* readExpectedChanges(
      cwd,
      [...changesByPath.entries()]
        .filter(
          ([path, changes]) =>
            !hunklessChanges.has(path) && changes.some((change) => change.hunks?.length),
        )
        .map(([path]) => path),
      changeTypes,
      false,
    );
    const expected = (path: string) => hunklessChanges.get(path) ?? textChanges.get(path);
    // `but` applies hunks to the branch, so a file that differs there from the workspace can't end
    // up as the blob on disk, and nothing else proves where its chosen lines landed.
    const startingPoint =
      branch === null ? (status.mergeBase?.commitId ?? null) : `refs/heads/${branch}`;
    const changedElsewhere = new Set(
      startingPoint === null
        ? []
        : (yield* runGit(
            cwd,
            [
              "diff-tree",
              "-r",
              "-z",
              "--name-only",
              "--no-renames",
              "--ignore-submodules=none",
              "HEAD",
              startingPoint,
              "--",
            ],
            { large: true, untrimmed: true },
          )).split("\0"),
    );
    const isChangedElsewhere = (path: string) => {
      const source = expected(path)?.renamedFrom;
      return changedElsewhere.has(path) || (!!source && changedElsewhere.has(source));
    };
    const paths = new Set([
      ...changesByPath.keys(),
      ...unassigned,
      ...assignedToTarget,
      ...assignedElsewhere.keys(),
      ...conflicted,
    ]);
    const files = [...paths].toSorted().map((path): GitButlerCommitFile => {
      const changes = changesByPath.get(path) ?? [];
      const changeIds = [
        ...new Set(
          changes.flatMap((change) => {
            const state = change.hunks?.length ? expected(path) : hunklessChanges.get(path);
            return change.id !== null && state
              ? [`${change.id}@${expectedFingerprint(state)}`]
              : [];
          }),
        ),
      ];
      const stats = unifiedPatchFromChanges(changes).files;
      const assignedBranch = assignedElsewhere.get(path);
      const elsewhere = isChangedElsewhere(path);
      return {
        path,
        // Status names only the file, so a hunk can't be cleared of another stack's claim. A path
        // missing from status or without IDs stays visible but can't be named in a commit.
        scope:
          assignedBranch !== undefined ||
          conflicted.has(path) ||
          changeIds.length === 0 ||
          startingPoint === null ||
          elsewhere
            ? "locked"
            : unassigned.has(path) && assignedToTarget.has(path)
              ? "mixed"
              : assignedToTarget.has(path)
                ? "target"
                : unassigned.has(path)
                  ? "shared"
                  : "locked",
        ...(assignedBranch === undefined ? {} : { assignedBranch }),
        ...(elsewhere ? { changedElsewhere: true } : {}),
        changeIds,
        insertions: stats.reduce((sum, file) => sum + file.additions, 0),
        deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
      };
    });
    return { files, expected };
  });

  // Decides only whether the dialog's list is worth reading again, and proves nothing: `commit`
  // hashes what it takes afresh. It compares dirty files by content rather than stat data, skips
  // filters since raw bytes are enough to notice an edit, and takes no lock on the real index. A
  // path git can't hash, such as a nested repository, leaves no signature, so the list is read.
  const readCommitChangesSignature = Effect.fn("GitButlerWorkspace.readCommitChangesSignature")(
    function* (cwd: string, branch: string | null) {
      const revisions = yield* runGit(cwd, [
        "rev-parse",
        "--show-toplevel",
        "HEAD",
        ...(branch === null ? [] : [`refs/heads/${branch}`]),
      ]);
      const root = revisions.split("\n", 1)[0]!;
      const status = yield* runGit(
        root,
        [
          "--no-optional-locks",
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--no-renames",
        ],
        { large: true, untrimmed: true },
      );
      const paths = porcelainPathsOnDisk(status);
      const hashes =
        paths.length === 0
          ? ""
          : yield* runGit(root, ["hash-object", "--no-filters", "--stdin-paths"], {
              large: true,
              stdin: paths.map(quoteGitPatchPath).join("\n"),
            });
      return fingerprint([revisions, status, hashes].join("\0"));
    },
    (effect) => effect.pipe(Effect.orElseSucceed(() => null)),
  );

  const commitChangesReads = new Map<
    string,
    {
      readonly signature: string;
      readonly readAt: number;
      readonly result: GitButlerCommitChangesResult;
    }
  >();
  let commitChangesInvalidations = 0;
  const commitChangesCache = yield* Cache.makeWith(
    Effect.fn("GitButlerWorkspace.readCommitChanges.uncached")(function* (key: string) {
      const separator = key.indexOf("\u0000");
      const cwd = key.slice(0, separator);
      const branch = key.slice(separator + 1) || null;
      const invalidations = commitChangesInvalidations;
      // Read before the list, so an edit landing during the read makes the next poll read again.
      const signature = yield* readCommitChangesSignature(cwd, branch);
      const now = yield* Clock.currentTimeMillis;
      const previous = commitChangesReads.get(key);
      if (
        previous !== undefined &&
        previous.signature === signature &&
        now - previous.readAt < COMMIT_CHANGES_MAX_REUSE_MS
      ) {
        return previous.result;
      }
      const { files } = yield* readCommitFiles(cwd, branch);
      const result = { files };
      commitChangesReads.delete(key);
      if (signature !== null && invalidations === commitChangesInvalidations) {
        commitChangesReads.set(key, { signature, readAt: now, result });
        if (commitChangesReads.size > CACHE_CAPACITY) {
          commitChangesReads.delete(commitChangesReads.keys().next().value!);
        }
      }
      return result;
    }),
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? COMMIT_CHANGES_CACHE_TTL : Duration.zero),
    },
  );

  const readCommitChanges: GitButlerWorkspace["Service"]["readCommitChanges"] = Effect.fn(
    "GitButlerWorkspace.readCommitChanges",
  )(function* (input) {
    const cwd = yield* cacheKey(input.cwd);
    return yield* Cache.get(commitChangesCache, `${diffKeyPrefix(cwd)}${input.branch ?? ""}`);
  });

  const staleSelectionError = (cwd: string) =>
    new GitCommandError({
      operation: "GitButlerWorkspace.selectChanges",
      cwd,
      command: "but commit",
      detail:
        "Selected changes were edited or committed after you chose them, so nothing was committed. Review the changes and choose them again.",
    });

  const prepareCommit: GitButlerWorkspace["Service"]["prepareCommit"] = Effect.fn(
    "GitButlerWorkspace.prepareCommit",
  )(
    function* (input) {
      const changeIds = [...new Set(input.changeIds)];
      const { files, expected } = yield* readCommitFiles(input.cwd, input.branch);
      const fileById = new Map(
        files.flatMap((file) => file.changeIds.map((id) => [id, file] as const)),
      );
      const selected = changeIds.flatMap((id) => fileById.get(id) ?? []);
      if (selected.length !== changeIds.length) return yield* staleSelectionError(input.cwd);
      const blocked = selected.find(
        (file) => file.scope === "locked" || (input.branch === null && file.scope !== "shared"),
      );
      if (blocked) {
        return yield* new GitCommandError({
          operation: "GitButlerWorkspace.selectChanges",
          cwd: input.cwd,
          command: "but commit",
          detail: blocked.assignedBranch
            ? `${blocked.path} is assigned to ${blocked.assignedBranch}, so nothing was committed. Assign it in GitButler or choose other changes.`
            : blocked.changedElsewhere && input.branch === null
              ? `${blocked.path} is already changed on an applied branch, which a new branch wouldn't start from, so nothing was committed. Commit it to that branch or use \`but commit\`.`
              : blocked.changedElsewhere
                ? `${blocked.path} differs between ${input.branch} and the workspace, so T3 Code can't check a commit of it and nothing was committed. Use \`but commit\` or choose other changes.`
                : `${blocked.path} cannot be committed from this branch, so nothing was committed. Assign it in GitButler or choose other changes.`,
        });
      }
      const chosen = new Set(changeIds);
      // What part of a file a commit holds can't be proven afterwards, so only whole files are taken.
      const partial = selected.find((file) => !file.changeIds.every((id) => chosen.has(id)));
      if (partial) {
        return yield* new GitCommandError({
          operation: "GitButlerWorkspace.selectChanges",
          cwd: input.cwd,
          command: "but commit",
          detail: `Only part of ${partial.path} was chosen, or it changed since you chose it, so nothing was committed. T3 Code commits whole files: choose it again, or use \`but commit\` for part of a file.`,
        });
      }
      const filePaths = [...new Set(selected.map((file) => file.path))];
      return {
        changeIds,
        cliIds: changeIds.map(cliId),
        filePaths,
        expected: filePaths.flatMap((path) => expected(path) ?? []),
      };
    },
    // A refused choice came from a list that was out of date, so the dialog shouldn't show it again.
    (effect, input) => effect.pipe(Effect.tapError(() => invalidate(input.cwd))),
  );

  const readCommitContext: GitButlerWorkspace["Service"]["readCommitContext"] = Effect.fn(
    "GitButlerWorkspace.readCommitContext",
  )(function* (cwd, selection, includePatch) {
    if (selection.changeIds.length === 0) return null;
    const stagedSummary = selection.filePaths.join("\n");
    if (!includePatch) return { stagedSummary, stagedPatch: "" };
    const result = yield* runBut(cwd, ["diff", "--json"]);
    const decoded = yield* decodeDiffOutput(result.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.readCommitContext", cwd, "but diff", cause),
      ),
    );
    const selected = new Set(selection.cliIds);
    const { patch } = unifiedPatchFromChanges(
      decodeChanges(decoded.changes).filter(
        (change) => change.id !== null && selected.has(change.id),
      ),
    );
    return { stagedSummary, stagedPatch: patch };
  });

  // `but` has no way to commit only if a file still holds given bytes, so this can't prevent a
  // late edit landing in the commit. It reports one, from the commit's immutable trees: the chosen
  // files must be exactly as chosen and nothing else may differ, or the commit isn't confirmed.
  const describeSelectionMismatch = Effect.fn("GitButlerWorkspace.describeSelectionMismatch")(
    function* (
      cwd: string,
      branch: string,
      commitSha: string,
      expected: readonly ExpectedChange[],
    ) {
      const short = commitSha.slice(0, 12);
      const recourse = `No push or PR was started and nothing was undone, and T3 Code will ask before any later push or PR includes it. Check it with \`git show ${short}\`; \`but uncommit ${short}\` moves it back to uncommitted changes.`;
      return yield* runGit(
        cwd,
        [
          "diff-tree",
          "-r",
          "--raw",
          "-z",
          "--no-renames",
          "--ignore-submodules=none",
          `${commitSha}^`,
          commitSha,
          "--",
        ],
        { large: true, untrimmed: true },
      ).pipe(
        Effect.map((stdout) => {
          const committed = parseRawDiff(stdout);
          const isDeleted = (path: string) => committed.get(path)?.status === "D";
          const chosen = new Set(
            expected.flatMap(({ path, renamedFrom }) =>
              renamedFrom === null ? [path] : [path, renamedFrom],
            ),
          );
          const changed = [
            ...expected.flatMap(({ path, mode, blob, renamedFrom }) => {
              const entry = committed.get(path);
              const asChosen =
                (mode === null
                  ? isDeleted(path)
                  : entry !== undefined && entry.mode === mode && entry.blob === blob) &&
                (renamedFrom === null || isDeleted(renamedFrom));
              return asChosen ? [] : [path];
            }),
            ...[...committed.keys()].filter((path) => !chosen.has(path)),
          ];
          return changed.length === 0
            ? null
            : `Committed ${short} on ${branch}, but what it holds for ${changed.join(", ")} isn't what you chose, most likely from a later edit, and may be someone else's work. ${recourse}`;
        }),
        Effect.orElseSucceed(
          () =>
            `Committed ${short} on ${branch}, but T3 Code could not confirm what it holds for ${expected.map((change) => change.path).join(", ")} is what you chose. ${recourse}`,
        ),
      );
    },
  );

  const readBranchTips = (cwd: string) =>
    runGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"], {
      large: true,
    });

  const writePendingHold = Effect.fn("GitButlerWorkspace.writePendingHold")(function* (
    cwd: string,
    branch: string,
  ) {
    const id = NodeCrypto.randomUUID();
    const ref = `${HOLD_REFS_PREFIX}pending/${id}/${NO_CHANGE_ID}/${branch}`;
    const sha = yield* runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
    yield* runGit(cwd, ["update-ref", ref, sha, ""]).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitButlerWorkspace.commit",
            cwd,
            command: "git update-ref",
            detail:
              "T3 Code could not record this commit so it can be checked before publishing, so nothing was committed.",
            cause,
          }),
      ),
    );
    return { id, ref, sha };
  });

  /** Removes each hold only if it still points where it was read, all or none. */
  const deleteHolds = (
    cwd: string,
    holds: ReadonlyArray<{ readonly ref: string; readonly sha: string }>,
  ) =>
    runGit(cwd, ["update-ref", "--stdin"], {
      stdin: holds.map(({ ref, sha }) => `delete ${ref} ${sha}\n`).join(""),
    });

  // Not one transaction: `git update-ref -d`, or an older server that didn't check, may have ended
  // the pending hold, and that must not stop what nobody has reviewed from being held.
  const replacePendingHold = Effect.fn("GitButlerWorkspace.replacePendingHold")(function* (
    cwd: string,
    pending: { readonly id: string; readonly ref: string; readonly sha: string },
    next: {
      readonly state: "unverified" | "interrupted";
      readonly branch: string;
      readonly sha: string;
      readonly changeId?: string | null | undefined;
    },
  ) {
    const ref = `${HOLD_REFS_PREFIX}${next.state}/${pending.id}/${next.changeId ?? NO_CHANGE_ID}/${next.branch}`;
    yield* runGit(cwd, ["update-ref", ref, next.sha, ""]);
    yield* deleteHolds(cwd, [pending]).pipe(Effect.ignore);
  });

  // Only if no branch anywhere moved is it proven that nothing landed: one landing could have been
  // moved off this branch already. Another writer's commit in this moment leaves a needless hold.
  const settleFailedCommit = Effect.fn("GitButlerWorkspace.settleFailedCommit")(function* (
    input: { readonly cwd: string; readonly branch: string },
    clearPending: Effect.Effect<void, GitCommandError>,
    before: string,
    error: GitCommandError,
  ) {
    const after = yield* readBranchTips(input.cwd).pipe(Effect.orElseSucceed(() => undefined));
    if (after !== before) {
      return yield* new GitCommandError({
        ...error,
        detail: `${error.detail} Branches moved meanwhile, so a commit may have landed, and T3 Code will ask before any push or PR.`,
      });
    }
    yield* clearPending.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not clear a GitButler publication hold", { cause }),
      ),
    );
    return yield* error;
  });

  const commit: GitButlerWorkspace["Service"]["commit"] = Effect.fn("GitButlerWorkspace.commit")(
    function* (input) {
      if (input.branch.startsWith("-"))
        return yield* new GitCommandError({
          operation: "GitButlerWorkspace.commit",
          cwd: input.cwd,
          command: "but commit",
          detail: "Invalid GitButler branch name.",
        });
      // `but commit` with no IDs would commit everything uncommitted in the checkout.
      if (input.changeIds.length === 0) return null;
      return yield* withPublicationLock(
        input.cwd,
        Effect.gen(function* () {
          const { cliIds, expected } = yield* prepareCommit({
            cwd: input.cwd,
            branch: input.createBranch ? null : input.branch,
            changeIds: input.changeIds,
          });
          const before = yield* readBranchTips(input.cwd);
          // Written first, so a crash anywhere below leaves the branch held rather than trusted.
          const pending = yield* writePendingHold(input.cwd, input.branch);
          holdsInFlight.add(pending.ref);
          let settled = false;
          const markSettled = Effect.sync(() => {
            settled = true;
          });
          const clearPending = deleteHolds(input.cwd, [pending]).pipe(Effect.andThen(markSettled));
          // POSIX cleanup ends in SIGKILL and waits for the exit. A failed `taskkill` goes unreported,
          // so on Windows a `but` that wasn't seen to exit may still be running: it stays pending.
          const exitIsProvenOnStop = (yield* HostProcess.Platform) !== "win32";
          let exitObserved = false;
          const stillRunning = () => !exitIsProvenOnStop && !exitObserved;
          return yield* Effect.gen(function* () {
            const result = yield* runBut(input.cwd, [
              "commit",
              "-b",
              input.branch,
              "-m",
              input.message,
              "--json",
              "--",
              ...cliIds,
            ]).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  exitObserved = true;
                }),
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  exitObserved = error.exitCode !== undefined;
                }),
              ),
              // An edit landing after the check above usually changes the ID, and the CLI commits nothing.
              Effect.catchTags({
                GitCommandError: (error) =>
                  Effect.fail(
                    error.detail.includes("Could not find uncommitted change")
                      ? staleSelectionError(input.cwd)
                      : error,
                  ),
              }),
              Effect.catchTags({
                GitCommandError: (error) =>
                  stillRunning()
                    ? Effect.fail(error)
                    : settleFailedCommit(input, clearPending, before, error),
              }),
            );
            const decoded = yield* decodeCommitOutput(result.stdout).pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    operation: "GitButlerWorkspace.commit",
                    cwd: input.cwd,
                    command: "but commit",
                    detail: `GitButler reported success, but T3 Code could not read which commit it made, so nothing was pushed, and T3 Code will ask before any push or PR. Check ${input.branch} before retrying.`,
                    cause,
                  }),
              ),
            );
            const selectionMismatch = yield* describeSelectionMismatch(
              input.cwd,
              input.branch,
              decoded.commitId,
              expected,
            );
            // Either failure leaves the pending hold, which still holds the branch.
            yield* (
              selectionMismatch === null
                ? clearPending
                : replacePendingHold(input.cwd, pending, {
                    state: "unverified",
                    branch: input.branch,
                    sha: decoded.commitId,
                    changeId: decoded.changeId,
                  }).pipe(Effect.andThen(markSettled))
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not update a GitButler publication hold", { cause }),
              ),
            );
            return {
              commitSha: decoded.commitId,
              ...(selectionMismatch === null ? {} : { selectionMismatch }),
            };
          }).pipe(
            Effect.ensuring(
              // Ended with its outcome unknown, so no other server need wonder if it's still going.
              Effect.suspend(() =>
                settled || stillRunning()
                  ? Effect.void
                  : replacePendingHold(input.cwd, pending, {
                      state: "interrupted",
                      branch: input.branch,
                      sha: pending.sha,
                    }).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Could not update a GitButler publication hold", {
                          cause,
                        }),
                      ),
                    ),
              ).pipe(
                Effect.andThen(Effect.sync(() => holdsInFlight.delete(pending.ref))),
                Effect.andThen(invalidate(input.cwd)),
              ),
            ),
          );
        }),
      );
    },
  );

  const readPublishedBranches: GitButlerWorkspace["Service"]["readPublishedBranches"] = Effect.fn(
    "GitButlerWorkspace.readPublishedBranches",
  )(function* ({ cwd, branch }) {
    const status = yield* readActionStatus(cwd);
    const branches =
      status.stacks.find((stack) => stack.branches.some((entry) => entry.name === branch))
        ?.branches ?? [];
    return branches
      .slice(branches.findIndex((entry) => entry.name === branch))
      .map((entry) => entry.name);
  });

  const branchHasRevision: GitButlerWorkspace["Service"]["branchHasRevision"] = Effect.fn(
    "GitButlerWorkspace.branchHasRevision",
  )(function* ({ cwd, branch, sha }) {
    const status = yield* readActionStatus(cwd);
    const commits = status.stacks
      .flatMap((stack) => stack.branches)
      .find((entry) => entry.name === branch)?.commits;
    if (commits?.some((commit) => Option.getOrNull(decodeCommitId(commit))?.commitId === sha)) {
      return true;
    }
    // After a rewrite the old head is gone locally, but the upstream still points at it.
    const upstream = yield* runGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${branch}@{upstream}`,
    ]).pipe(Effect.orElseSucceed(() => null));
    return upstream === sha;
  });

  // A dry run fetches first, so it sees remote branches `but status` does not yet, and it only
  // reports the branch it names, while a real push also sends the branches below it.
  const readForcePushTargets = Effect.fn("GitButlerWorkspace.readForcePushTargets")(function* (
    cwd: string,
    branch: string,
    branches: ReadonlyArray<string>,
  ) {
    const targets: Array<GitButlerForcePushTarget> = [];
    for (const name of branches.slice(branches.indexOf(branch))) {
      const result = yield* runBut(cwd, ["push", name, "--dry-run", "--json"]);
      const decoded = yield* decodePushDryRun(result.stdout).pipe(
        Effect.mapError((cause) =>
          decodeError("GitButlerWorkspace.readForcePushTargets", cwd, "but push --dry-run", cause),
        ),
      );
      for (const entry of decoded.branches) {
        if (entry.branchName !== name || !entry.requiresForce) continue;
        // Fails rather than defaulting: an approval must always name the commit it replaces.
        const remoteSha = yield* runGit(cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${entry.remote}/${name}`,
        ]);
        targets.push({
          branch: name,
          remote: entry.remote,
          remoteSha,
          overwrittenCommits: entry.upstreamCommits ?? [],
        });
      }
    }
    return targets;
  });

  // Binds to what gets replaced rather than the local head, which a commit in the same action moves.
  const ensureForcePushApproved = Effect.fn("GitButlerWorkspace.ensureForcePushApproved")(
    function* (
      input: { readonly cwd: string; readonly branch: string; readonly forcePushApproval?: string },
      branches: ReadonlyArray<string>,
    ) {
      const targets = yield* readForcePushTargets(input.cwd, input.branch, branches);
      if (targets.length === 0) return;
      const approval = targets
        .map((target) => `${target.remote}/${target.branch}@${target.remoteSha}`)
        .join("\n");
      if (input.forcePushApproval === approval) return;
      return yield* new GitButlerForcePushConfirmationError({
        cwd: input.cwd,
        branch: input.branch,
        targets,
        approval,
        staleApproval: input.forcePushApproval !== undefined,
      });
    },
  );

  const locateHold = (branches: ReadonlyArray<StatusBranch>, hold: StoredHold) =>
    branches.flatMap((branch) =>
      (branch.commits ?? []).flatMap((raw) => {
        const commit = Option.getOrNull(decodeCommitId(raw));
        return commit !== null &&
          (commit.commitId === hold.sha ||
            (hold.changeId !== null && commit.changeId === hold.changeId))
          ? [{ branch: branch.name, sha: commit.commitId }]
          : [];
      }),
    );

  const isOnLocalBranch = (cwd: string, hold: StoredHold) =>
    runGit(cwd, ["merge-base", "--is-ancestor", hold.sha, `refs/heads/${hold.branch}`]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // A resolution names what was shown, so anything since asks again. A commit that can't be located
  // could be anywhere, so any branch moving voids it. `but status` failing just leaves nothing
  // located, as outside workspace mode, which only ever asks again.
  const reviewHolds = Effect.fn("GitButlerWorkspace.reviewHolds")(function* (
    cwd: string,
    holds: readonly StoredHold[],
    shownBranches?: ReadonlyArray<StatusBranch>,
  ) {
    // Tips first: a move in between then voids the token rather than slipping into it.
    const tips = yield* readBranchTips(cwd);
    const branches =
      shownBranches ??
      (yield* readActionStatus(cwd).pipe(
        Effect.map((status) => status.stacks.flatMap((stack) => stack.branches)),
        Effect.orElseSucceed((): ReadonlyArray<StatusBranch> => []),
      ));
    return yield* Effect.forEach(holds, (hold) =>
      Effect.gen(function* () {
        const located = hold.state === "unverified" ? locateHold(branches, hold) : [];
        const resolution = NodeCrypto.createHash("sha256")
          .update(
            [
              hold.ref,
              hold.sha,
              ...located.map((location) => `${location.branch}@${location.sha}`).sort(),
              located.length === 0 ? tips : "",
            ].join("\0"),
          )
          .digest("hex");
        const [here] = located;
        const held: GitButlerHeldCommit = {
          branch: here?.branch ?? hold.branch,
          state: hold.state,
          commitSha: hold.state === "unverified" ? (here?.sha ?? hold.sha) : null,
          found:
            hold.state === "unverified" &&
            (here !== undefined || (yield* isOnLocalBranch(cwd, hold))),
          ...(hold.mayBeRunning ? { possiblyRunningRef: hold.ref } : { resolution }),
        };
        return { hold, held };
      }),
    );
  });

  // Where each hold's commit is now, so a rewrite that moved it is still found. Nothing that can't
  // be found is presumed gone: squash, a rename, or an uncommit look alike from here, and any of
  // them may have left its bytes on a branch this push sends.
  const blockingHolds = Effect.fn("GitButlerWorkspace.blockingHolds")(function* (
    cwd: string,
    holds: readonly StoredHold[],
    pushed: string,
  ) {
    const status = yield* readActionStatus(cwd);
    const branches = status.stacks.flatMap((stack) => stack.branches);
    const names = status.stacks
      .find((stack) => stack.branches.some((branch) => branch.name === pushed))
      ?.branches.map((branch) => branch.name) ?? [pushed];
    const sent = new Set(names.slice(names.indexOf(pushed)));
    const applied = new Set(branches.map((branch) => branch.name));
    const blocking: Array<{ readonly hold: StoredHold; readonly view: GitButlerPublicationHold }> =
      [];
    for (const hold of holds) {
      const view = { branch: hold.branch, state: hold.state };
      // With no identity there's nothing to follow, so a later move can't be ruled out.
      if (hold.state === "interrupted") {
        blocking.push({ hold, view: { ...view, commitSha: null, found: false } });
        continue;
      }
      const locations = locateHold(branches, hold);
      const here = locations.find((location) => sent.has(location.branch));
      if (here) {
        blocking.push({
          hold,
          view: { ...view, branch: here.branch, commitSha: here.sha, found: true },
        });
      } else if (
        locations.length === 0 &&
        // An unapplied branch still has it, and T3 Code can't push from one.
        (applied.has(hold.branch) || !(yield* isOnLocalBranch(cwd, hold)))
      ) {
        blocking.push({ hold, view: { ...view, commitSha: hold.sha, found: false } });
      }
    }
    return { blocking, sent, branches };
  });

  // An approval names each hold, where it is now, and the tips being sent, so anything rewritten
  // after it was shown asks again. Approving ends the hold before the push: a failed push doesn't
  // change what was acknowledged. That's all it records, as any client with write access can send
  // it. A commit that may still be running has nothing to acknowledge yet, so it never gets one.
  const settleHolds = Effect.fn("GitButlerWorkspace.settleHolds")(function* (
    input: { readonly cwd: string; readonly branch: string; readonly holdApproval?: string },
    blocking: ReadonlyArray<{
      readonly hold: StoredHold;
      readonly view: GitButlerPublicationHold;
    }>,
    sentRevisions: readonly string[],
    // What `blocking` was located from. Without it, what's shown comes from the review's own read.
    shownBranches?: ReadonlyArray<StatusBranch>,
  ) {
    if (blocking.length === 0) return;
    const running = blocking.map(({ hold }) => hold).filter((hold) => hold.mayBeRunning);
    if (running.length > 0) {
      return yield* new GitCommandError({
        operation: "GitButlerWorkspace.settleHolds",
        cwd: input.cwd,
        command: "git for-each-ref",
        detail: possiblyRunningDetail(running),
      });
    }
    const tips = yield* runGit(input.cwd, ["rev-parse", ...sentRevisions]);
    const approval = [
      ...blocking.map(({ hold, view }) => `${hold.ref}@${hold.sha}@${view.commitSha ?? ""}`),
      tips,
    ].join("\n");
    if (input.holdApproval !== approval) {
      const reviewed = yield* reviewHolds(
        input.cwd,
        blocking.map(({ hold }) => hold),
        shownBranches,
      );
      return yield* new GitButlerPublicationHoldError({
        cwd: input.cwd,
        branch: input.branch,
        holds: blocking.map(({ view }, index) => {
          const { commitSha, resolution } = reviewed[index]!.held;
          return {
            ...view,
            ...(shownBranches === undefined ? { commitSha } : {}),
            ...(resolution === undefined ? {} : { resolution }),
          };
        }),
        approval,
        staleApproval: input.holdApproval !== undefined,
      });
    }
    yield* deleteHolds(
      input.cwd,
      blocking.map(({ hold }) => hold),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitButlerWorkspace.settleHolds",
            cwd: input.cwd,
            command: "git update-ref",
            detail:
              "T3 Code could not record that these commits were reviewed, so nothing was pushed.",
            cause,
          }),
      ),
    );
  });

  const readHoldsForPublish = (cwd: string) =>
    readStoredHolds(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitButlerWorkspace.readHolds",
            cwd,
            command: "git for-each-ref",
            detail:
              "T3 Code could not check for commits held from publishing, so nothing was pushed or changed.",
            cause,
          }),
      ),
    );

  const ensureNotHeld = Effect.fn("GitButlerWorkspace.ensureNotHeld")(function* (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly holdApproval?: string;
  }) {
    const holds = yield* readHoldsForPublish(input.cwd);
    if (holds.length === 0) return;
    const { blocking, sent, branches } = yield* blockingHolds(input.cwd, holds, input.branch);
    yield* settleHolds(
      input,
      blocking,
      [...sent].map((branch) => `refs/heads/${branch}`),
      branches,
    );
  });

  // The lock keeps this server's commits out from between the check and the push. Holds and the
  // stack are read again after the dry run, which reaches the network, in case another server's
  // commit or a restack came in; one landing after that last check can still go out.
  const publishing = Effect.fn("GitButlerWorkspace.publishing")(function* <A, E>(
    input: {
      readonly cwd: string;
      readonly branch: string;
      readonly forcePushApproval?: string;
      readonly holdApproval?: string;
    },
    publish: Effect.Effect<A, E>,
  ) {
    return yield* withPublicationLock(
      input.cwd,
      Effect.gen(function* () {
        const stack = yield* ensureApplied(input.cwd, input.branch);
        yield* ensureNotHeld(input);
        yield* ensureForcePushApproved(
          input,
          stack.branches.map((entry) => entry.name),
        );
        yield* ensureNotHeld({ cwd: input.cwd, branch: input.branch });
        return yield* publish;
      }),
    );
  });

  const push: GitButlerWorkspace["Service"]["push"] = Effect.fn("GitButlerWorkspace.push")(
    function* (input) {
      yield* publishing(
        input,
        runBut(input.cwd, ["push", input.branch, "--json"]).pipe(
          Effect.ensuring(invalidate(input.cwd)),
        ),
      );
      return { status: "pushed", branch: input.branch };
    },
  );

  const publishOutsideWorkspace = Effect.fn("GitButlerWorkspace.publishOutsideWorkspace")(
    function* <A, E, R>(
      input: { readonly cwd: string; readonly branch: string; readonly holdApproval?: string },
      publish: Effect.Effect<A, E, R>,
    ) {
      return yield* withPublicationLock(
        input.cwd,
        Effect.gen(function* () {
          const holds = yield* readHoldsForPublish(input.cwd);
          const blocking = yield* Effect.forEach(holds, (hold) =>
            (hold.state === "unverified"
              ? runGit(input.cwd, ["merge-base", "--is-ancestor", hold.sha, "HEAD"]).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                )
              : Effect.succeed(false)
            ).pipe(
              Effect.map((found) => ({
                hold,
                view: {
                  branch: hold.branch,
                  state: hold.state,
                  commitSha: hold.state === "unverified" ? hold.sha : null,
                  found,
                },
              })),
            ),
          );
          yield* settleHolds(input, blocking, ["HEAD"]);
          return yield* publish;
        }),
      );
    },
  );

  // Not under the lock, so a long push doesn't hold up seeing what's held. Resolving checks again.
  const readHolds: GitButlerWorkspace["Service"]["readHolds"] = Effect.fn(
    "GitButlerWorkspace.readHolds",
  )(function* (cwd) {
    const reviewed = yield* reviewHolds(cwd, yield* readHoldsForPublish(cwd));
    return { holds: reviewed.map(({ held }) => held) };
  });

  const resolveHolds: GitButlerWorkspace["Service"]["resolveHolds"] = Effect.fn(
    "GitButlerWorkspace.resolveHolds",
  )(function* ({ cwd, resolutions }) {
    yield* withPublicationLock(
      cwd,
      Effect.gen(function* () {
        const wanted = new Set(resolutions);
        const reviewed = yield* reviewHolds(cwd, yield* readHoldsForPublish(cwd));
        const chosen = reviewed.filter(
          ({ held }) => held.resolution !== undefined && wanted.has(held.resolution),
        );
        if (chosen.length !== wanted.size) {
          return yield* new GitCommandError({
            operation: "GitButlerWorkspace.resolveHolds",
            cwd,
            command: "git for-each-ref",
            detail: "What you reviewed has changed, so no hold was ended. Review them again.",
          });
        }
        yield* deleteHolds(
          cwd,
          chosen.map(({ hold }) => hold),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "GitButlerWorkspace.resolveHolds",
                cwd,
                command: "git update-ref",
                detail: "T3 Code could not end these holds, so all of them remain.",
                cause,
              }),
          ),
        );
      }),
    ).pipe(Effect.ensuring(invalidate(cwd)));
  });

  const createPullRequest: GitButlerWorkspace["Service"]["createPullRequest"] = Effect.fn(
    "GitButlerWorkspace.createPullRequest",
  )(function* (input) {
    // `but pr new` pushes ancestors and records their bases and GitButler's stack metadata.
    const result = yield* publishing(
      input,
      runBut(input.cwd, [
        "pr",
        "new",
        input.branch,
        "--default",
        "--json",
        ...(input.draft ? ["--draft"] : []),
      ]).pipe(Effect.ensuring(invalidate(input.cwd))),
    );
    const decoded = yield* decodePrOutput(result.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.createPullRequest", input.cwd, "but pr new", cause),
      ),
    );
    const created = decoded.published.find((review) => review.sourceBranch === input.branch);
    const review =
      created ?? decoded.alreadyExisting.find((review) => review.sourceBranch === input.branch);
    if (!review)
      return yield* decodeError(
        "GitButlerWorkspace.createPullRequest",
        input.cwd,
        "but pr new",
        undefined,
      );
    return {
      status: created ? "created" : "opened_existing",
      url: review.htmlUrl,
      number: review.number,
      baseBranch: review.targetBranch,
      headBranch: review.sourceBranch,
      title: review.title,
    };
  });

  const pull: GitButlerWorkspace["Service"]["pull"] = Effect.fn("GitButlerWorkspace.pull")(
    function* (cwd) {
      const result = yield* runBut(cwd, ["pull", "--json"]).pipe(Effect.ensuring(invalidate(cwd)));
      const decoded = yield* decodePullOutput(result.stdout).pipe(
        Effect.mapError((cause) => decodeError("GitButlerWorkspace.pull", cwd, "but pull", cause)),
      );
      if (
        decoded.status === "completed_with_conflicts" ||
        decoded.conflicts.length > 0 ||
        decoded.summary.branchesConflicted > 0
      ) {
        return yield* new GitCommandError({
          operation: "GitButlerWorkspace.pull",
          cwd,
          command: "but pull",
          detail:
            "GitButler pulled the target branch but left conflicted commits. Resolve them in GitButler before continuing.",
        });
      }
      if (decoded.status !== "up_to_date" && decoded.status !== "completed")
        return yield* decodeError("GitButlerWorkspace.pull", cwd, "but pull", undefined);
      return {
        status: decoded.status === "up_to_date" ? "skipped_up_to_date" : "pulled",
        refName: "GitButler workspace",
        upstreamRef: null,
      };
    },
  );

  const isDirty = (status: typeof StatusOutput.Type) =>
    status.uncommittedChanges.length > 0 ||
    (status.conflictedFiles?.length ?? 0) > 0 ||
    status.stacks.some((stack) => stack.assignedChanges.length > 0) ||
    (status.worktrees?.some((worktree) => worktree.uncommittedChanges.length > 0) ?? false);
  const autoPull: GitButlerWorkspace["Service"]["autoPull"] = Effect.fn(
    "GitButlerWorkspace.autoPull",
  )(function* (cwd) {
    const skip = (reason: string) =>
      Effect.logDebug("Skipped automatic GitButler pull", { reason }).pipe(Effect.as(null));
    if (isDirty(yield* readActionStatus(cwd))) return yield* skip("working-tree-changes");
    const result = yield* runBut(cwd, ["pull", "--check", "--json"]);
    const check = yield* decodePullCheck(result.stdout).pipe(
      Effect.mapError((cause) =>
        decodeError("GitButlerWorkspace.autoPull", cwd, "but pull --check", cause),
      ),
    );
    if (
      check.hasWorktreeConflicts ||
      check.branchStatuses.some(
        (branch) => !["updatable", "integrated", "empty", "unchanged"].includes(branch.status),
      )
    )
      return yield* skip("conflicting-or-unknown-update");
    if (check.upToDate) return yield* skip("up-to-date");
    if (isDirty(yield* readActionStatus(cwd))) return yield* skip("working-tree-changes");
    return yield* pull(cwd);
  });

  return GitButlerWorkspace.of({
    readStatus,
    readBranchDiff,
    invalidate,
    apply,
    unapply,
    createBranch,
    readCommitChanges,
    prepareCommit,
    readCommitContext,
    commit,
    readPublishedBranches,
    branchHasRevision,
    push,
    createPullRequest,
    publishOutsideWorkspace,
    readHolds,
    resolveHolds,
    pull,
    autoPull,
  });
});

export const layer = Layer.effect(GitButlerWorkspace, make);
