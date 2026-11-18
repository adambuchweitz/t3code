import type { AnyRouter } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { MessageCircleQuestionIcon } from "lucide-react";

import { getClientSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { totEntriesAtom } from "../../state/tots";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { totRequestsHeading } from "@t3tools/client-runtime/tots/logic";

/**
 * Says so when a Tot asks for something new, wherever the user is in the app. An open request
 * doesn't change the thread's status, so the thread notifications can't see it. A machine's first
 * list only seeds what's already known, so reconnecting doesn't replay old requests.
 */
export function startTotRequestNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const known = new Set<string>();
  const seenEnvironments = new Set<EnvironmentId>();

  const open = (environmentId: EnvironmentId, threadId: ThreadId) =>
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });

  const announce = (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly title: string;
    readonly body: string;
    readonly tag: string;
  }) => {
    const { environmentId, threadId, title, body, tag } = input;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    if (hasNotificationSound(mode)) {
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (focused) {
      const params = router.state.matches.at(-1)?.params as
        | { environmentId?: string; threadId?: string }
        | undefined;
      // Its own thread is already showing the request, pinned above the composer.
      if (
        !inAppNotificationsEnabled ||
        (params?.environmentId === environmentId && params?.threadId === threadId)
      ) {
        return;
      }
      const toastId = toastManager.add({
        type: "warning",
        title,
        description: body,
        data: {
          hideCopyButton: true,
          leadingIcon: (
            <MessageCircleQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
          ),
        },
        actionProps: {
          children: m(msg("Open", { $context: "verb, opens the Tot's thread" })),
          onClick: () => {
            toastManager.close(toastId);
            open(environmentId, threadId);
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    try {
      const notification = new Notification(title, { body, tag, silent: true });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        open(environmentId, threadId);
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  return registry.subscribe(
    totEntriesAtom,
    (entries) => {
      const arrived = new Set(entries.map((entry) => entry.environmentId));
      for (const entry of entries) {
        const first = !seenEnvironments.has(entry.environmentId);
        for (const request of entry.tot.requests) {
          const key = `${entry.environmentId}:${request.id}`;
          if (known.has(key)) continue;
          known.add(key);
          if (first) continue;
          announce({
            environmentId: entry.environmentId,
            threadId: entry.threadId,
            title: totRequestsHeading(entry.displayName, entry.tot.voice, m),
            body: request.question,
            tag: `tot-request:${key}`,
          });
        }
      }
      for (const environmentId of arrived) seenEnvironments.add(environmentId);
    },
    { immediate: true },
  );
}
