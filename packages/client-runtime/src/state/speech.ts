import type {
  SpeechAudioRequest,
  SpeechInputError,
  SpeechUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/http";
import type { Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createRuntimeCommand } from "./runtime.ts";

/**
 * Read-aloud requests to the environment that hosts the thread. Each runs
 * through the environment's own credentials, so relay and direct remote
 * connections work the same as the local one.
 *
 * @module clientRuntime/state/speech
 */

// The environment rewrites the response with a model before VoiceStudio answers,
// and VoiceStudio can take about 25 seconds to load on its first request.
const SPEECH_RESPONSE_TIMEOUT_MS = 120_000;
const VOICES_TIMEOUT_MS = 20_000;

// The shared request path reports undeclared failures as fetch errors; these
// carry the message the user needs, so they travel as values until it returns.
type SpeechFailure = SpeechInputError | SpeechUnavailableError;
const failed = (error: SpeechFailure): Effect.Effect<Result.Result<never, SpeechFailure>> =>
  Effect.succeed(Result.fail(error));
const speechErrorsAsValues = { SpeechInputError: failed, SpeechUnavailableError: failed };
const settleSpeech = <A>(result: Result.Result<A, SpeechFailure>) =>
  Result.isFailure(result) ? Effect.fail(result.failure) : Effect.succeed(result.success);

/**
 * Lets a caller outside Effect cancel a request: aborting interrupts it, which
 * aborts the fetch, so the environment sees the client leave and stops too.
 */
const interruptOnAbort = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: { readonly signal?: AbortSignal | undefined },
) => {
  const signal = input.signal;
  if (signal === undefined) return effect;
  // Checked up front so an already-cancelled read never starts a request.
  if (signal.aborted) return Effect.interrupt;
  const aborted = Effect.callback<never>((resume) => {
    const interrupt = () => resume(Effect.interrupt);
    signal.addEventListener("abort", interrupt, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", interrupt));
  });
  return Effect.raceFirst(effect, aborted);
};

const authorizationServices = Effect.all({
  signer: Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
  remoteAuthorization: Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  ),
});

export const fetchEnvironmentSpeechAudio = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSpeechAudio",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: SpeechAudioRequest;
  readonly signal?: AbortSignal;
}) {
  const result = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    ...(yield* authorizationServices),
    group: "speech",
    method: "POST",
    url: (urls) => urls.audio(),
    timeoutMs: SPEECH_RESPONSE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client
        .audio({ payload: input.request, headers })
        .pipe(Effect.map(Result.succeed), Effect.catchTags(speechErrorsAsValues)),
  });
  // The request resolved at headers; the body streams while it plays, and
  // cancelling the returned stream interrupts its read, which aborts the fetch.
  return Stream.toReadableStream(yield* settleSpeech(result));
}, interruptOnAbort);

export const fetchEnvironmentSpeechText = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSpeechText",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly text: string;
  readonly signal?: AbortSignal;
}) {
  const result = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    ...(yield* authorizationServices),
    group: "speech",
    method: "POST",
    url: (urls) => urls.text(),
    timeoutMs: SPEECH_RESPONSE_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client
        .text({ payload: { text: input.text }, headers })
        .pipe(Effect.map(Result.succeed), Effect.catchTags(speechErrorsAsValues)),
  });
  return (yield* settleSpeech(result)).speech;
}, interruptOnAbort);

const fetchEnvironmentSpeechVoices = Effect.fn("clientRuntime.state.fetchEnvironmentSpeechVoices")(
  function* (input: { readonly prepared: PreparedConnection; readonly signal?: AbortSignal }) {
    const result = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      ...(yield* authorizationServices),
      group: "speech",
      method: "GET",
      url: (urls) => urls.voices(),
      timeoutMs: VOICES_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client
          .voices({ headers })
          .pipe(Effect.map(Result.succeed), Effect.catchTags(speechErrorsAsValues)),
    });
    return yield* settleSpeech(result);
  },
  interruptOnAbort,
);

export function createEnvironmentSpeechCommands<R, E>(
  runtime: Atom.AtomRuntime<HttpClient.HttpClient | R, E>,
) {
  return {
    audio: createRuntimeCommand(runtime, {
      label: "environment.speech.audio",
      execute: fetchEnvironmentSpeechAudio,
    }),
    text: createRuntimeCommand(runtime, {
      label: "environment.speech.text",
      execute: fetchEnvironmentSpeechText,
    }),
    voices: createRuntimeCommand(runtime, {
      label: "environment.speech.voices",
      execute: fetchEnvironmentSpeechVoices,
    }),
  };
}
