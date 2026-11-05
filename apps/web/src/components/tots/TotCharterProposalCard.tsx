import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TotCharterProposal } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { TotCharacter } from "./TotCharacter";
import { diffCharterLines } from "./tots.logic";

const LINE_CLASS = {
  same: "text-muted-foreground",
  added: "bg-success/10 text-foreground",
  removed: "bg-destructive/10 text-muted-foreground line-through",
};
const LINE_PREFIX = { same: "  ", added: "+ ", removed: "- " };

export function TotCharterProposalCard(props: {
  readonly entry: TotEntry;
  readonly proposal: TotCharterProposal;
}) {
  const { entry, proposal } = props;
  const [answering, setAnswering] = useState(false);
  const answer = useAtomCommand(serverEnvironment.answerTotCharterProposal, {
    reportFailure: false,
  });
  const canOperate = useAtomValue(
    serverEnvironment.answerTotCharterProposal.permissionAtom(entry.environmentId),
  );
  const respond = async (approve: boolean) => {
    setAnswering(true);
    const result = await answer({
      environmentId: entry.environmentId,
      input: { id: entry.tot.id, proposalId: proposal.id, approve },
    });
    setAnswering(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Couldn't save your answer",
      description: error instanceof Error ? error.message : "Try again.",
    });
  };
  return (
    <section
      aria-label={`Charter change from ${entry.displayName}`}
      data-testid="tot-charter-proposal"
      className="rounded-lg border bg-card p-3"
    >
      <div className="flex items-start gap-3">
        <TotCharacter character={entry.tot.character} pose="needs" size={40} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {entry.tot.voice === "toddler"
              ? `${entry.displayName} wants new house rules!`
              : `${entry.displayName} proposes a charter change`}
          </h2>
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">{proposal.reason}</p>
        </div>
      </div>
      <div className="mt-3 max-h-64 overflow-auto rounded-md border bg-background p-2 font-mono text-xs">
        {diffCharterLines(entry.tot.charter, proposal.charter).map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Lines repeat and never reorder.
          <div key={index} className={cn("whitespace-pre-wrap", LINE_CLASS[line.kind])}>
            {LINE_PREFIX[line.kind]}
            {line.text}
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={answering || !canOperate}
          onClick={() => void respond(false)}
        >
          Dismiss
        </Button>
        <Button size="sm" disabled={answering || !canOperate} onClick={() => void respond(true)}>
          Approve
        </Button>
      </div>
    </section>
  );
}
