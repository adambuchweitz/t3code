import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { readThreadShell, useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { useTotEntries } from "~/state/tots";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TotCharacter } from "./TotCharacter";
import {
  resolveConnectedTot,
  TOT_JOB_LABEL,
  TOT_STATE_POSE,
  totStateLabel,
  type TotConnection,
} from "@t3tools/client-runtime/tots/logic";

const CONNECTION_TEXT: Record<TotConnection, (name: string) => string> = {
  self: (name) => `This thread is ${name}. Open Tots`,
  launched: (name) => `${name} started this work. Open ${name}`,
  project: (name) => `${name} looks after this project. Open ${name}`,
};

export function TotThreadChip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const entries = useTotEntries();
  const shell = useQuietThreadShell(threadRef);
  // Finished subagents and old settled threads have no shell, but the open thread has a projection.
  const projection = useQuietThreadProjection(threadRef);
  const thread = shell ?? projection?.projection.thread ?? null;
  if (entries.length === 0 || thread === null) return null;
  const connected = resolveConnectedTot({
    thread: {
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      projectId: thread.projectId,
      lineage: thread.lineage,
      delegatedFrom: thread.delegatedFrom,
    },
    tots: entries,
    readThread: (environmentId, threadId) =>
      readThreadShell(scopeThreadRef(environmentId, threadId)),
  });
  if (connected === null) return null;
  const { tot: entry, connection } = connected;
  const text = CONNECTION_TEXT[connection](entry.displayName);
  const stateLabel = totStateLabel(entry.state, entry.tot.voice);
  // In its own thread, the header already shows the Tot's face and name.
  const isSelf = connection === "self";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            data-testid="tot-thread-chip"
            aria-label={`${text}. ${stateLabel}`}
            className="shrink-0"
            onClick={() => {
              if (connection === "self") {
                void navigate({ to: "/tots" });
                return;
              }
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(entry.threadRef),
              });
            }}
          />
        }
      >
        {isSelf ? null : (
          <TotCharacter
            character={entry.tot.character}
            pose={TOT_STATE_POSE[entry.state]}
            size={20}
          />
        )}
        <span className="hidden max-w-64 truncate sm:inline">
          {isSelf ? `${TOT_JOB_LABEL[entry.tot.job]} · ${stateLabel}` : entry.displayName}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {text} · {stateLabel}
      </TooltipPopup>
    </Tooltip>
  );
}
