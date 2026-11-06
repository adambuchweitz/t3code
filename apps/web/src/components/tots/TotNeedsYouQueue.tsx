import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import type { TotEntry } from "~/state/tots";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { TotCharacter } from "./TotCharacter";
import { TotCharterProposalBody } from "./TotCharterProposalCard";
import { totDockItems, totDockItemTitle } from "./TotDock";
import { TotRequestCard } from "./TotRequestCard";

const CREW_NEEDS_LABEL = {
  approval: "needs approval",
  input: "has a question",
  request: "needs an answer",
} as const;

const isCrewNeed = (status: string): status is keyof typeof CREW_NEEDS_LABEL =>
  status in CREW_NEEDS_LABEL;

function placeLabel(entry: TotEntry) {
  return [entry.displayName, entry.tot.nameEnabled ? entry.projectName : null, entry.machineLabel]
    .filter(Boolean)
    .join(" · ");
}

/** Everything every connected machine's Tots are waiting on, oldest first. */
export function TotNeedsYouQueue(props: { readonly entries: ReadonlyArray<TotEntry> }) {
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const [openId, setOpenId] = useState<string | null>(null);
  const items = props.entries
    .flatMap((entry) =>
      totDockItems(entry).map((item) => ({
        entry,
        item,
        at: item.kind === "request" ? item.request.askedAt : item.proposal.proposedAt,
      })),
    )
    .toSorted((left, right) => left.at.localeCompare(right.at));
  const crewNeeds = shells.flatMap((thread) => {
    const status = resolveSidebarThreadStatus(thread);
    if (!isCrewNeed(status) || thread.archivedAt !== null) return [];
    const entry = props.entries.find(
      (candidate) =>
        candidate.environmentId === thread.environmentId &&
        candidate.threadId !== thread.id &&
        (thread.lineage.parentThreadId === candidate.threadId ||
          candidate.tot.watchedThreadIds.includes(thread.id)),
    );
    return entry === undefined ? [] : [{ entry, thread, status }];
  });
  const total = items.length + crewNeeds.length;
  if (total === 0) return null;
  return (
    <section aria-label="Waiting on you" data-testid="tot-needs-you">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        Waiting on you
        <span className="tabular-nums">{total}</span>
      </h2>
      <ul className="list-none divide-y overflow-hidden rounded-lg border bg-card">
        {items.map(({ entry, item, at }) => {
          const isOpen = openId === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                className="flex w-full min-w-0 items-start gap-3 p-3 text-left hover:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                onClick={() => setOpenId(isOpen ? null : item.id)}
              >
                <TotCharacter character={entry.tot.character} pose="needs" size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-balance text-foreground">
                    {totDockItemTitle(item, entry)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {placeLabel(entry)} · {formatRelativeTimeLabel(at)}
                    {item.kind === "request" && item.request.blocks !== null
                      ? ` · blocks ${item.request.blocks}`
                      : ""}
                  </span>
                </span>
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "mt-1 size-4 shrink-0 text-muted-foreground",
                    isOpen && "rotate-90",
                  )}
                />
              </button>
              {isOpen ? (
                <div className="px-3 pb-3 sm:pl-15">
                  {item.kind === "request" ? (
                    <TotRequestCard entry={entry} request={item.request} />
                  ) : (
                    <TotCharterProposalBody entry={entry} proposal={item.proposal} />
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
        {crewNeeds.map(({ entry, thread, status }) => (
          <li key={thread.id} className="flex min-w-0 items-center gap-3 p-3">
            <TotCharacter character={entry.tot.character} pose="working" size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {thread.title} {CREW_NEEDS_LABEL[status]}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {placeLabel(entry)}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(entry.environmentId, thread.id)),
                })
              }
            >
              Review
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
