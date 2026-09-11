import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistable from "effect/unstable/persistence/Persistable";
import * as PersistedCache from "effect/unstable/persistence/PersistedCache";
import * as Persistence from "effect/unstable/persistence/Persistence";

import { ServerConfig } from "./config.ts";

/**
 * Caches reformatted speech text so repeat reads skip the model that does the
 * reformatting. The text is tiny and expensive to regenerate, so it is
 * persisted with a week-long TTL. Audio is never cached: streaming makes
 * replaying it cheap enough that megabytes on disk are not worth it.
 *
 * The persisted store is swept automatically by the `Persistence` layer, so
 * expired entries do not accumulate.
 *
 * @module server/speechCache
 */

const POLISHED_TEXT_TTL = Duration.days(7);
const POLISHED_IN_MEMORY_TTL = Duration.minutes(5);
const POLISHED_IN_MEMORY_CAPACITY = 128;

class PolishedSpeechRequest extends Persistable.Class<{
  payload: { key: string; lookup: Effect.Effect<{ readonly speech: string | null }> };
}>()("PolishedSpeech", {
  primaryKey: ({ key }) => key,
  success: Schema.Struct({ speech: Schema.NullOr(Schema.String) }),
}) {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof PolishedSpeechRequest && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

const isReusablePolishedSpeech = (
  exit: Exit.Exit<{ readonly speech: string | null }>,
): boolean => Exit.isSuccess(exit) && exit.value.speech !== null;

export class SpeechCache extends Context.Service<
  SpeechCache,
  {
    /** Returns cached polished prose, or runs the lookup and persists the result. */
    readonly polished: (
      key: string,
      lookup: Effect.Effect<string | null>,
    ) => Effect.Effect<string | null>;
  }
>()("t3/speechCache") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;

  const digest = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) => Encoding.encodeHex(bytes)),
      // A key is a key; fall back to the raw value if hashing is unavailable.
      Effect.orElseSucceed(() => value),
    );

  const polishedCache = yield* PersistedCache.make(
    (request: PolishedSpeechRequest) => request.lookup,
    {
      storeId: "speech-text-v1",
      timeToLive: (exit) => (isReusablePolishedSpeech(exit) ? POLISHED_TEXT_TTL : Duration.zero),
      inMemoryTTL: (exit) =>
        isReusablePolishedSpeech(exit) ? POLISHED_IN_MEMORY_TTL : Duration.zero,
      inMemoryCapacity: POLISHED_IN_MEMORY_CAPACITY,
    },
  );

  return SpeechCache.of({
    polished: Effect.fn("SpeechCache.polished")(function* (key, lookup) {
      const hashed = yield* digest(key);
      const cachedLookup = lookup.pipe(Effect.map((speech) => ({ speech })));
      const result = yield* polishedCache
        .get(new PolishedSpeechRequest({ key: hashed, lookup: cachedLookup }))
        .pipe(
          Effect.catchTags({
            PersistenceError: () => cachedLookup,
            SchemaError: () => cachedLookup,
          }),
        );
      return result.speech;
    }),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(SpeechCache, make).pipe(
      Layer.provide(Persistence.layerKvs),
      Layer.provide(
        KeyValueStore.layerFileSystem(path.join(config.providerStatusCacheDir, "speech-text")).pipe(
          Layer.catch(() =>
            Layer.effectDiscard(
              Effect.logWarning("Speech cache directory unavailable; using memory cache"),
            ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
