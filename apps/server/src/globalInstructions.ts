import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CreateGlobalInstructionInput,
  GlobalInstruction,
  GlobalInstructionIssue,
  GlobalInstructionsConfigError,
  GlobalInstructionsState,
  SetGlobalInstructionEnabledInput,
} from "@t3tools/contracts";
import {
  Cache,
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  PubSub,
  Ref,
  Schema,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "./config.ts";

const PersistedGlobalInstruction = Schema.Struct({
  name: GlobalInstruction.fields.name,
  enabled: GlobalInstruction.fields.enabled,
  content: GlobalInstruction.fields.content,
});
type PersistedGlobalInstruction = typeof PersistedGlobalInstruction.Type;

export interface GlobalInstructionsShape {
  readonly start: Effect.Effect<void, GlobalInstructionsConfigError>;
  readonly ready: Effect.Effect<void, GlobalInstructionsConfigError>;
  readonly loadConfigState: Effect.Effect<GlobalInstructionsState, GlobalInstructionsConfigError>;
  readonly getSnapshot: Effect.Effect<GlobalInstructionsState, GlobalInstructionsConfigError>;
  readonly streamChanges: Stream.Stream<GlobalInstructionsState>;
  readonly createInstruction: (
    input: CreateGlobalInstructionInput,
  ) => Effect.Effect<GlobalInstructionsState, GlobalInstructionsConfigError>;
  readonly setInstructionEnabled: (
    input: SetGlobalInstructionEnabledInput,
  ) => Effect.Effect<GlobalInstructionsState, GlobalInstructionsConfigError>;
}

export class GlobalInstructions extends Context.Service<
  GlobalInstructions,
  GlobalInstructionsShape
>()("t3/globalInstructions") {
  static readonly layerTest = (state: Partial<GlobalInstructionsState> = {}) =>
    Layer.succeed(GlobalInstructions, {
      start: Effect.void,
      ready: Effect.void,
      loadConfigState: Effect.succeed({
        globalInstructions: state.globalInstructions ?? [],
        globalInstructionIssues: state.globalInstructionIssues ?? [],
      }),
      getSnapshot: Effect.succeed({
        globalInstructions: state.globalInstructions ?? [],
        globalInstructionIssues: state.globalInstructionIssues ?? [],
      }),
      streamChanges: Stream.empty,
      createInstruction: () =>
        Effect.succeed({
          globalInstructions: state.globalInstructions ?? [],
          globalInstructionIssues: state.globalInstructionIssues ?? [],
        }),
      setInstructionEnabled: () =>
        Effect.succeed({
          globalInstructions: state.globalInstructions ?? [],
          globalInstructionIssues: state.globalInstructionIssues ?? [],
        }),
    } satisfies GlobalInstructionsShape);
}

function toMalformedIssue(id: string, message: string): GlobalInstructionIssue {
  return {
    kind: "globalInstructions.malformed-config",
    id,
    message,
  };
}

function toInvalidIssue(id: string, message: string): GlobalInstructionIssue {
  return {
    kind: "globalInstructions.invalid-config",
    id,
    message,
  };
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid global instructions configuration.";
}

function slugifyInstructionName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "instruction";
}

function decodePersistedInstruction(input: unknown): PersistedGlobalInstruction {
  return Schema.decodeUnknownSync(PersistedGlobalInstruction)(input);
}

function parsePersistedInstruction(raw: string): PersistedGlobalInstruction {
  return decodePersistedInstruction(JSON.parse(raw) as unknown);
}

function resolveInstructionFilePath(instructionsDir: string, id: string): string {
  return path.join(instructionsDir, id);
}

export function composeGlobalInstructionContent(
  input: ReadonlyArray<Pick<GlobalInstruction, "enabled" | "content">>,
): string {
  return input
    .filter((instruction) => instruction.enabled)
    .map((instruction) => instruction.content)
    .join("\n\n");
}

