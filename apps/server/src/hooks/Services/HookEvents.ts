import type { HookClientEvent, HookEvent, HookEventSource } from "@t3tools/contracts";
import { Context, Effect, Layer, Queue, Ref, Stream } from "effect";

const HOOK_HISTORY_LIMIT = 256;
export const HOOK_STREAM_SUBSCRIBER_BUFFER_SIZE = 64;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<HookEvent>;
}

interface HookStreamSubscriber {
  readonly id: number;
  readonly publish: (event: HookEvent) => Effect.Effect<void>;
}

export interface HookEventsShape {
  readonly publish: (input: {
    readonly source: HookEventSource;
    readonly report: HookClientEvent;
  }) => Effect.Effect<HookEvent>;
  readonly snapshot: Effect.Effect<SnapshotState>;
  readonly stream: Stream.Stream<HookEvent>;
}

export class HookEvents extends Context.Service<HookEvents, HookEventsShape>()(
  "t3/hooks/Services/HookEvents",
) {}

export const HookEventsLive = Layer.effect(
  HookEvents,
  Effect.gen(function* () {
    const state = yield* Ref.make<SnapshotState>({
      sequence: 0,
      events: [],
    });
    const nextSubscriberId = yield* Ref.make(1);
    const subscribers = yield* Ref.make(new Map<number, HookStreamSubscriber>());

    const removeSubscriber = (subscriberId: number) =>
      Ref.update(subscribers, (current) => {
        if (!current.has(subscriberId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(subscriberId);
        return next;
      });

    return {
      publish: (input) =>
        Effect.gen(function* () {
          const occurredAt = new Date().toISOString();
          const event = yield* Ref.modify(state, (current) => {
            const nextSequence = current.sequence + 1;
            const event = {
              version: 1 as const,
              sequence: nextSequence,
              occurredAt,
              source: input.source,
              type: input.report.type,
              payload: input.report.payload,
            } satisfies HookEvent;
            const nextEvents = [...current.events, event].slice(-HOOK_HISTORY_LIMIT);
            return [event, { sequence: nextSequence, events: nextEvents }] as const;
          });
          const currentSubscribers = Array.from((yield* Ref.get(subscribers)).values());
          yield* Effect.forEach(currentSubscribers, (subscriber) => subscriber.publish(event), {
            concurrency: "unbounded",
            discard: true,
          });
          return event;
        }),
      snapshot: Ref.get(state),
      get stream() {
        return Stream.unwrap(
          Effect.acquireRelease(
            Effect.gen(function* () {
              const queue = yield* Queue.dropping<HookEvent>(HOOK_STREAM_SUBSCRIBER_BUFFER_SIZE);
              const subscriberId = yield* Ref.modify(nextSubscriberId, (current) => [
                current,
                current + 1,
              ]);
              const subscriber = {
                id: subscriberId,
                publish: (event: HookEvent) =>
                  Queue.offer(queue, event).pipe(
                    Effect.flatMap((accepted) =>
                      accepted
                        ? Effect.void
                        : removeSubscriber(subscriberId).pipe(
                            Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                          ),
                    ),
                  ),
              } satisfies HookStreamSubscriber;
              yield* Ref.update(subscribers, (current) => {
                const next = new Map(current);
                next.set(subscriberId, subscriber);
                return next;
              });
              return { queue, subscriberId };
            }),
            ({ queue, subscriberId }) =>
              removeSubscriber(subscriberId).pipe(
                Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
              ),
          ).pipe(Effect.map(({ queue }) => Stream.fromQueue(queue))),
        );
      },
    } satisfies HookEventsShape;
  }),
);
