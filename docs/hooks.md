# Hooks

T3 Code can broadcast local UI and lifecycle activity as a hook stream.

The first hook is `thread.focused`, emitted when the active thread route changes in the web app.

## Transport

Hooks are exposed as Server-Sent Events:

```text
GET /api/hooks/local/stream
GET /api/hooks/stream
```

Use them like this:

- `/api/hooks/local/stream` is for local daemons on the same machine. It does not require auth, but it is only enabled when the server is bound to loopback.
- `/api/hooks/stream` is the authenticated variant for remote or headless clients.

Query params:

- `types=thread.focused,other.type` filters by hook type.
- `after=123` replays buffered events with `sequence > 123`.

The stream also honors `Last-Event-ID`, so reconnecting SSE clients can resume from the last seen `sequence`.

## Authentication

For local automation on the same machine, use the local stream:

```bash
curl -N http://127.0.0.1:3773/api/hooks/local/stream?types=thread.focused
```

That endpoint requires no token, but it is only available while T3 Code is loopback-only.

If you need to subscribe from a remote or headless client, use the authenticated stream and send a bearer token:

```text
Authorization: Bearer <token>
```

In a packaged install, that token can come from the T3 Code CLI. In a repo checkout, the equivalent command is:

```bash
node apps/server/dist/bin.mjs auth session issue --role client --label hooks-daemon --token-only
```

There is also a pairing flow through `/api/auth/bootstrap/bearer`, but local hooks automation should normally use `/api/hooks/local/stream`.

## Event Shape

Each SSE message looks like:

```text
id: 42
event: thread.focused
data: {"version":1,"sequence":42,"type":"thread.focused","occurredAt":"2026-04-20T16:23:41.592Z","source":{"sessionId":"session_123","role":"owner","sessionMethod":"browser-session-cookie"},"payload":{"environmentId":"env_123","threadId":"thread_123","projectId":"project_123","title":"Hooks experiment","branch":"feature/hooks","worktreePath":"/tmp/project/.worktrees/hooks"}}
```

Fields:

- `id` is the SSE event id and matches `sequence`.
- `event` is the hook type.
- `data` is the JSON payload.

Current hook types:

- `thread.focused`

## `curl`

This is the quickest way to inspect the stream by hand:

```bash
export T3_URL="http://127.0.0.1:3773"

curl -N \
  -H "Accept: text/event-stream" \
  "$T3_URL/api/hooks/local/stream?types=thread.focused"
```

Resume from the last seen event:

```bash
curl -N \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 42" \
  "$T3_URL/api/hooks/local/stream?types=thread.focused"
```

Authenticated remote variant:

```bash
export T3_TOKEN="$(node apps/server/dist/bin.mjs auth session issue --role client --label hooks-daemon --token-only)"

curl -N \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $T3_TOKEN" \
  "$T3_URL/api/hooks/stream?types=thread.focused"
```

## Node

This example uses the built-in `fetch` and a tiny SSE parser. Save it as `hooks-listener.mjs` and run it with `node hooks-listener.mjs`.

```js
const baseUrl = process.env.T3_URL ?? "http://127.0.0.1:3773";
const response = await fetch(`${baseUrl}/api/hooks/local/stream?types=thread.focused`, {
  headers: {
    Accept: "text/event-stream",
  },
});

if (!response.ok || !response.body) {
  throw new Error(`Hook stream failed: ${response.status}`);
}

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });

  while (true) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary === -1) {
      break;
    }

    const rawEvent = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);

    const fields = Object.create(null);
    for (const line of rawEvent.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      const separator = line.indexOf(":");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).trimStart();
      fields[key] = fields[key] ? `${fields[key]}\n${value}` : value;
    }

    if (!fields.data) {
      continue;
    }

    const event = JSON.parse(fields.data);
    if (event.type === "thread.focused") {
      console.log(`[${event.sequence}] ${event.payload.title} -> ${event.payload.threadId}`);
      console.log(`  branch=${event.payload.branch ?? "detached"}`);
      console.log(`  worktree=${event.payload.worktreePath ?? "none"}`);
    }
  }
}
```

## Elixir

This example uses `Mint` directly so the daemon can keep a long-lived HTTP connection open and parse SSE frames itself.

Add `:mint` to your dependencies, then run the module below.

```elixir
defmodule T3Hooks do
  @base_url System.get_env("T3_URL") || "http://127.0.0.1:3773"
  def run do
    uri = URI.parse(@base_url)
    scheme = String.to_atom(uri.scheme || "http")
    host = String.to_charlist(uri.host || "127.0.0.1")
    port = uri.port || default_port(scheme)
    path = "/api/hooks/local/stream?types=thread.focused"

    {:ok, conn} = Mint.HTTP.connect(scheme, host, port)

    headers = [
      {"accept", "text/event-stream"}
    ]

    {:ok, conn, request_ref} = Mint.HTTP.request(conn, "GET", path, headers, nil)
    loop(conn, request_ref, "")
  end

  defp loop(conn, request_ref, buffer) do
    receive do
      message ->
        {:ok, conn, responses} = Mint.HTTP.stream(conn, message)

        {conn, buffer} =
          Enum.reduce(responses, {conn, buffer}, fn
            {:status, ^request_ref, 200}, state ->
              state

            {:headers, ^request_ref, _headers}, state ->
              state

            {:data, ^request_ref, chunk}, {conn, buffer} ->
              next_buffer = parse_sse(buffer <> chunk)
              {conn, next_buffer}

            {:done, ^request_ref}, _state ->
              exit(:normal)

            _other, state ->
              state
          end)

        loop(conn, request_ref, buffer)
    end
  end

  defp parse_sse(buffer) do
    case String.split(buffer, "\n\n", parts: 2) do
      [raw_event, rest] ->
        fields =
          raw_event
          |> String.split("\n", trim: true)
          |> Enum.reject(&String.starts_with?(&1, ":"))
          |> Enum.reduce(%{}, fn line, acc ->
            case String.split(line, ":", parts: 2) do
              [key, value] -> Map.update(acc, key, String.trim_leading(value), &(&1 <> "\n" <> String.trim_leading(value)))
              [key] -> Map.put(acc, key, "")
            end
          end)

        if data = fields["data"] do
          {:ok, event} = Jason.decode(data)

          if event["type"] == "thread.focused" do
            payload = event["payload"]
            IO.puts("[#{event["sequence"]}] #{payload["title"]} -> #{payload["threadId"]}")
          end
        end

        parse_sse(rest)

      [incomplete] ->
        incomplete
    end
  end

  defp default_port(:https), do: 443
  defp default_port(_scheme), do: 80
end

T3Hooks.run()
```

`Jason` is only used to decode the `data:` JSON payload. If your daemon already uses another JSON library, swap it in. If you need the authenticated remote stream instead, add the normal `Authorization: Bearer ...` header and target `/api/hooks/stream`.

## Notes

- Delivery is at-least-once. Deduplicate with `sequence` if your daemon triggers side effects.
- Order is preserved within a single stream connection.
- The current replay buffer is in-memory and intended for short reconnect gaps, not durable history.
- `POST /api/hooks/report` exists for the T3 Code client to publish hook reports to the server.
- Most local integrations should consume `/api/hooks/local/stream`.
- Remote or headless integrations should consume the authenticated `/api/hooks/stream`.