const makeGlobalInstructions = Effect.gen(function* () {
  const { instructionsDir } = yield* ServerConfig;
  const changesPubSub = yield* PubSub.unbounded<GlobalInstructionsState>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, GlobalInstructionsConfigError>();
  const writeSemaphore = yield* Semaphore.make(1);
  const watcherRef = yield* Ref.make<FSWatcher | null>(null);
  const cacheKey = "globalInstructions" as const;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const toConfigError = (
    configPath: string,
    detail: string,
    cause?: unknown,
  ): GlobalInstructionsConfigError =>
    new GlobalInstructionsConfigError({
      configPath,
      detail,
      ...(cause !== undefined ? { cause } : {}),
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const watcher = yield* Ref.get(watcherRef);
      if (watcher) {
        watcher.close();
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }),
  );

  const emitChange = (state: GlobalInstructionsState) =>
    PubSub.publish(changesPubSub, state).pipe(Effect.asVoid);

  const ensureInstructionsDir = Effect.tryPromise({
    try: () => mkdir(instructionsDir, { recursive: true }),
    catch: (cause) =>
      toConfigError(instructionsDir, "failed to prepare instructions directory", cause),
  }).pipe(Effect.asVoid);

  const readDirectoryEntries = ensureInstructionsDir.pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => readdir(instructionsDir),
        catch: (cause) =>
          toConfigError(instructionsDir, "failed to read instructions directory", cause),
      }),
    ),
    Effect.catch(() => Effect.succeed([] as Array<string>)),
    Effect.map((entries) =>
      entries.filter((entry) => entry.toLowerCase().endsWith(".json")).toSorted(),
    ),
  );

  const parseInstructionFile = Effect.fn("GlobalInstructions.parseInstructionFile")(function* (
    id: string,
  ): Effect.fn.Return<
    {
      readonly instruction: GlobalInstruction | null;
      readonly issue: GlobalInstructionIssue | null;
    },
    never
  > {
    const filePath = resolveInstructionFilePath(instructionsDir, id);
    const rawExit = yield* Effect.exit(
      Effect.tryPromise({
        try: () => readFile(filePath, "utf8"),
        catch: (cause) => toConfigError(filePath, "failed to read instruction file", cause),
      }),
    );

    if (rawExit._tag === "Failure") {
      yield* Effect.logWarning("ignoring unreadable global instruction file", {
        path: filePath,
        id,
      });
      return {
        instruction: null,
        issue: toMalformedIssue(id, "Failed to read instruction file."),
      };
    }
    const raw = rawExit.value;

    const decodedExit = yield* Effect.exit(Effect.sync(() => parsePersistedInstruction(raw)));
    if (decodedExit._tag === "Success") {
      const decoded = decodedExit.value;
      return {
        instruction: {
          id,
          filePath,
          ...decoded,
        },
        issue: null,
      };
    } else {
      const error = Cause.squash(decodedExit.cause);
      const detail = trimIssueMessage(error instanceof Error ? error.message : String(error));
      const issue =
        error instanceof SyntaxError ? toMalformedIssue(id, detail) : toInvalidIssue(id, detail);
      yield* Effect.logWarning("ignoring invalid global instruction file", {
        path: filePath,
        id,
        error: detail,
      });
      return {
        instruction: null,
        issue,
      };
    }
  });

  const readInstructionFile = Effect.fn("GlobalInstructions.readInstructionFile")(function* (
    id: string,
  ): Effect.fn.Return<PersistedGlobalInstruction, GlobalInstructionsConfigError> {
    const filePath = path.join(instructionsDir, id);
    const raw = yield* Effect.tryPromise({
      try: () => readFile(filePath, "utf8"),
      catch: (cause) => toConfigError(filePath, "failed to read instruction file", cause),
    });

    return yield* Effect.try({
      try: () => parsePersistedInstruction(raw),
      catch: (error) =>
        toConfigError(
          filePath,
          `failed to decode instruction file: ${error instanceof Error ? error.message : String(error)}`,
          error,
        ),
    });
  });

  const writeInstructionFile = Effect.fn("GlobalInstructions.writeInstructionFile")(function* (
    id: string,
    instruction: PersistedGlobalInstruction,
  ): Effect.fn.Return<void, GlobalInstructionsConfigError> {
    const filePath = path.join(instructionsDir, id);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const encoded = `${JSON.stringify(instruction, null, 2)}\n`;

    yield* ensureInstructionsDir;
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(tempPath, encoded, "utf8");
        await rename(tempPath, filePath);
      },
      catch: (cause) => toConfigError(filePath, "failed to write instruction file", cause),
    }).pipe(
      Effect.ensuring(
        Effect.tryPromise({
          try: () => rm(tempPath, { force: true }),
          catch: (cause) =>
            toConfigError(tempPath, "failed to remove temporary instruction file", cause),
        }).pipe(Effect.asVoid, Effect.ignore({ log: true })),
      ),
    );
  });

  const loadStateFromDisk: Effect.Effect<GlobalInstructionsState, GlobalInstructionsConfigError> =
    Effect.gen(function* () {
      const ids = yield* readDirectoryEntries;
      const loaded = yield* Effect.forEach(ids, parseInstructionFile, { concurrency: 1 });

      return {
        globalInstructions: loaded
          .flatMap((entry) => (entry.instruction ? [entry.instruction] : []))
          .toSorted((left, right) => left.id.localeCompare(right.id)),
        globalInstructionIssues: loaded.flatMap((entry) => (entry.issue ? [entry.issue] : [])),
      };
    });

  const stateCache = yield* Cache.make<
    typeof cacheKey,
    GlobalInstructionsState,
    GlobalInstructionsConfigError
  >({
    capacity: 1,
    lookup: () => loadStateFromDisk,
  });

  const getState = Cache.get(stateCache, cacheKey);

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(stateCache, cacheKey);
      const state = yield* getState;
      yield* emitChange(state);
    }),
  );

  const resolveAvailableInstructionId = Effect.fn(
    "GlobalInstructions.resolveAvailableInstructionId",
  )(function* (name: string): Effect.fn.Return<string, GlobalInstructionsConfigError> {
    const entries = yield* readDirectoryEntries;
    const used = new Set(entries.map((entry) => entry.toLowerCase()));
    const base = slugifyInstructionName(name);
    let suffix = 1;
    for (;;) {
      const candidate = `${base}${suffix === 1 ? "" : `-${suffix}`}.json`;
      if (!used.has(candidate.toLowerCase())) {
        return candidate;
      }
      suffix += 1;
    }
  });

  const scheduleRevalidate = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runFork(revalidateAndEmit.pipe(Effect.ignore({ log: true })));
    }, 100);
  };

  const startWatcher = Effect.gen(function* () {
    yield* ensureInstructionsDir;
    const currentWatcher = yield* Ref.get(watcherRef);
    if (currentWatcher) {
      return;
    }

    const nextWatcher = watch(
      instructionsDir,
      (_eventType: string, fileName: string | Buffer | null) => {
        const relativePath = fileName?.toString() ?? "";
        if (relativePath.length === 0 || relativePath.toLowerCase().endsWith(".json")) {
          scheduleRevalidate();
        }
      },
    );
    yield* Ref.set(watcherRef, nextWatcher);
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(stateCache, cacheKey);
      yield* getState;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    loadConfigState: getState,
    getSnapshot: getState,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    createInstruction: (input) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const id = yield* resolveAvailableInstructionId(input.name);
          yield* writeInstructionFile(id, {
            name: input.name,
            enabled: true,
            content: input.content,
          });
          const next = yield* loadStateFromDisk;
          yield* Cache.set(stateCache, cacheKey, next);
          yield* emitChange(next);
          return next;
        }),
      ),
    setInstructionEnabled: (input) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readInstructionFile(input.id);
          yield* writeInstructionFile(input.id, {
            ...current,
            enabled: input.enabled,
          });
          const next = yield* loadStateFromDisk;
          yield* Cache.set(stateCache, cacheKey, next);
          yield* emitChange(next);
          return next;
        }),
      ),
  } satisfies GlobalInstructionsShape;
});

export const GlobalInstructionsLive = Layer.effect(GlobalInstructions, makeGlobalInstructions);
