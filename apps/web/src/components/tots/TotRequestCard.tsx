import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { orderTotRequestOptions } from "@t3tools/client-runtime/tots/logic";
import type { TotRequest } from "@t3tools/contracts";
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
  return (
    <>
      Asked {formatRelativeTimeLabel(request.askedAt)}
      {request.blocks === null ? "" : ` · Blocks ${request.blocks}`}
    </>
  );
}

/** The question stays with the caller, because a dock row and the queue title it differently. */
export function TotRequestCard(props: { readonly entry: TotEntry; readonly request: TotRequest }) {
  const { entry, request } = props;
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
      title: "Couldn't send your answer",
      description: error instanceof Error ? error.message : "Try again.",
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
          ariaLabel={`Your answer to ${entry.displayName}`}
          placeholder="Write your answer"
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
            Send answer
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
          {writing ? "Back to the options" : "Write my own answer"}
        </Button>
        {request.details === "" ? null : (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((current) => !current)}
          >
            {showDetails ? "Hide the research" : "Read the research"}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto"
          disabled={disabled}
          onClick={() => void respond(null)}
        >
          Not needed
        </Button>
      </div>
    </div>
  );
}
