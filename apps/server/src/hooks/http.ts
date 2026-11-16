import { AuthOrchestrationReadScope, HookEventType, type HookEvent } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as ServerConfig from "../config.ts";
import { authenticateRawRouteWithScope, isLoopbackHostname } from "../http.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import * as HookEvents from "./HookEvents.ts";

export const HOOKS_STREAM_PATH = "/api/hooks/stream";
export const HOOKS_LOCAL_STREAM_PATH = "/api/hooks/local/stream";

// Tunnels and proxies, including T3 Connect and Tailscale Serve, reach a loopback-bound server
// from loopback, so the peer address alone does not prove the client is on this machine.
const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "tailscale-user-login",
] as const;

// Proxies and tunnels drop idle connections, and focus events can be minutes apart.
const HEARTBEAT_INTERVAL = Duration.seconds(25);

const badRequest = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 });

const parseSubscription = (
  url: URL,
  lastEventId: string | undefined,
): HookEvents.HookSubscription | string => {
  // EventSource reconnects to the same URL with a newer Last-Event-ID, so the header wins.
  const header = lastEventId?.trim() ?? "";
  const rawAfter = header.length > 0 ? header : (url.searchParams.get("after") ?? "").trim();
  const after = rawAfter.length === 0 ? null : HookEvents.parseHookCursor(rawAfter);
  if (after === null && rawAfter.length > 0) return "Invalid hook cursor.";

  const rawTypes = (url.searchParams.get("types") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (rawTypes.length === 0) return { after, types: null };
  const types = new Set<HookEventType>();
  for (const entry of rawTypes) {
    const type = HookEventType.literals.find((literal) => literal === entry);
    if (type === undefined) return `Unknown hook type: ${entry}.`;
    types.add(type);
  }
  return { after, types };
};

const encodeSseEvent = (event: HookEvent) =>
  `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const streamHookEvents = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return badRequest("Bad request.");
  const subscription = parseSubscription(url.value, request.headers["last-event-id"]);
  if (typeof subscription === "string") return badRequest(subscription);

  const hookEvents = yield* HookEvents.HookEvents;
  const body = Stream.unwrap(
    Effect.map(hookEvents.subscribe(subscription), (events) =>
      // The opening comment is sent once the subscription is registered, which also flushes
      // the headers before the first event.
      Stream.concat(
        Stream.succeed(": connected\n\n"),
        Stream.merge(
          Stream.map(events, encodeSseEvent),
          Stream.tick(HEARTBEAT_INTERVAL).pipe(
            Stream.drop(1),
            Stream.map(() => ": heartbeat\n\n"),
          ),
          // A subscriber ended for falling behind must close so the client reconnects.
          { haltStrategy: "left" },
        ),
      ),
    ),
  );
  return HttpServerResponse.stream(Stream.encodeText(body), {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: {
      // no-transform keeps the global compression middleware from buffering events.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

const isDirectLocalRequest = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!isLoopbackHost(config.host) || config.tailscaleServeEnabled) return false;
  if (!Option.exists(request.remoteAddress, isLoopbackAddress)) return false;
  // A browser page on another site sends Origin, and a rebinding attack names its own host.
  if (request.headers.origin !== undefined) return false;
  const hostname = hostnameOf(request.headers.host);
  if (hostname === null || !isLoopbackHostname(hostname)) return false;
  return PROXY_HEADERS.every((header) => request.headers[header] === undefined);
});

const hostnameOf = (host: string | undefined) => {
  if (host === undefined) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

const isLoopbackAddress = (address: string) =>
  isLoopbackHost(address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address);

const layerHooksStreamRoute = HttpRouter.add(
  "GET",
  HOOKS_STREAM_PATH,
  authenticateRawRouteWithScope(AuthOrchestrationReadScope).pipe(
    Effect.andThen(streamHookEvents),
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

const layerHooksLocalStreamRoute = HttpRouter.add(
  "GET",
  HOOKS_LOCAL_STREAM_PATH,
  Effect.gen(function* () {
    if (!(yield* isDirectLocalRequest)) {
      return HttpServerResponse.jsonUnsafe(
        {
          error:
            "The unauthenticated hooks stream only serves direct loopback requests to a loopback-only server. Use /api/hooks/stream with a token.",
        },
        { status: 403 },
      );
    }
    return yield* streamHookEvents;
  }),
);

export const layer = Layer.mergeAll(layerHooksStreamRoute, layerHooksLocalStreamRoute);
