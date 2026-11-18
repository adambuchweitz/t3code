import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { SquareIcon, Volume2Icon, WavesIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useRef } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useReadAloudMessages } from "~/hooks/useReadAloudMessages";
import { useSpeechPlayback } from "~/hooks/useSpeechPlayback";
import { m } from "~/i18n/messages";
import { clampResponse, requestSpeechAudio } from "~/lib/readAloud";
import {
  advanceResponseMark,
  completedResponseId,
  isNewerResponse,
  latestReadAloudMessage,
  type ResponseMark,
} from "~/lib/readAloudMessages";
import { setAutoReadAloud, useAutoReadAloud } from "~/readAloudAutoStore";
import { useThreadRunStatus } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function reportReadAloudError(message: string) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg("Couldn't read the response")),
      description: message,
    }),
  );
}

/**
 * Speaker and auto-read controls for a server thread. Mount it keyed by the
 * thread so switching threads stops whatever was playing.
 */
export const ComposerReadAloud = memo(function ComposerReadAloud({
  threadRef,
  detailLoaded,
}: {
  threadRef: ScopedThreadRef;
  detailLoaded: boolean;
}) {
  const enabled = useClientSettings((settings) => settings.readAloudEnabled);
  // Speech spends the environment's model and VoiceStudio time, so read-only clients cannot.
  const canSpeak = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  // The controls take what is on screen when they mount as already heard, so
  // they wait for thread detail: mounting on the empty placeholder would let a
  // reopened thread's last answer look new once its history arrives. ChatView
  // owns that load; only the enabled controls subscribe to the response text.
  if (!enabled || !canSpeak || !detailLoaded) return null;
  return <ReadAloudControls threadRef={threadRef} />;
});

function ReadAloudControls({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const messages = useReadAloudMessages(threadRef);
  const voice = useClientSettings((settings) => settings.readAloudVoice);
  const options = useClientSettings((settings) => settings.readAloudOptions);
  const autoRead = useAutoReadAloud(threadRef);
  const { state, play, stop } = useSpeechPlayback(reportReadAloudError);
  const latest = latestReadAloudMessage(messages);
  const latestRunStatus = useThreadRunStatus(threadRef, latest?.runId ?? null);

  // A response is new once its run completes. Until then the latest message
  // may be an interim one, which neither interrupts nor auto-plays.
  const completedId = completedResponseId(latest, latestRunStatus);
  const completedAt = completedId === null ? null : (latest?.createdAt ?? null);
  // Marks of the newest response already shown, and already read or skipped
  // automatically. They only move forward, so rewinding to an older answer
  // never makes it new. What is on screen at mount counts as shown, even if its
  // run's completion arrives only afterwards.
  const onScreenAtMount: ResponseMark | null =
    latest === null ? null : { id: latest.id, createdAt: latest.createdAt };
  const shownRef = useRef(onScreenAtMount);
  const autoReadRef = useRef(onScreenAtMount);

  const readLatest = () => {
    if (latest === null) return;
    // Reading it counts as having shown it, so its run completing later
    // neither stops this read nor starts it again.
    shownRef.current = advanceResponseMark(shownRef.current, latest);
    autoReadRef.current = advanceResponseMark(autoReadRef.current, latest);
    void play(async (signal) => {
      const { text, truncated } = clampResponse(latest.text);
      const stream = await requestSpeechAudio(
        threadRef.environmentId,
        { text, voice, options, verbatim: false },
        signal,
      );
      if (truncated && !signal.aborted) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: m(msg("Reading the first part")),
            description: m(msg("This response is longer than read aloud speaks in one go.")),
          }),
        );
      }
      return stream;
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Stop external audio when a newer response completes.
  useEffect(() => {
    if (completedId === null || completedAt === null) return;
    const completed = { id: completedId, createdAt: completedAt };
    if (!isNewerResponse(completed, shownRef.current)) return;
    shownRef.current = completed;
    stop();
  }, [completedId, completedAt, stop]);

  // Only responses that complete while auto read is on play by themselves; the
  // one already on screen when it is switched on, or the thread opens, does not.
  const readLatestAutomatically = useEffectEvent(readLatest);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Start external audio when an opted-in thread completes a response.
  useEffect(() => {
    if (completedId === null || completedAt === null) return;
    const completed = { id: completedId, createdAt: completedAt };
    if (!autoRead) {
      autoReadRef.current = advanceResponseMark(autoReadRef.current, completed);
      return;
    }
    if (!isNewerResponse(completed, autoReadRef.current) || state !== "idle") return;
    autoReadRef.current = completed;
    readLatestAutomatically();
  }, [autoRead, completedId, completedAt, state]);

  const speakerLabel =
    latest === null
      ? gt("No response to read yet")
      : state === "idle"
        ? gt("Read response aloud")
        : state === "loading"
          ? gt("Preparing speech. Select to cancel")
          : gt("Stop reading");
  const autoLabel = autoRead
    ? gt("Stop reading new responses aloud")
    : gt("Read new responses aloud automatically");

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={autoLabel}
              aria-pressed={autoRead}
              onClick={() => setAutoReadAloud(threadRef, !autoRead)}
              type="button"
              size="icon-sm"
              variant={autoRead ? "secondary" : "ghost-muted"}
            />
          }
        >
          <WavesIcon aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>
          <p>{autoLabel}</p>
        </TooltipPopup>
      </Tooltip>
      {latest === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={speakerLabel}
                onClick={state === "idle" ? readLatest : stop}
                type="button"
                size="icon-sm"
                variant={state === "idle" ? "ghost-muted" : "secondary"}
              />
            }
          >
            {state === "idle" ? (
              <Volume2Icon aria-hidden className="size-4" />
            ) : (
              <SquareIcon aria-hidden className="size-4" />
            )}
          </TooltipTrigger>
          <TooltipPopup>
            <p>{speakerLabel}</p>
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );
}
