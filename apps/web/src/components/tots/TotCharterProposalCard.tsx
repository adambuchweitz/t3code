import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { TOT_CHARTER_MAX_LENGTH, type TotCharterProposal } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { TotCharacter } from "./TotCharacter";
import { TotCharterEditor } from "./TotCharterEditor";
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
  const [draft, setDraft] = useState(proposal.charter);
  const [comparing, setComparing] = useState(false);
  const edited = draft !== proposal.charter;
  const tooLong = draft.length > TOT_CHARTER_MAX_LENGTH;
  // With no charter yet, every line is new and a comparison would only be a wall of green.
  const canCompare = entry.tot.charter.trim() !== "";
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
      input: {
        id: entry.tot.id,
        proposalId: proposal.id,
        approve,
        ...(approve && edited ? { charter: draft } : {}),
      },
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
      <div className="mt-3">
        {comparing ? (
          <div className="max-h-96 overflow-auto rounded-md border bg-background p-2 font-mono text-xs">
            {diffCharterLines(entry.tot.charter, draft).map((line, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Lines repeat and never reorder.
              <div key={index} className={cn("whitespace-pre-wrap", LINE_CLASS[line.kind])}>
                {LINE_PREFIX[line.kind]}
                {line.text}
              </div>
            ))}
          </div>
        ) : (
          <TotCharterEditor
            value={draft}
            ariaLabel={`Proposed charter for ${entry.displayName}`}
            disabled={answering || !canOperate}
            onChange={setDraft}
          />
        )}
      </div>
      {tooLong ? (
        <p className="mt-2 text-xs text-destructive-foreground" role="alert">
          {draft.length - TOT_CHARTER_MAX_LENGTH} characters over the limit.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {canCompare ? (
          <Button
            size="sm"
            variant="ghost"
            className="mr-auto"
            aria-pressed={comparing}
            onClick={() => setComparing((current) => !current)}
          >
            {comparing ? "Back to editing" : "Compare with current"}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={answering || !canOperate}
          onClick={() => void respond(false)}
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          disabled={answering || !canOperate || tooLong}
          onClick={() => void respond(true)}
        >
          {edited ? "Approve with my edits" : "Approve"}
        </Button>
      </div>
    </section>
  );
}
