import type { ThreadFocusedHookPayload } from "@t3tools/contracts";

import { resolvePrimaryEnvironmentHttpUrl } from "./environments/primary";

export async function reportThreadFocusedHook(payload: ThreadFocusedHookPayload): Promise<void> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/hooks/report"), {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "thread.focused",
      payload,
    }),
  });

  if (response.ok) {
    return;
  }

  const message = (await response.text()) || `Failed to report hook event (${response.status}).`;
  throw new Error(message);
}
