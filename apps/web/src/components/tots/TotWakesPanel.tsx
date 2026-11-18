import type { ScheduledTask, TotWakeSettings } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { XIcon } from "lucide-react";

import { useThreadShells } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";
import { useAtomCommand } from "~/state/use-atom-command";

import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

const DEFAULT_QUIET_HOURS = { start: "23:00", end: "07:00" };

function withCheck(value: TotWakeSettings, task: ScheduledTask, command: string): TotWakeSettings {
  const others = value.wakeChecks.filter((check) => check.scheduledTaskId !== task.id);
  return {
    ...value,
    wakeChecks: command === "" ? others : [...others, { scheduledTaskId: task.id, command }],
  };
}

export function TotWakesPanel(props: {
  readonly entry: TotEntry;
  readonly value: TotWakeSettings;
  readonly onChange: (next: TotWakeSettings) => void;
}) {
  const { entry, value, onChange } = props;
  const gt = useGT();
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: entry.environmentId, input: {} }),
  );
  const boundTasks = (tasks.data?.tasks ?? []).filter((task) => task.threadId === entry.threadId);
  const update = useAtomCommand(serverEnvironment.updateTot);
  const shells = useThreadShells();
  const watched = entry.tot.watchedThreadIds.flatMap((threadId) => {
    const thread = shells.find(
      (shell) => shell.environmentId === entry.environmentId && shell.id === threadId,
    );
    return thread === undefined || thread.archivedAt !== null || thread.settledAt !== null
      ? []
      : [thread];
  });
  const crew = shells.filter(
    (thread) =>
      thread.environmentId === entry.environmentId &&
      thread.lineage.parentThreadId === entry.threadId &&
      thread.archivedAt === null &&
      thread.settledAt === null,
  );
  const watches = (entry.thread?.pullRequests ?? []).filter((link) => link.watch !== undefined);
  const quietHours = value.quietHours;

  return (
    <div className="grid gap-5">
      {entry.tot.wakesHeld > 0 ? (
        <p className="text-sm text-warning-foreground" role="status">
          {gt(
            "{count, plural, one {{count} scheduled wake is waiting.} other {{count} scheduled wakes are waiting.}}",
            { count: entry.tot.wakesHeld },
          )}{" "}
          <T>They'll run as one turn.</T>
        </p>
      ) : null}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label>
            <T>Quiet hours</T>
          </Label>
          <Switch
            aria-label={gt("Quiet hours")}
            checked={quietHours !== null}
            onCheckedChange={(on) =>
              onChange({ ...value, quietHours: on ? DEFAULT_QUIET_HOURS : null })
            }
          />
        </div>
        {quietHours ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <T>
              From{" "}
              <Var>
                <div className="w-32">
                  <Input
                    type="time"
                    aria-label={gt("Quiet hours start")}
                    value={quietHours.start}
                    onChange={(event) => {
                      const start = event.currentTarget.value;
                      if (start) onChange({ ...value, quietHours: { ...quietHours, start } });
                    }}
                  />
                </div>
              </Var>{" "}
              to{" "}
              <Var>
                <div className="w-32">
                  <Input
                    type="time"
                    aria-label={gt("Quiet hours end")}
                    value={quietHours.end}
                    onChange={(event) => {
                      const end = event.currentTarget.value;
                      if (end) onChange({ ...value, quietHours: { ...quietHours, end } });
                    }}
                  />
                </div>
              </Var>
            </T>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {entry.machineLabel === null ? (
            <T>
              On its machine's clock. Scheduled wakes wait and merge into one turn when these end.
              Heartbeats are skipped instead.
            </T>
          ) : (
            <T>
              On <Var>{entry.machineLabel}</Var>'s clock. Scheduled wakes wait and merge into one
              turn when these end. Heartbeats are skipped instead.
            </T>
          )}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="tot-wake-limit">
          <T>Daily wake limit</T>
        </Label>
        <div className="w-32">
          <Input
            id="tot-wake-limit"
            type="number"
            min={1}
            placeholder={gt("No limit")}
            value={value.dailyWakeLimit ?? ""}
            onChange={(event) => {
              const limit = Number.parseInt(event.currentTarget.value, 10);
              onChange({ ...value, dailyWakeLimit: limit >= 1 ? limit : null });
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          <T>
            Counts scheduled wakes. Extra ones wait until the next day, and extra heartbeats are
            skipped.
          </T>
        </p>
      </div>
      <div className="grid gap-2">
        <Label>
          <T>Schedules</T>
        </Label>
        {boundTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tasks.error === null
              ? gt("None post in this Tot's thread.")
              : gt("Couldn't load schedules.")}
          </p>
        ) : (
          <ul className="grid list-none gap-3">
            {boundTasks.map((task) => (
              <li key={task.id} className="grid gap-1">
                <span className="truncate text-sm text-foreground">{task.title}</span>
                <span className="text-xs text-muted-foreground">
                  {scheduleLabel(task.schedule)}
                  {task.enabled && task.nextRunAt !== null ? (
                    <>
                      {" · "}
                      <T context="next scheduled run">
                        next{" "}
                        <Var>
                          <ScheduledRelativeLabel value={task.nextRunAt} />
                        </Var>
                      </T>
                    </>
                  ) : null}
                  {task.enabled ? "" : ` · ${gt("paused", { $context: "schedule state" })}`}
                </span>
                <Input
                  aria-label={gt("Check before {title}", { title: task.title })}
                  placeholder={gt("Optional check, like: {example}", {
                    example: "git fetch -q && ! git diff --quiet HEAD @{u}",
                  })}
                  maxLength={2000}
                  value={
                    value.wakeChecks.find((check) => check.scheduledTaskId === task.id)?.command ??
                    ""
                  }
                  onChange={(event) => onChange(withCheck(value, task, event.currentTarget.value))}
                />
              </li>
            ))}
          </ul>
        )}
        {boundTasks.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>
              A check runs in the Tot's folder before the wake. Exit 1 skips the wake. Any other
              failure still wakes it, and it's told the check failed. Change or pause a schedule in
              Settings → Scheduled tasks.
            </T>
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label>
          <T>Always wake it straight away</T>
        </Label>
        <ul className="grid list-none gap-1 text-xs text-muted-foreground">
          {watches.map((link) => (
            <li key={link.url} className="truncate">
              <T>
                Watching PR #<Var>{link.number}</Var>
              </T>
            </li>
          ))}
          {crew.map((thread) => (
            <li key={thread.id} className="truncate">
              <T>
                Crew: <Var>{thread.title}</Var>
              </T>
            </li>
          ))}
          {watched.map((thread) => (
            <li key={thread.id} className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate">
                <T>
                  Watching: <Var>{thread.title}</Var>
                </T>
              </span>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={gt("Stop watching {title}", { title: thread.title })}
                onClick={() =>
                  void update({
                    environmentId: entry.environmentId,
                    input: { id: entry.tot.id, unwatchThreadIds: [thread.id] },
                  })
                }
              >
                <XIcon />
              </Button>
            </li>
          ))}
          <li>
            <T>Your messages, pull request watches, watched threads, crew results and Run now.</T>
          </li>
        </ul>
      </div>
    </div>
  );
}
