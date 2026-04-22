import {
  HOOK_EVENT_TYPES,
  HookClientEvent,
  type HookEvent,
  type HookEventType as HookEventTypeValue,
} from "@t3tools/contracts";
import { Effect, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import { HookEvents } from "./Services/HookEvents.ts";

class HooksHttpError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HooksHttpError";
    this.status = status;
  }
}

const parseAfterSequence = (
  rawAfter: string | null,
  lastEventId: string | undefined,
): number | HooksHttpError => {
  const candidate = rawAfter ?? lastEventId ?? null;
  if (candidate === null || candidate.trim().length === 0) {
    return 0;
  }
  const parsed = Number.parseInt(candidate, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return new HooksHttpError("Invalid hook cursor.", 400);
  }
  return parsed;
};

const parseHookTypeFilter = (
  rawTypes: string | null,
): ReadonlySet<HookEventTypeValue> | null | HooksHttpError => {
  if (!rawTypes || rawTypes.trim().length === 0) {
    return null;
  }

  const parsed = rawTypes
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parsed.length === 0) {
    return null;
  }

  const next = new Set<HookEventTypeValue>();
  for (const entry of parsed) {
    if (!HOOK_EVENT_TYPES.includes(entry as (typeof HOOK_EVENT_TYPES)[number])) {
      return new HooksHttpError(`Unknown hook type: ${entry}.`, 400);
    }
    next.add(entry as HookEventTypeValue);
  }
  return next;
};

function matchesTypeFilter(
  event: HookEvent,
  types: ReadonlySet<HookEventTypeValue> | null,
): boolean {
  return types === null || types.has(event.type);
}

function encodeSseEvent(event: HookEvent): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  return yield* serverAuth.authenticateHttpRequest(request);
});

const respondToHooksError = (error: HooksHttpError) =>
  HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });

const buildHooksStreamResponse = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return respondToHooksError(new HooksHttpError("Bad request.", 400));
  }

  const types = parseHookTypeFilter(url.value.searchParams.get("types"));
  if (types instanceof HooksHttpError) {
    return respondToHooksError(types);
  }

  const after = parseAfterSequence(
    url.value.searchParams.get("after"),
    request.headers["last-event-id"],
  );
  if (after instanceof HooksHttpError) {
    return respondToHooksError(after);
  }

  const hookEvents = yield* HookEvents;
  const subscription = yield* hookEvents.subscribe;
  const snapshot = subscription.snapshot;
  const replayEvents = snapshot.events.filter(
    (event) => event.sequence > after && matchesTypeFilter(event, types),
  );
  const liveEvents = subscription.stream.pipe(
    Stream.filter((event) => event.sequence > snapshot.sequence && matchesTypeFilter(event, types)),
    Stream.map(encodeSseEvent),
  );
  const replayStream = Stream.fromIterable(replayEvents).pipe(Stream.map(encodeSseEvent));

  return HttpServerResponse.stream(Stream.encodeText(Stream.concat(replayStream, liveEvents)), {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export const hooksReportRouteLayer = HttpRouter.add(
  "POST",
  "/api/hooks/report",
  Effect.gen(function* () {
    const session = yield* requireAuthenticatedRequest;
    const hookEvents = yield* HookEvents;
    const report = yield* HttpServerRequest.schemaBodyJson(HookClientEvent).pipe(
      Effect.mapError(() => new HooksHttpError("Invalid hook report payload.", 400)),
    );

    yield* hookEvents.publish({
      source: {
        sessionId: session.sessionId,
        role: session.role,
        sessionMethod: session.method,
      },
      report,
    });

    return HttpServerResponse.empty({ status: 204 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchIf(
      (error): error is HooksHttpError => error instanceof HooksHttpError,
      (error) => Effect.succeed(respondToHooksError(error)),
    ),
  ),
);

export const hooksStreamRouteLayer = HttpRouter.add(
  "GET",
  "/api/hooks/stream",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    return yield* buildHooksStreamResponse;
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const requireLoopbackHooksHost = Effect.gen(function* () {
  const config = yield* ServerConfig;
  if (!isLoopbackHost(config.host)) {
    return yield* Effect.fail(
      new HooksHttpError(
        "Unauthenticated local hooks are only available when the server is bound to loopback.",
        403,
      ),
    );
  }
});

export const hooksLocalStreamRouteLayer = HttpRouter.add(
  "GET",
  "/api/hooks/local/stream",
  Effect.gen(function* () {
    yield* requireLoopbackHooksHost;
    return yield* buildHooksStreamResponse;
  }).pipe(
    Effect.catchIf(
      (error): error is HooksHttpError => error instanceof HooksHttpError,
      (error) => Effect.succeed(respondToHooksError(error)),
    ),
  ),
);
