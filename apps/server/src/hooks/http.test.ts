import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, type HttpClientResponse, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as HookEvents from "./HookEvents.ts";
import * as HooksHttp from "./http.ts";

const READER_TOKEN = "Bearer hooks-reader";

const layerAuth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request) =>
    request.headers.authorization === READER_TOKEN
      ? Effect.succeed({
          sessionId: AuthSessionId.make("hooks-reader"),
          subject: "hooks-reader",
          method: "bearer-access-token" as const,
          scopes: [AuthOrchestrationReadScope],
        })
      : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
});

const layerConfig = (host: string | undefined) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, host })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hooks-http-test-" })));

const startServer = (host?: string) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(HooksHttp.layer.pipe(Layer.provide(ServerHttp.layerHttpCompression)), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(HookEvents.layer),
        Layer.provide(layerAuth),
        Layer.provide(layerConfig(host)),
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    );
    return {
      client: Context.get(services, HttpClient.HttpClient),
      hooks: Context.get(services, HookEvents.HookEvents),
    };
  });

const focus = (threadId: string) => ({
  source: {
    sessionId: AuthSessionId.make("desktop"),
    sessionMethod: "browser-session-cookie" as const,
  },
  payload: {
    environmentId: EnvironmentId.make("environment-remote"),
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project-1"),
    title: "Hooks",
    branch: "feature/hooks",
    worktreePath: "/srv/project/.worktrees/hooks",
  },
});

/** Reads one SSE frame at a time, so a test can act between frames. */
const openFrames = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(
      response.stream.pipe(
        Stream.decodeText(),
        Stream.mapAccum(
          () => "",
          (buffer, text) => {
            const frames = (buffer + text).split("\n\n");
            const rest = frames.pop() ?? "";
            return [rest, frames] as const;
          },
        ),
      ),
    );
    const pending: Array<string> = [];
    return Effect.gen(function* () {
      while (true) {
        const frame = pending.shift();
        if (frame !== undefined) return frame;
        pending.push(...(yield* pull));
      }
    });
  });

const dataOf = (frame: string) =>
  JSON.parse(
    frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length) ?? "null",
  );

describe("hook streams", () => {
  it.effect("streams events to an authenticated subscriber without compressing them", () =>
    Effect.gen(function* () {
      const { client, hooks } = yield* startServer();
      const unauthenticated = yield* client.get(HooksHttp.HOOKS_STREAM_PATH);
      expect(unauthenticated.status).toBe(401);

      const response = yield* client.get(`${HooksHttp.HOOKS_STREAM_PATH}?types=thread.focused`, {
        headers: { authorization: READER_TOKEN, "accept-encoding": "gzip" },
      });
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
      expect(response.headers["content-encoding"]).toBeUndefined();

      const nextFrame = yield* openFrames(response);
      expect(yield* nextFrame).toBe(": connected");
      const published = yield* hooks.publishThreadFocused(focus("thread-live"));

      const frame = yield* nextFrame;
      expect(frame.split("\n").slice(0, 2)).toEqual([
        `id: ${published.cursor}`,
        "event: thread.focused",
      ]);
      expect(dataOf(frame)).toMatchObject({
        cursor: published.cursor,
        version: 1,
        sequence: 1,
        type: "thread.focused",
        source: { sessionId: "desktop", sessionMethod: "browser-session-cookie" },
        payload: focus("thread-live").payload,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("resumes after the Last-Event-ID a reconnecting client sends", () =>
    Effect.gen(function* () {
      const { client, hooks } = yield* startServer();
      const seen = yield* hooks.publishThreadFocused(focus("seen"));
      yield* hooks.publishThreadFocused(focus("missed"));

      const response = yield* client.get(HooksHttp.HOOKS_STREAM_PATH, {
        headers: { authorization: READER_TOKEN, "last-event-id": seen.cursor },
      });
      const nextFrame = yield* openFrames(response);
      expect(yield* nextFrame).toBe(": connected");
      expect(dataOf(yield* nextFrame)).toMatchObject({
        sequence: 2,
        payload: { threadId: "missed" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("prefers a reconnect's Last-Event-ID over the cursor in its URL", () =>
    Effect.gen(function* () {
      const { client, hooks } = yield* startServer();
      const first = yield* hooks.publishThreadFocused(focus("first"));
      const latestSeen = yield* hooks.publishThreadFocused(focus("seen"));
      yield* hooks.publishThreadFocused(focus("missed"));

      for (const query of [`?after=${first.cursor}`, "?after="]) {
        const response = yield* client.get(`${HooksHttp.HOOKS_STREAM_PATH}${query}`, {
          headers: { authorization: READER_TOKEN, "last-event-id": latestSeen.cursor },
        });
        const nextFrame = yield* openFrames(response);
        expect(yield* nextFrame).toBe(": connected");
        expect(dataOf(yield* nextFrame)).toMatchObject({ payload: { threadId: "missed" } });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects malformed cursors and unknown hook types", () =>
    Effect.gen(function* () {
      const { client } = yield* startServer();
      for (const query of ["?after=3", "?after=boot:-1", "?types=thread.focused,thread.closed"]) {
        const response = yield* client.get(`${HooksHttp.HOOKS_STREAM_PATH}${query}`, {
          headers: { authorization: READER_TOKEN },
        });
        expect(response.status).toBe(400);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("serves the local stream without a token to a direct loopback client", () =>
    Effect.gen(function* () {
      const { client, hooks } = yield* startServer();
      const response = yield* client.get(HooksHttp.HOOKS_LOCAL_STREAM_PATH);
      expect(response.status).toBe(200);

      const nextFrame = yield* openFrames(response);
      expect(yield* nextFrame).toBe(": connected");
      yield* hooks.publishThreadFocused(focus("thread-local"));
      expect(dataOf(yield* nextFrame)).toMatchObject({ payload: { threadId: "thread-local" } });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { case: "server exposed beyond loopback", host: "0.0.0.0", headers: {} },
    {
      case: "request through T3 Connect",
      host: undefined,
      headers: { "cf-connecting-ip": "1.2.3.4" },
    },
    { case: "request through a proxy", host: undefined, headers: { "x-forwarded-for": "1.2.3.4" } },
    {
      case: "cross-site browser page",
      host: undefined,
      headers: { origin: "https://example.com" },
    },
  ])("refuses the local stream for a $case", ({ host, headers }) =>
    Effect.gen(function* () {
      const { client } = yield* startServer(host);
      const response = yield* client.get(HooksHttp.HOOKS_LOCAL_STREAM_PATH, { headers });
      expect(response.status).toBe(403);
    }).pipe(Effect.scoped),
  );
});
