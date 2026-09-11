import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistence from "effect/unstable/persistence/Persistence";

import * as SpeechCache from "./speechCache.ts";

const cacheLayer = SpeechCache.make.pipe(
  Effect.provide(Persistence.layerKvs.pipe(Layer.provideMerge(KeyValueStore.layerMemory))),
);

it.layer(NodeServices.layer)("speech cache", (it) => {
  it.effect("reuses polished text across calls", () =>
    Effect.gen(function* () {
      const cache = yield* cacheLayer;
      let calls = 0;
      const lookup = Effect.sync(() => {
        calls += 1;
        return "spoken words";
      });
      assert.strictEqual(yield* cache.polished("key", lookup), "spoken words");
      assert.strictEqual(yield* cache.polished("key", lookup), "spoken words");
      assert.strictEqual(calls, 1);
    }),
  );

  it.effect("does not reuse a null polish result", () =>
    Effect.gen(function* () {
      const cache = yield* cacheLayer;
      let calls = 0;
      const lookup = Effect.sync(() => {
        calls += 1;
        return null;
      });
      assert.strictEqual(yield* cache.polished("key", lookup), null);
      assert.strictEqual(yield* cache.polished("key", lookup), null);
      assert.strictEqual(calls, 2);
    }),
  );
});
