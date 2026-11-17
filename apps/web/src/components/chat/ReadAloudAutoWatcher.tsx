import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type RunId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { prepareSpeechText, clampResponse } from "~/lib/readAloud";
import { completedRunResponse } from "~/lib/readAloudMessages";
import { useAutoReadAloudThreads } from "~/readAloudAutoStore";
import { useThreadProjection, useThreadShell } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";

// Thread detail can trail the shell's completion; past this, preparing is not worth the subscription.
const DETAIL_WAIT_MS = 15_000;

/**
 * Auto-read threads the user is not viewing get their finished response
 * rewritten for speech ahead of time, so playing it on return starts quickly.
 * Only the viewed thread's composer plays audio.
 */
export function ReadAloudAutoWatcher({
  activeThreadRef,
}: {
  activeThreadRef: ScopedThreadRef | null;
}) {
  const enabled = useClientSettings((settings) => settings.readAloudEnabled);
  const threads = useAutoReadAloudThreads();
  if (!enabled) return null;
  const activeKey = activeThreadRef === null ? null : scopedThreadKey(activeThreadRef);
  return Array.from(threads, ([key, ref]) =>
    key === activeKey ? null : <BackgroundThread key={key} threadRef={ref} />,
  );
}

function BackgroundThread({ threadRef }: { threadRef: ScopedThreadRef }) {
  const shell = useThreadShell(threadRef);
  const canSpeak = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const completedRunId = shell?.latestRun?.status === "completed" ? shell.latestRun.runId : null;
  // Starts at the run already finished when the thread was left, which was read or skipped there.
  const [handledRunId, setHandledRunId] = useState(completedRunId);
  // Stable so the wait timer below is not restarted by every shell update.
  const markHandled = useStableCallback(() => setHandledRunId(completedRunId));
  if (!canSpeak || completedRunId === null || completedRunId === handledRunId) return null;
  return (
    <PrepareRun
      key={completedRunId}
      threadRef={threadRef}
      runId={completedRunId}
      onDone={markHandled}
    />
  );
}

function PrepareRun({
  threadRef,
  runId,
  onDone,
}: {
  threadRef: ScopedThreadRef;
  runId: RunId;
  onDone: () => void;
}) {
  const thread = useThreadProjection(threadRef);
  const response = thread === null ? null : completedRunResponse(thread.projection, runId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- gives up waiting for the run detail after a timer, cleared on unmount
  useEffect(() => {
    const timer = setTimeout(onDone, DETAIL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prefetches speech audio on the environment once the completed response arrives
  useEffect(() => {
    if (response === null) return;
    onDone();
    void prepareSpeechText(threadRef.environmentId, clampResponse(response).text).catch(() => {
      // Preparing is an optimization; playing later reports any real failure.
    });
  }, [response, onDone, threadRef.environmentId]);

  return null;
}
