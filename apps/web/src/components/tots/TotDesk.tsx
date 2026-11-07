import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, PencilIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { buildThreadRouteParams } from "~/threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { Button } from "../ui/button";
import { TotCharacter } from "./TotCharacter";
import { openTotDialog } from "./totDialogState";
import { openTotDockItem } from "./totDockState";
import {
  isTotCrewThread,
  TOT_CREW_STATUS,
  TOT_JOB_LABEL,
  type TotCrewTone,
  TOT_STATE_POSE,
  totStateLabel,
  totWaitingItems,
  totWaitingItemTitle,
} from "@t3tools/client-runtime/tots/logic";

const CREW_TONE_CLASS: Record<TotCrewTone, string> = {
  attention: "text-warning-foreground",
  failed: "text-destructive-foreground",
  active: "text-info",
  quiet: "text-muted-foreground",
};

function DeskSection(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-t px-3 py-2.5">
      <div className="mb-1 flex min-h-5 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function useTotCrew(entry: TotEntry) {
  const shells = useQuietThreadShells();
  return shells
    .filter((thread) => isTotCrewThread(entry.tot, entry.environmentId, thread))
    .map((thread) => ({ thread, status: TOT_CREW_STATUS[resolveSidebarThreadStatus(thread)] }))
    .toSorted(
      (left, right) =>
        left.status.rank - right.status.rank || left.thread.title.localeCompare(right.thread.title),
    );
}

/**
 * Takes over a Tot's thread details card: who it is and what it's looking after come first, and
 * the usual thread controls stay one click away for the times a Tot's checkout matters.
 */
export function TotDesk(props: { readonly entry: TotEntry; readonly workspace: ReactNode }) {
  const { entry } = props;
  const { tot, state } = entry;
  const navigate = useNavigate();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const crew = useTotCrew(entry);
  const items = totWaitingItems(entry.tot);
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: entry.environmentId, input: {} }),
  );
  const nextWake = (tasks.data?.tasks ?? [])
    .filter((task) => task.threadId === entry.threadId && task.enabled && task.nextRunAt !== null)
    .toSorted((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""))[0];
  const place = [tot.nameEnabled ? entry.projectName : null, entry.machineLabel]
    .filter(Boolean)
    .join(" on ");
  return (
    <div data-testid="tot-desk">
      <div className="flex items-start gap-3 p-3">
        <TotCharacter character={tot.character} pose={TOT_STATE_POSE[state]} size={56} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{entry.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{TOT_JOB_LABEL[tot.job]}</p>
          <p
            className={cn(
              "truncate text-xs font-medium",
              state === "needs" ? "text-warning-foreground" : "text-muted-foreground",
              state === "working" && "text-info",
            )}
          >
            {totStateLabel(state, tot.voice)}
          </p>
          {place === "" ? null : <p className="truncate text-xs text-muted-foreground">{place}</p>}
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Edit ${entry.displayName}`}
          onClick={() => openTotDialog({ kind: "thread", threadRef: entry.threadRef })}
        >
          <PencilIcon />
        </Button>
      </div>

      {items.length === 0 ? null : (
        <DeskSection title="Waiting on you">
          <ul className="grid list-none gap-0.5">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full rounded-sm text-left text-sm text-warning-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => openTotDockItem(entry.threadRef, item.id)}
                >
                  {totWaitingItemTitle(item, entry.displayName, entry.tot.voice)}
                </button>
              </li>
            ))}
          </ul>
        </DeskSection>
      )}

      <DeskSection title="Crew">
        {crew.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nobody's out on a job.</p>
        ) : (
          <ul className="grid list-none gap-0.5">
            {crew.map(({ thread, status }) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-baseline justify-between gap-2 rounded-sm text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(entry.environmentId, thread.id),
                      ),
                    })
                  }
                >
                  <span className="min-w-0 truncate text-foreground">{thread.title}</span>
                  <span className={cn("shrink-0 text-xs", CREW_TONE_CLASS[status.tone])}>
                    {status.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DeskSection>

      <DeskSection title="Charter">
        {tot.charter.trim() === "" ? (
          <p className="text-xs text-muted-foreground">No charter yet.</p>
        ) : (
          <p className="line-clamp-5 text-xs whitespace-pre-wrap text-foreground/90">
            {tot.charter.trim()}
          </p>
        )}
      </DeskSection>

      <DeskSection title="Wakes">
        <p className="text-xs text-foreground/90">
          {nextWake?.nextRunAt ? (
            <>
              Next wake <ScheduledRelativeLabel value={nextWake.nextRunAt} />
            </>
          ) : (
            "No wake scheduled"
          )}
          {tot.wakeSettings.quietHours === null
            ? ""
            : ` · Quiet ${tot.wakeSettings.quietHours.start} to ${tot.wakeSettings.quietHours.end}`}
        </p>
        {tot.watchedThreadIds.length === 0 && tot.wakesHeld === 0 ? null : (
          <p className="text-xs text-muted-foreground">
            {[
              tot.watchedThreadIds.length === 0
                ? null
                : `Watching ${tot.watchedThreadIds.length} thread${tot.watchedThreadIds.length === 1 ? "" : "s"}`,
              tot.wakesHeld === 0
                ? null
                : `${tot.wakesHeld} wake${tot.wakesHeld === 1 ? "" : "s"} waiting`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </DeskSection>

      <div className="border-t">
        <button
          type="button"
          aria-expanded={workspaceOpen}
          className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onClick={() => setWorkspaceOpen((current) => !current)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", workspaceOpen && "rotate-90")}
          />
          Thread details
        </button>
        {workspaceOpen ? props.workspace : null}
      </div>
    </div>
  );
}
