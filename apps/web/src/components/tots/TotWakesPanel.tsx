import type { ScheduledTask, TotWakeSettings } from "@t3tools/contracts";
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
          {entry.tot.wakesHeld === 1
            ? "1 scheduled wake is waiting."
            : `${entry.tot.wakesHeld} scheduled wakes are waiting.`}{" "}
          They'll run as one turn.
        </p>
      ) : null}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label>Quiet hours</Label>
          <Switch
            aria-label="Quiet hours"
            checked={quietHours !== null}
            onCheckedChange={(on) =>
              onChange({ ...value, quietHours: on ? DEFAULT_QUIET_HOURS : null })
            }
          />
        </div>
        {quietHours ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>From</span>
            <div className="w-32">
              <Input
                type="time"
                aria-label="Quiet hours start"
                value={quietHours.start}
                onChange={(event) => {
                  const start = event.currentTarget.value;
                  if (start) onChange({ ...value, quietHours: { ...quietHours, start } });
                }}
              />
            </div>
            <span>to</span>
            <div className="w-32">
              <Input
                type="time"
                aria-label="Quiet hours end"
                value={quietHours.end}
                onChange={(event) => {
                  const end = event.currentTarget.value;
                  if (end) onChange({ ...value, quietHours: { ...quietHours, end } });
                }}
              />
            </div>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          On {entry.machineLabel ?? "its machine"}'s clock. Scheduled wakes wait and merge into one
          turn when these end. Heartbeats are skipped instead.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="tot-wake-limit">Daily wake limit</Label>
        <div className="w-32">
          <Input
            id="tot-wake-limit"
            type="number"
            min={1}
            placeholder="No limit"
            value={value.dailyWakeLimit ?? ""}
            onChange={(event) => {
              const limit = Number.parseInt(event.currentTarget.value, 10);
              onChange({ ...value, dailyWakeLimit: limit >= 1 ? limit : null });
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Counts scheduled wakes. Extra ones wait until the next day, and extra heartbeats are
          skipped.
        </p>
      </div>
      <div className="grid gap-2">
        <Label>Schedules</Label>
        {boundTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {tasks.error === null ? "None post in this Tot's thread." : "Couldn't load schedules."}
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
                      {" · next "}
                      <ScheduledRelativeLabel value={task.nextRunAt} />
                    </>
                  ) : null}
                  {task.enabled ? "" : " · paused"}
                </span>
                <Input
                  aria-label={`Check before ${task.title}`}
                  placeholder="Optional check, like: git fetch -q && ! git diff --quiet HEAD @{u}"
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
            A check runs in the Tot's folder before the wake. Exit 1 skips the wake. Any other
            failure still wakes it, and it's told the check failed. Change or pause a schedule in
            Settings → Scheduled tasks.
          </p>
        ) : null}
      </div>
      <div className="grid gap-2">
        <Label>Always wake it straight away</Label>
        <ul className="grid list-none gap-1 text-xs text-muted-foreground">
          {watches.map((link) => (
            <li key={link.url} className="truncate">
              Watching PR #{link.number}
            </li>
          ))}
          {crew.map((thread) => (
            <li key={thread.id} className="truncate">
              Crew: {thread.title}
            </li>
          ))}
          {watched.map((thread) => (
            <li key={thread.id} className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate">Watching: {thread.title}</span>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Stop watching ${thread.title}`}
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
          <li>Your messages, pull request watches, watched threads, crew results and Run now.</li>
        </ul>
      </div>
    </div>
  );
}
