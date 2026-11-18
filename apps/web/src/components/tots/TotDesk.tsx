import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { ChevronRightIcon, PencilIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { useQuietThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { buildThreadRouteParams } from "~/threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { totLocationLabel } from "@t3tools/client-runtime/tots/entries";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { TotCharacter } from "./TotCharacter";
import { openTotDialog } from "./totDialogState";
import { openTotDockItem } from "./totDockState";
import {
  totCrew,
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
  return totCrew({
    tot: entry.tot,
    environmentId: entry.environmentId,
    threads: useQuietThreadShells(),
    threadStatus: resolveSidebarThreadStatus,
  });
}

function CrewRow(props: {
  readonly entry: TotEntry;
  readonly title: string;
  readonly threadId: TotEntry["threadId"];
  readonly label: string;
  readonly tone: TotCrewTone;
}) {
  const navigate = useNavigate();
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-baseline justify-between gap-2 rounded-sm text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(props.entry.environmentId, props.threadId),
            ),
          })
        }
      >
        <span className="min-w-0 truncate text-foreground">{props.title}</span>
        <span className={cn("shrink-0 text-xs", CREW_TONE_CLASS[props.tone])}>{props.label}</span>
      </button>
    </li>
  );
}

/** Finished runs stay out of the way until the user wants them or wants them gone. */
function FinishedCrew(props: {
  readonly entry: TotEntry;
  readonly threads: ReturnType<typeof useTotCrew>["finished"];
}) {
  const { settleThread } = useThreadActions();
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const settleAll = async () => {
    setSettling(true);
    const results = await Promise.all(
      props.threads.map((thread) => settleThread(scopeThreadRef(thread.environmentId, thread.id))),
    );
    setSettling(false);
    const failed = results.filter(
      (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
    ).length;
    if (failed > 0) {
      toastManager.add({
        type: "error",
        title: gt("Couldn't settle {failed} of {total} finished threads", {
          failed,
          total: results.length,
        }),
      });
    }
  };
  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRightIcon className={cn("size-3.5", open && "rotate-90")} />
          {gt("{count, plural, one {{count} finished} other {{count} finished}}", {
            count: props.threads.length,
          })}
        </button>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={settling}
          onClick={() => void settleAll()}
        >
          <T>Settle all</T>
        </Button>
      </div>
      {open ? (
        <ul className="mt-1 grid list-none gap-0.5">
          {props.threads.map((thread) => (
            <CrewRow
              key={thread.id}
              entry={props.entry}
              title={thread.title}
              threadId={thread.id}
              label={gt("Done", { $context: "finished crew thread" })}
              tone="quiet"
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Takes over a Tot's thread details card: who it is and what it's looking after come first, and
 * the usual thread controls stay one click away for the times a Tot's checkout matters.
 */
export function TotDesk(props: { readonly entry: TotEntry; readonly workspace: ReactNode }) {
  const { entry } = props;
  const { tot, state } = entry;
  const gt = useGT();
  const m = useMessages();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const crew = useTotCrew(entry);
  const items = totWaitingItems(entry.tot);
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: entry.environmentId, input: {} }),
  );
  const nextWake = (tasks.data?.tasks ?? [])
    .filter((task) => task.threadId === entry.threadId && task.enabled && task.nextRunAt !== null)
    .toSorted((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""))[0];
  const place = totLocationLabel(tot.nameEnabled ? entry.projectName : null, entry.machineLabel, m);
  return (
    <div data-testid="tot-desk">
      <div className="flex items-start gap-3 p-3">
        <TotCharacter character={tot.character} pose={TOT_STATE_POSE[state]} size={56} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{entry.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{m(TOT_JOB_LABEL[tot.job])}</p>
          <p
            className={cn(
              "truncate text-xs font-medium",
              state === "needs" ? "text-warning-foreground" : "text-muted-foreground",
              state === "working" && "text-info",
            )}
          >
            {totStateLabel(state, tot.voice, m)}
          </p>
          {place === "" ? null : <p className="truncate text-xs text-muted-foreground">{place}</p>}
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={gt("Edit {name}", { name: entry.displayName })}
          onClick={() => openTotDialog({ kind: "thread", threadRef: entry.threadRef })}
        >
          <PencilIcon />
        </Button>
      </div>

      {items.length === 0 ? null : (
        <DeskSection title={gt("Waiting on you")}>
          <ul className="grid list-none gap-0.5">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="w-full rounded-sm text-left text-sm text-warning-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => openTotDockItem(entry.threadRef, item.id)}
                >
                  {totWaitingItemTitle(item, entry.displayName, entry.tot.voice, m)}
                </button>
              </li>
            ))}
          </ul>
        </DeskSection>
      )}

      <DeskSection title={gt("Crew", { $context: "threads a Tot started" })}>
        {crew.active.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>Nobody's out on a job.</T>
          </p>
        ) : (
          <ul className="grid list-none gap-0.5">
            {crew.active.map(({ thread, status }) => (
              <CrewRow
                key={thread.id}
                entry={entry}
                title={thread.title}
                threadId={thread.id}
                label={m(status.label)}
                tone={status.tone}
              />
            ))}
          </ul>
        )}
        {crew.finished.length === 0 ? null : <FinishedCrew entry={entry} threads={crew.finished} />}
      </DeskSection>

      <DeskSection title={gt("Charter", { $context: "the Tot's standing instructions" })}>
        {tot.charter.trim() === "" ? (
          <p className="text-xs text-muted-foreground">
            <T>No charter yet.</T>
          </p>
        ) : (
          <p className="line-clamp-5 text-xs whitespace-pre-wrap text-foreground/90">
            {tot.charter.trim()}
          </p>
        )}
      </DeskSection>

      <DeskSection title={gt("Wakes", { $context: "Tot settings section, when it wakes up" })}>
        <p className="text-xs text-foreground/90">
          {nextWake?.nextRunAt ? (
            <T>
              Next wake{" "}
              <Var>
                <ScheduledRelativeLabel value={nextWake.nextRunAt} />
              </Var>
            </T>
          ) : (
            gt("No wake scheduled")
          )}
          {tot.wakeSettings.quietHours === null
            ? ""
            : ` · ${gt("Quiet {start} to {end}", {
                start: tot.wakeSettings.quietHours.start,
                end: tot.wakeSettings.quietHours.end,
              })}`}
        </p>
        {tot.watchedThreadIds.length === 0 && tot.wakesHeld === 0 ? null : (
          <p className="text-xs text-muted-foreground">
            {[
              tot.watchedThreadIds.length === 0
                ? null
                : gt(
                    "{count, plural, one {Watching {count} thread} other {Watching {count} threads}}",
                    { count: tot.watchedThreadIds.length },
                  ),
              tot.wakesHeld === 0
                ? null
                : gt("{count, plural, one {{count} wake waiting} other {{count} wakes waiting}}", {
                    count: tot.wakesHeld,
                  }),
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
          <T>Thread details</T>
        </button>
        {workspaceOpen ? props.workspace : null}
      </div>
    </div>
  );
}
