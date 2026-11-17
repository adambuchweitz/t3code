import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  SpeechUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ReadAloudHttp from "./http.ts";
import * as ReadAloud from "./ReadAloud.ts";

class SpeechTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.speech) {}

it.effect(
  "streams audio to operators, refuses read-only clients, and maps VoiceStudio errors",
  () =>
    Effect.gen(function* () {
      let scopes: ReadonlyArray<AuthEnvironmentScope> = ["orchestration:operate"];
      let voiceStudioUp = true;
      const routes = HttpApiBuilder.layer(SpeechTestApi).pipe(
        Layer.provide(ReadAloudHttp.layer),
        Layer.provide(
          Layer.mock(ReadAloud.ReadAloud)({
            audio: (input) =>
              voiceStudioUp
                ? Effect.succeed(Stream.make(new TextEncoder().encode(`audio:${input.text}`)))
                : Effect.fail(new SpeechUnavailableError({ providerStatus: 503 })),
          }),
        ),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("speech-test")),
          }),
        ),
        Layer.provide(
          Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
            Effect.suspend(() =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("test-session"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: new Set(scopes),
                }),
              ),
            ),
          ),
        ),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const speak = () =>
        Effect.promise(() =>
          handler(
            new Request("http://localhost/api/speech/audio", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: "Hello" }),
            }),
          ),
        );

      const ok = yield* speak();
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("audio/mpeg");
      expect(yield* Effect.promise(() => ok.text())).toBe("audio:Hello");

      voiceStudioUp = false;
      const rejected = yield* speak();
      expect(rejected.status).toBe(502);
      expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
        _tag: "SpeechUnavailableError",
        providerStatus: 503,
      });

      scopes = ["orchestration:read"];
      expect((yield* speak()).status).toBe(403);
    }),
);
