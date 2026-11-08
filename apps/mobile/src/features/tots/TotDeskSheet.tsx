import { useAtomValue } from "@effect/atom-react";
import type { TotEntry } from "@t3tools/client-runtime/tots/entries";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  totCrew,
  TOT_JOB_LABEL,
  TOT_STATE_POSE,
  totStateLabel,
  totWaitingItems,
  totWaitingItemTitle,
  type TotCrewTone,
} from "@t3tools/client-runtime/tots/logic";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Sheet } from "../../components/ui/Sheet";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { updateTotDock } from "./totDockState";
import { TotFace } from "./TotFace";

const CREW_TONE_CLASS: Record<TotCrewTone, string> = {
  attention: "text-warning-foreground",
  failed: "text-danger-foreground",
  active: "text-primary-text",
  quiet: "text-foreground-muted",
};

function DeskSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1.5 border-t border-border-subtle py-3">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function CrewRow(props: {
  readonly title: string;
  readonly label: string;
  readonly tone: TotCrewTone;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-9 flex-row items-center justify-between gap-3 active:opacity-70"
      onPress={props.onPress}
    >
      <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-sm text-foreground">
        {props.title}
      </Text>
      <Text className={cn("font-sans text-xs", CREW_TONE_CLASS[props.tone])}>{props.label}</Text>
    </Pressable>
  );
}

/** Finished runs stay out of the way until the user wants them or wants them gone. */
function FinishedCrew(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const settleAll = async () => {
    setSettling(true);
    const results = await Promise.all(
      props.threads.map((thread) =>
        settle({ environmentId: thread.environmentId, input: { threadId: thread.id } }),
      ),
    );
    setSettling(false);
    const failed = results.filter((result) => result._tag === "Failure").length;
    if (failed > 0) {
      Dialog.alert(
        "Couldn't settle every thread",
        `${failed} of ${results.length} finished threads are still open. Try again.`,
      );
    }
  };
  return (
    <View className="gap-1.5 pt-1">
      <View className="flex-row items-center justify-between gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          className="min-h-9 flex-row items-center gap-1.5 active:opacity-70"
          onPress={() => setOpen((value) => !value)}
        >
          <SymbolView
            name={open ? "chevron.down" : "chevron.right"}
            size={11}
            tintColorClassName="accent-foreground-muted"
          />
          <Text className="font-sans text-sm text-foreground-muted">
            {props.threads.length} finished
          </Text>
        </Pressable>
        <Button
          label="Settle all"
          tone="text"
          size="compact"
          loading={settling}
          onPress={() => void settleAll()}
        />
      </View>
      {open
        ? props.threads.map((thread) => (
            <CrewRow
              key={thread.id}
              title={thread.title}
              label="Done"
              tone="quiet"
              onPress={() => props.onOpen(thread)}
            />
          ))
        : null}
    </View>
  );
}

/** A phone has no room for the side panel, so the Desk is a sheet with the same sections. */
export function TotDeskSheet(props: { readonly entry: TotEntry; readonly onClose: () => void }) {
  const { entry } = props;
  const { tot, state } = entry;
  const insets = useSafeAreaInsets();
  const selectDetail = useSelectWorkspaceDetail();
  const nowMs = useNowMinuteMs();
  const crew = totCrew({
    tot,
    environmentId: entry.environmentId,
    threads: useAtomValue(environmentThreadShells.quietThreadShellsAtom),
    threadStatus: resolveThreadListV2Status,
  });
  const openThread = (thread: EnvironmentThreadShell) => {
    props.onClose();
    selectDetail({
      name: "Thread",
      params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
    });
  };
  const items = totWaitingItems(tot);
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: entry.environmentId, input: {} }),
  );
  const nextWakeAt = (tasks.data?.tasks ?? [])
    .filter((task) => task.threadId === entry.threadId && task.enabled && task.nextRunAt !== null)
    .map((task) => task.nextRunAt!)
    .sort()[0];
  const place = [tot.nameEnabled ? entry.projectName : null, entry.machineLabel]
    .filter(Boolean)
    .join(" on ");
  const wakeDetails = [
    tot.watchedThreadIds.length === 0
      ? null
      : `Watching ${tot.watchedThreadIds.length} thread${tot.watchedThreadIds.length === 1 ? "" : "s"}`,
    tot.wakesHeld === 0 ? null : `${tot.wakesHeld} wake${tot.wakesHeld === 1 ? "" : "s"} waiting`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Sheet title={entry.displayName} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
        testID="tot-desk"
      >
        <View className="flex-row items-center gap-4 pb-3">
          <TotFace character={tot.character} pose={TOT_STATE_POSE[state]} size={64} />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-sans text-sm text-foreground-secondary">
              {TOT_JOB_LABEL[tot.job]}
            </Text>
            <Text
              className={cn(
                "font-t3-bold text-sm",
                state === "needs" ? "text-warning-foreground" : "text-foreground",
              )}
            >
              {totStateLabel(state, tot.voice)}
            </Text>
            {place === "" ? null : (
              <Text className="font-sans text-xs text-foreground-muted">{place}</Text>
            )}
          </View>
        </View>

        {items.length === 0 ? null : (
          <DeskSection title="Waiting on you">
            {items.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                className="py-1 active:opacity-70"
                onPress={() => {
                  updateTotDock(entry.threadRef, {
                    openItemId: item.id,
                    minimized: false,
                    deskOpen: false,
                  });
                }}
              >
                <Text className="font-t3-medium text-sm text-warning-foreground">
                  {totWaitingItemTitle(item, entry.displayName, tot.voice)}
                </Text>
              </Pressable>
            ))}
          </DeskSection>
        )}

        <DeskSection title="Crew">
          {crew.active.length === 0 ? (
            <Text className="font-sans text-sm text-foreground-muted">Nobody's out on a job.</Text>
          ) : (
            crew.active.map(({ thread, status }) => (
              <CrewRow
                key={thread.id}
                title={thread.title}
                label={status.label}
                tone={status.tone}
                onPress={() => openThread(thread)}
              />
            ))
          )}
          {crew.finished.length === 0 ? null : (
            <FinishedCrew threads={crew.finished} onOpen={openThread} />
          )}
        </DeskSection>

        <DeskSection title="Charter">
          <Text
            numberOfLines={8}
            className={cn(
              "font-sans text-sm leading-normal",
              tot.charter.trim() === "" ? "text-foreground-muted" : "text-foreground-secondary",
            )}
          >
            {tot.charter.trim() === "" ? "No charter yet." : tot.charter.trim()}
          </Text>
        </DeskSection>

        <DeskSection title="Wakes">
          <Text className="font-sans text-sm text-foreground-secondary">
            {nextWakeAt === undefined
              ? "No wake scheduled"
              : `Next wake in ${relativeTime(new Date(nowMs).toISOString(), Date.parse(nextWakeAt))}`}
            {tot.wakeSettings.quietHours === null
              ? ""
              : ` · Quiet ${tot.wakeSettings.quietHours.start} to ${tot.wakeSettings.quietHours.end}`}
          </Text>
          {wakeDetails === "" ? null : (
            <Text className="font-sans text-xs text-foreground-muted">{wakeDetails}</Text>
          )}
        </DeskSection>
      </ScrollView>
    </Sheet>
  );
}
