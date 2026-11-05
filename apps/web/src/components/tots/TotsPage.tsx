import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, PlusIcon } from "lucide-react";

import { isElectron } from "~/env";
import { useTotEntries, type TotEntry } from "~/state/tots";
import { buildThreadRouteParams } from "~/threadRoutes";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { TOT_CHARACTERS, TotCharacter } from "./TotCharacter";
import { TotCharterProposalCard } from "./TotCharterProposalCard";
import { openTotDialog } from "./totDialogState";
import {
  TOT_STATE_LABEL,
  TOT_STATE_ORDER,
  TOT_STATE_POSE,
  totStateLabel,
  type TotState,
} from "./tots.logic";

const STATE_TEXT_CLASS: Record<TotState, string> = {
  needs: "text-warning-foreground",
  working: "text-info",
  idle: "text-muted-foreground",
  offline: "text-muted-foreground",
};

function TotTile({ entry }: { readonly entry: TotEntry }) {
  const navigate = useNavigate();
  const { tot, thread, state } = entry;
  const showsProject = tot.nameEnabled && entry.projectName !== null;
  const stateLabel = totStateLabel(state, tot.voice);
  return (
    <li className="group relative">
      <button
        type="button"
        data-testid="tot-tile"
        aria-label={`Open ${entry.displayName}, ${stateLabel}`}
        className="flex w-full min-w-0 items-center gap-3 rounded-lg border bg-card p-3 pr-10 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(entry.threadRef),
          })
        }
      >
        <TotCharacter
          character={tot.character}
          pose={TOT_STATE_POSE[state]}
          size={64}
          className="motion-safe:transition-transform motion-safe:group-hover:-translate-y-1"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-foreground">
            {entry.displayName}
          </span>
          <span className={cn("truncate text-xs font-medium", STATE_TEXT_CLASS[state])}>
            {stateLabel}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {[showsProject ? entry.projectName : null, entry.machineLabel]
              .filter(Boolean)
              .join(" on ")}
          </span>
          {thread ? (
            <span className="truncate text-xs text-muted-foreground">
              {thread.archivedAt ? `Archived: ${thread.title}` : thread.title}
            </span>
          ) : null}
          {tot.wakesHeld > 0 ? (
            <span className="truncate text-xs text-warning-foreground">
              {tot.wakesHeld === 1 ? "1 wake waiting" : `${tot.wakesHeld} wakes waiting`}
            </span>
          ) : null}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`Edit ${entry.displayName}`}
              className="absolute top-2 right-2"
              onClick={() => openTotDialog({ kind: "thread", threadRef: entry.threadRef })}
            />
          }
        >
          <PencilIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Edit</TooltipPopup>
      </Tooltip>
    </li>
  );
}

export function TotsPage() {
  const entries = useTotEntries();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Tots</h1>
        <Button
          size="xs"
          variant="outline"
          className="[-webkit-app-region:no-drag]"
          onClick={() => openTotDialog({ kind: "pick-thread" })}
        >
          <PlusIcon />
          Add a Tot
        </Button>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {entries.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader className="max-w-md">
              <div aria-hidden className="mb-4 flex flex-wrap justify-center gap-1">
                {TOT_CHARACTERS.map((character) => (
                  <TotCharacter
                    key={character.id}
                    character={character.id}
                    pose="awake"
                    size={48}
                  />
                ))}
              </div>
              <EmptyTitle>No Tots yet</EmptyTitle>
              <EmptyDescription>
                Give a long-running thread a name, a face and a charter. Its history and automations
                carry on, and you can turn it back at any time.
              </EmptyDescription>
              <div className="mt-5 flex justify-center">
                <Button size="sm" onClick={() => openTotDialog({ kind: "pick-thread" })}>
                  <PlusIcon />
                  Add your first Tot
                </Button>
              </div>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
            {entries.map((entry) =>
              entry.tot.charterProposal ? (
                <TotCharterProposalCard
                  key={entry.tot.charterProposal.id}
                  entry={entry}
                  proposal={entry.tot.charterProposal}
                />
              ) : null,
            )}
            {TOT_STATE_ORDER.map((state) => {
              const group = entries.filter((entry) => entry.state === state);
              if (group.length === 0) return null;
              return (
                <section key={state} aria-label={TOT_STATE_LABEL[state]}>
                  <h2 className="mb-2 text-xs font-medium text-muted-foreground">
                    {TOT_STATE_LABEL[state]}
                  </h2>
                  <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(18rem,100%),1fr))] gap-2">
                    {group.map((entry) => (
                      <TotTile key={entry.tot.id} entry={entry} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
