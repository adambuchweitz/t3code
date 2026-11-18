import { totPlaceLabel, totWaitingQueue } from "@t3tools/client-runtime/tots/entries";
import { totWaitingItemTitle } from "@t3tools/client-runtime/tots/logic";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
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
import { TotRequestCard } from "./TotRequestCard";

export function TotNeedsYouQueue(props: { readonly entries: ReadonlyArray<TotEntry> }) {
  const navigate = useNavigate();
  const gt = useGT();
  const m = useMessages();
  const shells = useQuietThreadShells();
  const [openId, setOpenId] = useState<string | null>(null);
  const { items, crewNeeds, total } = totWaitingQueue(
    {
      entries: props.entries,
      threads: shells,
      threadStatus: resolveSidebarThreadStatus,
    },
    m,
  );
  if (total === 0) return null;
  return (
    <section aria-label={gt("Waiting on you")} data-testid="tot-needs-you">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <T>Waiting on you</T>
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
                    {totWaitingItemTitle(item, entry.displayName, entry.tot.voice, m)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {totPlaceLabel(entry)} · {formatRelativeTimeLabel(at)}
                    {item.kind === "request" && item.request.blocks !== null
                      ? ` · ${gt("blocks {blocks}", { blocks: item.request.blocks })}`
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
        {crewNeeds.map(({ entry, thread, label }) => (
          <li key={thread.id} className="flex min-w-0 items-center gap-3 p-3">
            <TotCharacter character={entry.tot.character} pose="working" size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">{label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {totPlaceLabel(entry)}
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
              <T context="verb, open the crew thread to review it">Review</T>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
