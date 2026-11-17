import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_OPTIONS, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import { fetchEnvironmentSpeechAudio, fetchEnvironmentSpeechText } from "./speech.ts";

const TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://previous.example.test",
  socketUrl: "wss://previous.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 },
  target: TARGET,
};

/** A relay environment whose first credential is rejected, as after a token expires. */
function relayEnvironment(
  reply: (requestNumber: number, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length, init ?? {});
  };
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)),
      Effect.provideService(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
          renewDpopBeforeExpiry: () => Effect.die("unexpected credential renewal"),
          rememberCheckedDescriptor: () => Effect.void,
          authorizeBearer: () => Effect.die("unexpected bearer connection"),
          authorizeDpop: () => Effect.die("unexpected WebSocket connection"),
          authorizeDirectDpop: () => Effect.die("unexpected direct WebSocket connection"),
          authorizeDirectDpopHttp: () => Effect.die("unexpected direct DPoP authorization"),
          authorizeDpopHttp: (input) =>
            Effect.succeed({
              environmentId: TARGET.environmentId,
              label: TARGET.label,
              httpBaseUrl: "https://current.example.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: input.rejectedAccessToken ? "renewed-token" : "current-token",
                expiresAtEpochMs: 3_600_000,
              },
            }),
        }),
      ),
      Effect.provideService(
        ManagedRelay.ManagedRelayDpopSigner,
        ManagedRelay.ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("test-thumbprint"),
          createProof: () => Effect.succeed("proof"),
        }),
      ),
    );
  return { calls, provide };
}

const credentialRejected = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-rejected",
    },
    { status: 401 },
  );

describe("environment speech requests", () => {
  it.effect("renews a rejected relay credential and streams the audio body", () => {
    const relay = relayEnvironment((requestNumber) =>
      requestNumber === 1
        ? credentialRejected()
        : new Response(new Uint8Array([73, 68, 51]), { headers: { "content-type": "audio/mpeg" } }),
    );
    return Effect.gen(function* () {
      const body = yield* fetchEnvironmentSpeechAudio({
        prepared: PREPARED,
        request: {
          text: "Hello",
          voice: "demo0001",
          options: DEFAULT_SPEECH_OPTIONS,
          verbatim: true,
        },
      });
      const bytes = yield* Effect.promise(() => new Response(body).arrayBuffer());
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array([73, 68, 51]));
      expect(
        relay.calls.map((call) => new Headers(call.init.headers).get("authorization")),
      ).toEqual(["DPoP current-token", "DPoP renewed-token"]);
      expect(relay.calls[1]?.url).toBe("https://current.example.test/api/speech/audio");
    }).pipe(relay.provide);
  });

  it.effect("keeps VoiceStudio's failure message instead of a generic fetch error", () => {
    const relay = relayEnvironment(() =>
      Response.json({ _tag: "SpeechUnavailableError", providerStatus: 503 }, { status: 502 }),
    );
    return Effect.gen(function* () {
      const error = yield* fetchEnvironmentSpeechText({ prepared: PREPARED, text: "Hello" }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("SpeechUnavailableError");
      expect(error.message).toBe("VoiceStudio rejected the request (status 503).");
    }).pipe(relay.provide);
  });

  it.effect("aborting a pending request aborts its fetch and settles as an interruption", () => {
    const fetched = Promise.withResolvers<void>();
    // Rejects on abort exactly like a real fetch, so nothing resolves unless the abort arrives.
    const relay = relayEnvironment((_requestNumber, init) => {
      fetched.resolve();
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
      );
    });
    return Effect.gen(function* () {
      const controller = new AbortController();
      const pending = yield* fetchEnvironmentSpeechText({
        prepared: PREPARED,
        text: "Hello",
        signal: controller.signal,
      }).pipe(relay.provide, Effect.forkChild);
      yield* Effect.promise(() => fetched.promise);

      controller.abort();
      const exit = yield* Fiber.await(pending);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(relay.calls).toHaveLength(1);
      expect(relay.calls[0]?.init.signal?.aborted).toBe(true);
    });
  });

  it.effect("sends nothing when the caller already cancelled", () => {
    const relay = relayEnvironment(() => new Response("audio"));
    return Effect.gen(function* () {
      const controller = new AbortController();
      controller.abort();
      const exit = yield* fetchEnvironmentSpeechAudio({
        prepared: PREPARED,
        request: { text: "Hello", voice: "alloy", options: DEFAULT_SPEECH_OPTIONS, verbatim: true },
        signal: controller.signal,
      }).pipe(relay.provide, Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(relay.calls).toHaveLength(0);
    });
  });

  it.effect("cancelling the audio body aborts the streaming fetch", () => {
    // A body that never produces audio, like VoiceStudio mid-synthesis.
    const relay = relayEnvironment(
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
          headers: { "content-type": "audio/mpeg" },
        }),
    );
    return Effect.gen(function* () {
      const body = yield* fetchEnvironmentSpeechAudio({
        prepared: PREPARED,
        request: { text: "Hello", voice: "alloy", options: DEFAULT_SPEECH_OPTIONS, verbatim: true },
      }).pipe(relay.provide);
      const reader = body.getReader();
      const read = reader.read();
      yield* Effect.promise(() => reader.cancel());
      yield* Effect.promise(() => read);
      expect(relay.calls[0]?.init.signal?.aborted).toBe(true);
    });
  });
});
