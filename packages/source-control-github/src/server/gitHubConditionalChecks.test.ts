import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { makeChecksRevalidator } from "./gitHubConditionalChecks.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const reference = { cwd: "/repo", repository: "acme/web", host: "github.com", number: 1 };
const credential = {
  host: "github.com",
  token: Redacted.make("token"),
  credentialFingerprint: "one",
};
it.effect.each(["/pulls/1", "/check-runs", "/status", "/actions/runs"])(
  "falls back to the full read for a PAT 403 on %s and keeps REST probes enabled",
  (endpoint) =>
    Effect.gen(function* () {
      const sha = "a".repeat(40);
      let reads = 0;
      let refusals = 0;
      let invalidations = 0;
      const revalidate = yield* makeChecksRevalidator.pipe(
        Effect.provide(
          GitHubRest.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(GitHubCredentials.GitHubCredentials, {
                  get: (host) =>
                    Effect.succeed({
                      host,
                      token: credential.token,
                      fingerprint: credential.credentialFingerprint,
                      source: "gh" as const,
                    }),
                  saved: () => Effect.succeedNone,
                  fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
                  invalidate: () =>
                    Effect.sync(() => {
                      invalidations++;
                    }),
                }),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) =>
                    Effect.sync(() => {
                      const refused = request.url.includes(endpoint);
                      if (refused) refusals++;
                      const body = refused
                        ? { message: "Resource not accessible by personal access token" }
                        : request.url.endsWith("/pulls/1")
                          ? { head: { sha, repo: { id: 2 } }, base: { repo: { id: 1 } } }
                          : {};
                      return HttpClientResponse.fromWeb(
                        request,
                        new Response(encodeJson(body), {
                          status: refused ? 403 : 200,
                          headers: { "content-type": "application/json" },
                        }),
                      );
                    }),
                  ),
                ),
                Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
                  enabled: false,
                  token: () => Effect.succeedNone,
                  invalidate: () => Effect.void,
                }),
                GitHubQuota.layer,
                SourceControlRateLimit.layer,
              ),
            ),
          ),
        ),
      );
      const checks = [
        { name: "GraphQL build", status: "success" as const, description: null, url: null },
      ];
      const read = Effect.sync(() => {
        reads++;
        return { state: "open" as const, checks, headSha: sha };
      });
      for (let tick = 0; tick < 2; tick++) {
        expect(
          yield* revalidate(reference, read).pipe(
            Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, credential),
          ),
        ).toMatchObject({ state: "open", checks });
      }
      expect(reads).toBe(2);
      expect(refusals).toBe(2);
      expect(invalidations).toBe(0);
    }),
);
