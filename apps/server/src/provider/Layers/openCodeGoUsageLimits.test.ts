// @effect-diagnostics nodeBuiltinImport:off - the reader test seeds a fake
// opencode home on disk with real temp dirs, outside the Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  openCodeGoApiKeyFromAuthFile,
  openCodeGoUsageToLimits,
  readOpenCodeGoUsageLimits,
} from "./openCodeGoUsageLimits.ts";

const checkedAt = "2026-09-11T19:00:00.000Z";

describe("openCodeGoApiKeyFromAuthFile", () => {
  it("reads only the Go entry out of the shared auth file", () => {
    expect(
      openCodeGoApiKeyFromAuthFile({
        opencode: { type: "api", key: "sk-zen" },
        openai: { type: "oauth", refresh: "rt-123", access: "eyJhbGciOi" },
        "opencode-go": { type: "api", key: "sk-go" },
      }),
    ).toBe("sk-go");
  });

  it("returns null without a Go subscription or with an unusable file", () => {
    expect(openCodeGoApiKeyFromAuthFile({ openai: { type: "oauth" } })).toBe(null);
    expect(openCodeGoApiKeyFromAuthFile({ "opencode-go": { type: "api", key: "" } })).toBe(null);
    expect(openCodeGoApiKeyFromAuthFile(null)).toBe(null);
    expect(openCodeGoApiKeyFromAuthFile("not an object")).toBe(null);
  });
});

describe("openCodeGoUsageToLimits", () => {
  it("maps the rolling, weekly, and monthly windows with kinds and durations", () => {
    const limits = openCodeGoUsageToLimits({
      checkedAt,
      response: {
        usage: {
          rolling: { status: "ok", percent: 7, resetsAt: "2026-09-11T20:33:17.242Z" },
          weekly: { status: "ok", percent: 10, resetsAt: "2026-09-14T00:00:00.242Z" },
          monthly: { status: "ok", percent: 19, resetsAt: "2026-09-30T15:05:58.242Z" },
        },
      },
    });
    expect(limits).toEqual({
      checkedAt,
      windows: [
        {
          id: "go_rolling",
          kind: "session",
          label: "Session",
          usedPercent: 7,
          windowDurationMins: 300,
          resetsAt: "2026-09-11T20:33:17.242Z",
        },
        {
          id: "go_weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 10,
          windowDurationMins: 10_080,
          resetsAt: "2026-09-14T00:00:00.242Z",
        },
        {
          id: "go_monthly",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 19,
          windowDurationMins: 43_200,
          resetsAt: "2026-09-30T15:05:58.242Z",
        },
      ],
    });
  });

  it("skips windows without a reading and clamps the rest", () => {
    const limits = openCodeGoUsageToLimits({
      checkedAt,
      response: {
        usage: {
          rolling: { status: "ok", percent: null, resetsAt: null },
          weekly: { status: "ok", percent: 150, resetsAt: "not a date" },
        },
      },
    });
    expect(limits.windows).toEqual([
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10_080,
      },
    ]);
  });
});

/** A throwaway opencode data dir, with a Go key in auth.json when given. */
const goHome = Effect.fn("goHome")(function* (goKey: string | null) {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "opencode-go-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  if (goKey !== null) {
    const dataDir = NodePath.join(home, ".local", "share", "opencode");
    yield* Effect.promise(() => NodeFSP.mkdir(dataDir, { recursive: true }));
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(dataDir, "auth.json"),
        `{"opencode-go":{"type":"api","key":"${goKey}"}}`,
      ),
    );
  }
  return home;
});

describe("readOpenCodeGoUsageLimits", () => {
  effectIt.effect("reads quota with the Go key from a fake opencode home", () =>
    Effect.gen(function* () {
      const home = yield* goHome("sk-test-go");
      const seen: Array<string> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push(request.headers.authorization ?? "");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              usage: {
                rolling: { status: "ok", percent: 7, resetsAt: "2026-09-11T20:33:17.242Z" },
                weekly: { status: "ok", percent: 10, resetsAt: "2026-09-14T00:00:00.242Z" },
                monthly: { status: "ok", percent: 19, resetsAt: "2026-09-30T15:05:58.242Z" },
              },
            }),
          );
        }),
      );
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeServices.layer),
      );
      expect(seen).toEqual(["Bearer sk-test-go"]);
      expect(limits?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["go_rolling", 7],
        ["go_weekly", 10],
        ["go_monthly", 19],
      ]);
    }),
  );

  effectIt.effect("reports a rejected key without clearing the last snapshot", () =>
    Effect.gen(function* () {
      const home = yield* goHome("sk-stale");
      const http = HttpClient.make((request) =>
        Effect.sync(() => HttpClientResponse.fromWeb(request, new Response(null, { status: 401 }))),
      );
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeServices.layer),
      );
      expect(limits?.unavailable).toMatchObject({ reason: "probeFailed" });
      expect(limits?.unavailable?.message).toContain("rejected its API key");
    }),
  );

  effectIt.effect("leaves limits alone without a Go subscription", () =>
    Effect.gen(function* () {
      const home = yield* goHome(null);
      const limits = yield* readOpenCodeGoUsageLimits({
        environment: { HOME: home },
        checkedAt,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("HttpClient must not be called without a key")),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      expect(limits).toBe(undefined);
    }),
  );
});
