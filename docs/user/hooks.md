# Thread focus hooks

T3 Code can tell other programs which thread you are looking at. A script can follow along to
switch your editor or terminal to the thread's worktree, update a status bar, or log your
work.

The desktop and web apps send a `thread.focused` event when you open a thread while the window
has focus, and when its branch or worktree changes. A change made while the window is in
the background is sent when you return to it. The mobile app does not send focus events.

## Which server receives focus

Events go to the server your app runs on: the desktop app's built-in server, or the server
behind `npx t3`. That includes threads on remote environments you have added, so a local script
hears about every thread you open. The event's `environmentId` names the environment that owns
the thread, and `branch` and `worktreePath` are paths on that environment's machine.

The hosted web app at app.t3.codes has no server of its own, so it sends focus to the
environment that owns the thread.

## Subscribe on the same machine

When the server only listens on this machine, a local program can subscribe without a token:

```sh
curl -N "http://127.0.0.1:3773/api/hooks/local/stream?types=thread.focused"
```

Use the port your server listens on. This stream refuses requests that arrive from another
machine or through a proxy or tunnel, including T3 Connect and Tailscale Serve, and requests
from web pages. Once the server listens on your network or uses Tailscale Serve, the local
stream is off and programs need a token.

## Subscribe with a token

Any program that can reach the environment can use the authenticated stream with a token that
has `orchestration:read`. Issue the token on the environment's machine:

```sh
TOKEN="$(npx t3 auth session issue --label focus-hooks --scope orchestration:read --token-only)"
curl -N -H "Authorization: Bearer $TOKEN" \
  "https://my-machine.example/api/hooks/stream?types=thread.focused"
```

## Events

Each event is a Server-Sent Event:

```text
id: 3f9c2a1b:42
event: thread.focused
data: {"version":1,"cursor":"3f9c2a1b:42","sequence":42,"type":"thread.focused","occurredAt":"2026-10-20T16:23:41.592Z","source":{"sessionId":"…","sessionMethod":"browser-session-cookie"},"payload":{"environmentId":"…","threadId":"…","projectId":"…","title":"Hooks experiment","branch":"feature/hooks","worktreePath":"/home/me/project/.worktrees/hooks"}}
```

`branch` and `worktreePath` are `null` when the thread has none. Lines starting with `:` are
comments: the stream sends one when it connects and another every 25 seconds so proxies keep it
open.

## Reconnecting

The server keeps the last 256 events in memory. Reconnect with the last `id` you received in a
`Last-Event-ID` header, or pass it as `?after=<id>`, to receive what you missed. `EventSource`
sends the header for you, and the header wins when both are present. Treat the id as opaque; it
matches the event's `cursor` field. A subscriber that falls far behind is disconnected so it can
resume this way.

After the server restarts, an id from before the restart replays every event the new server
still holds, so deduplicate with care if your program has side effects.
