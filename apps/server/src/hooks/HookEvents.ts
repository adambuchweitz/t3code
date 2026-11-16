import type {
  HookEvent,
  HookEventSource,
  HookEventType,
  ThreadFocusedHookPayload,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** Covers short reconnect gaps; hooks are not durable history. */
const HOOK_HISTORY_LIMIT = 256;
export const HOOK_SUBSCRIBER_BUFFER_SIZE = 64;

export interface HookCursorPosition {
  readonly boot: string;
  readonly sequence: number;
}

/** Returns `null` for anything that is not a cursor this service issues. */
export const parseHookCursor = (raw: string): HookCursorPosition | null => {
  const match = /^([A-Za-z0-9-]+):(\d+)$/.exec(raw);
  if (match === null) return null;
  const sequence = Number(match[2]);
  return match[1] === undefined || !Number.isSafeInteger(sequence)
    ? null
    : { boot: match[1], sequence };
};

export interface HookSubscription {
  /**
   * Replays retained events after this position before live events. `null`, or a cursor from
   * another server run, replays everything retained.
   */
  readonly after: HookCursorPosition | null;
  /** `null` delivers every type. */
  readonly types: ReadonlySet<HookEventType> | null;
}

export class HookEvents extends Context.Service<
  HookEvents,
  {
    readonly publishThreadFocused: (input: {
      readonly source: HookEventSource;
      readonly payload: ThreadFocusedHookPayload;
    }) => Effect.Effect<HookEvent>;
    /**
     * Registers before returning, so anything published afterwards is delivered. The
     * registration lasts until the scope closes.
     */
    readonly subscribe: (
      subscription: HookSubscription,
    ) => Effect.Effect<Stream.Stream<HookEvent>, never, Scope.Scope>;
  }
>()("t3/hooks/HookEvents") {}

type SubscriberQueue = Queue.Queue<HookEvent, Cause.Done>;

const make = Effect.gen(function* () {
  const crypto = yield* SecureRandom.SecureRandom;
  // Short is enough: it only has to differ from the previous run's.
  const boot = (yield* crypto.uuidV4()).slice(0, 8);
  // Publishing and registering each happen in one synchronous step, so a subscriber either
  // receives an event live or finds it in the snapshot it replays, never both and never neither.
  let sequence = 0;
  let history: ReadonlyArray<HookEvent> = [];
  const subscribers = new Set<SubscriberQueue>();

  const publishThreadFocused = Effect.fn("HookEvents.publishThreadFocused")(function* (input: {
    readonly source: HookEventSource;
    readonly payload: ThreadFocusedHookPayload;
  }) {
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.sync(() => {
      sequence += 1;
      const event: HookEvent = {
        version: 1,
        cursor: `${boot}:${sequence}`,
        sequence,
        type: "thread.focused",
        occurredAt,
        source: input.source,
        payload: input.payload,
      };
      history = [...history, event].slice(-HOOK_HISTORY_LIMIT);
      for (const queue of subscribers) {
        if (Queue.offerUnsafe(queue, event)) continue;
        // A subscriber that fell a full buffer behind is ended rather than silently skipped.
        // It drains what it has, reconnects with its last id, and replays the gap.
        subscribers.delete(queue);
        Queue.endUnsafe(queue);
      }
      return event;
    });
  });

  const subscribe = Effect.fn("HookEvents.subscribe")(function* (subscription: HookSubscription) {
    const { queue, replay } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const queue: SubscriberQueue = yield* Queue.dropping<HookEvent, Cause.Done>(
          HOOK_SUBSCRIBER_BUFFER_SIZE,
        );
        return yield* Effect.sync(() => {
          subscribers.add(queue);
          const after = subscription.after?.boot === boot ? subscription.after.sequence : 0;
          return { queue, replay: history.filter((event) => event.sequence > after) };
        });
      }),
      ({ queue }) =>
        Effect.sync(() => {
          subscribers.delete(queue);
        }).pipe(Effect.andThen(Queue.shutdown(queue))),
    );
    return Stream.concat(Stream.fromIterable(replay), Stream.fromQueue(queue)).pipe(
      Stream.filter((event) => subscription.types === null || subscription.types.has(event.type)),
    );
  });

  return HookEvents.of({ publishThreadFocused, subscribe });
});

export const layer = Layer.effect(HookEvents, make);
