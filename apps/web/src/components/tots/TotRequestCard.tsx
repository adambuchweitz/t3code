import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { orderTotRequestOptions } from "@t3tools/client-runtime/tots/logic";
import type { TotRequest } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { TotCharterEditor } from "./TotCharterEditor";

export function TotRequestMeta(props: { readonly request: TotRequest }) {
  const { request } = props;
  const gt = useGT();
  return (
    <>
      <T>
        Asked <Var>{formatRelativeTimeLabel(request.askedAt)}</Var>
      </T>
      {request.blocks === null ? "" : ` · ${gt("Blocks {blocks}", { blocks: request.blocks })}`}
    </>
  );
}

/** The question stays with the caller, because a dock row and the queue title it differently. */
export function TotRequestCard(props: { readonly entry: TotEntry; readonly request: TotRequest }) {
  const { entry, request } = props;
  const gt = useGT();
  const [showDetails, setShowDetails] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const answer = useAtomCommand(serverEnvironment.answerTotRequest, { reportFailure: false });
  const canOperate = useAtomValue(
    serverEnvironment.answerTotRequest.permissionAtom(entry.environmentId),
  );
  const respond = async (text: string | null) => {
    setSending(true);
    const result = await answer({
      environmentId: entry.environmentId,
      input: { id: entry.tot.id, requestId: request.id, answer: text },
    });
    setSending(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: gt("Couldn't send your answer"),
      description: error instanceof Error ? error.message : gt("Try again."),
    });
  };
  const disabled = sending || !canOperate;
  const options = orderTotRequestOptions(request);
  return (
    <div className="grid gap-2" data-testid="tot-request">
      {request.summary === "" ? null : (
        <p className="text-sm whitespace-pre-wrap text-foreground/90">{request.summary}</p>
      )}
      {showDetails ? (
        <div className="max-h-72 overflow-auto rounded-md border bg-background p-3 text-sm">
          <ChatMarkdown text={request.details} cwd={undefined} threadRef={entry.threadRef} />
        </div>
      ) : null}
      {writing ? (
        <TotCharterEditor
          value={draft}
          ariaLabel={gt("Your answer to {name}", { name: entry.displayName })}
          placeholder={gt("Write your answer")}
          disabled={disabled}
          onChange={setDraft}
        />
      ) : null}
      {writing ? (
        <div>
          <Button
            size="sm"
            disabled={disabled || draft.trim() === ""}
            onClick={() => void respond(draft.trim())}
          >
            <T>Send answer</T>
          </Button>
        </div>
      ) : options.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === request.recommendedOption ? "default" : "outline"}
              disabled={disabled}
              onClick={() => void respond(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={writing}
          onClick={() => setWriting((current) => !current)}
        >
          {writing ? gt("Back to the options") : gt("Write my own answer")}
        </Button>
        {request.details === "" ? null : (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((current) => !current)}
          >
            {showDetails ? gt("Hide the research") : gt("Read the research")}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          disabled={disabled}
          onClick={() => void respond(null)}
        >
          <T>Not needed</T>
        </Button>
      </div>
    </div>
  );
}
