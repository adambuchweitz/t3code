import { useEffect, useRef } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { OrchestrationMessage, ScopedThreadRef } from "@t3tools/contracts";

import { useClientSettings } from "~/hooks/useSettings";
import { prefetchReadAloudText } from "~/lib/readAloudPrefetch";
import { isReadAloudTargetSupported, type ReadAloudTarget } from "~/lib/readAloud";
import { useAutoReadAloudThreads } from "~/readAloudAutoStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShells } from "~/state/entities";
import { readPreparedConnection } from "~/state/session";
import { environmentThreadDetails } from "~/state/threads";

/**
 * Watches every thread's global completion signal and, for threads in auto
 * read-aloud mode that are not currently focused, prefetches the spoken version
 * so the first play is instant. The focused thread is handled by its composer,
 * which autoplays instead.
 *
 * Mounted once for the whole chat route.
 */

const MESSAGE_WAIT_TIMEOUT_MS = 15_000;

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = [];

/**
 * Loads one message's text by briefly mounting that thread's detail
 * subscription, then releases it. Subscribing is what triggers the load; the
 * unsubscribe keeps this from being a long-lived subscription.
 */
function loadThreadMessageText(
  ref: ScopedThreadRef,
  messageId: string,
  onText: (text: string) => void,
): void {
  const atom = environmentThreadDetails.messagesAtom(ref);
  let unsubscribe: (() => void) | null = null;
  let settled = false;

  const finish = (text: string | null) => {
    if (settled) return;
    settled = true;
    unsubscribe?.();
    clearTimeout(timer);
    if (text !== null) onText(text);
  };

  const check = (messages: ReadonlyArray<OrchestrationMessage>) => {
    const message = messages.find((entry) => entry.id === messageId);
    if (message && !message.streaming && message.text.trim().length > 0) {
      finish(message.text);
    }
  };

  const timer = setTimeout(() => finish(null), MESSAGE_WAIT_TIMEOUT_MS);
  unsubscribe = appAtomRegistry.subscribe(atom, check);
  check(appAtomRegistry.get(atom) ?? EMPTY_MESSAGES);
}

export function ReadAloudAutoWatcher({
  activeThreadRef,
}: {
  activeThreadRef: ScopedThreadRef | null;
}) {
  const shells = useThreadShells();
  const autoThreads = useAutoReadAloudThreads();
  const readAloudEnabled = useClientSettings((settings) => settings.readAloudEnabled);
  const handled = useRef(new Set<string>());
  const activeKey = activeThreadRef === null ? null : scopedThreadKey(activeThreadRef);

  useEffect(() => {
    if (!readAloudEnabled || autoThreads.size === 0) return;
    for (const shell of shells) {
      const ref: ScopedThreadRef = {
        environmentId: shell.environmentId,
        threadId: shell.id,
      };
      const key = scopedThreadKey(ref);
      if (!autoThreads.has(key)) continue;
      // The focused thread autoplays through its composer.
      if (key === activeKey) continue;
      const turn = shell.latestTurn;
      if (!turn || turn.state !== "completed" || turn.assistantMessageId === null) continue;

      const handleKey = `${key}:${turn.assistantMessageId}`;
      if (handled.current.has(handleKey)) continue;

      const connection = readPreparedConnection(ref.environmentId);
      if (!connection) continue;
      const target: ReadAloudTarget = {
        baseUrl: connection.httpBaseUrl,
        authorization: connection.httpAuthorization,
      };
      if (!isReadAloudTargetSupported(target)) continue;

      handled.current.add(handleKey);
      loadThreadMessageText(ref, turn.assistantMessageId, (text) => {
        void prefetchReadAloudText(text, target);
      });
    }
  }, [shells, autoThreads, activeKey, readAloudEnabled]);

  return null;
}
