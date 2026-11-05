import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { TotTalkRequest } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { TotCharacter } from "./TotCharacter";

export function TotTalkRequestCard(props: {
  readonly entry: TotEntry;
  readonly request: TotTalkRequest;
}) {
  const { entry, request } = props;
  const navigate = useNavigate();
  const update = useAtomCommand(serverEnvironment.updateTot);
  const canOperate = useAtomValue(serverEnvironment.updateTot.permissionAtom(entry.environmentId));
  return (
    <section
      aria-label={`${entry.displayName} wants to talk`}
      data-testid="tot-talk-request"
      className="rounded-lg border bg-card p-3"
    >
      <div className="flex items-start gap-3">
        <TotCharacter character={entry.tot.character} pose="needs" size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {entry.tot.voice === "toddler"
              ? `${entry.displayName} wants to talk to you!`
              : `${entry.displayName} wants to talk`}
          </h2>
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">{request.topic}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!canOperate}
          onClick={() =>
            void update({
              environmentId: entry.environmentId,
              input: { id: entry.tot.id, dismissTalkRequest: true },
            })
          }
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(entry.threadRef),
            })
          }
        >
          Open thread
        </Button>
      </div>
    </section>
  );
}
