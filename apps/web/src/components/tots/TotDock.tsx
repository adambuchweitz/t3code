import type { ScopedThreadRef, TotCharterProposal, TotRequest } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from "lucide-react";

import { useTotForThread, type TotEntry } from "~/state/tots";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { TotCharacter } from "./TotCharacter";
import { TotCharterProposalBody, totCharterProposalTitle } from "./TotCharterProposalCard";
import { TotRequestCard, TotRequestMeta } from "./TotRequestCard";
import { openTotDockItem, setTotDockMinimized, useTotDock } from "./totDockState";
import { totRequestsHeading } from "./tots.logic";

type DockItem =
  | { readonly kind: "charter"; readonly id: string; readonly proposal: TotCharterProposal }
  | { readonly kind: "request"; readonly id: string; readonly request: TotRequest };

/** What's waiting on the user, oldest first. A charter change sorts by when it was proposed. */
export function totDockItems(entry: TotEntry): ReadonlyArray<DockItem> {
  const { charterProposal, requests } = entry.tot;
  const items: Array<DockItem & { readonly at: string }> = requests.map((request) => ({
    kind: "request",
    id: request.id,
    request,
    at: request.askedAt,
  }));
  if (charterProposal !== null) {
    items.push({
      kind: "charter",
      id: charterProposal.id,
      proposal: charterProposal,
      at: charterProposal.proposedAt,
    });
  }
  return items.toSorted((left, right) => left.at.localeCompare(right.at));
}

export function totDockItemTitle(item: DockItem, entry: TotEntry): string {
  return item.kind === "request"
    ? item.request.question
    : totCharterProposalTitle(entry.displayName, entry.tot.voice);
}

/** Pinned above the composer, so a dozen wakes can't scroll what the Tot needs out of sight. */
export function TotDock(props: { readonly threadRef: ScopedThreadRef }) {
  const entry = useTotForThread(props.threadRef);
  const dock = useTotDock(props.threadRef);
  if (entry === null) return null;
  const items = totDockItems(entry);
  const first = items[0];
  if (first === undefined) return null;
  const open = items.find((item) => item.id === dock.openItemId) ?? first;
  const heading = totRequestsHeading(entry.displayName, entry.tot.voice);
  return (
    <section
      aria-label={heading}
      data-testid="tot-dock"
      className="mb-2 flex max-h-[min(55dvh,32rem)] flex-col overflow-hidden rounded-xl border bg-card"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
        <TotCharacter character={entry.tot.character} pose="needs" size={24} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {dock.minimized ? totDockItemTitle(first, entry) : heading}
        </h2>
        {items.length > 1 ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {items.length} waiting
          </span>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={dock.minimized ? "Show what's waiting" : "Minimize"}
          aria-expanded={!dock.minimized}
          onClick={() => setTotDockMinimized(props.threadRef, !dock.minimized)}
        >
          {dock.minimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
      </header>
      {dock.minimized ? null : (
        <ul className="min-h-0 list-none overflow-y-auto border-t">
          {items.map((item) => {
            const isOpen = item.id === open.id;
            return (
              <li key={item.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className={cn(
                    "flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    !isOpen && "hover:bg-accent/50",
                  )}
                  onClick={() => openTotDockItem(props.threadRef, item.id)}
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0 text-muted-foreground",
                      isOpen && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-balance text-foreground">
                      {totDockItemTitle(item, entry)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {item.kind === "request" ? (
                        <TotRequestMeta request={item.request} />
                      ) : (
                        item.proposal.reason
                      )}
                    </span>
                  </span>
                </button>
                {isOpen ? (
                  <div className="px-3 pb-3 pl-8">
                    {item.kind === "request" ? (
                      <TotRequestCard entry={entry} request={item.request} />
                    ) : (
                      <TotCharterProposalBody
                        key={item.id}
                        entry={entry}
                        proposal={item.proposal}
                      />
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
