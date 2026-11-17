import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ReadAloud from "./ReadAloud.ts";

// Speech spends this server's model and VoiceStudio time, so it needs operate, not read.
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "speech",
  Effect.fnUntraced(function* (handlers) {
    const readAloud = yield* ReadAloud.ReadAloud;
    return handlers
      .handle(
        "audio",
        Effect.fn("environment.speech.audio")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* readAloud.audio(args.payload).pipe(traceLocalHandlerWork);
        }),
      )
      .handle(
        "text",
        Effect.fn("environment.speech.text")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const speech = yield* readAloud.speechText(args.payload.text).pipe(traceLocalHandlerWork);
          return { speech };
        }),
      )
      .handle(
        "voices",
        Effect.fn("environment.speech.voices")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* readAloud.voices.pipe(traceLocalHandlerWork);
        }),
      );
  }),
);
