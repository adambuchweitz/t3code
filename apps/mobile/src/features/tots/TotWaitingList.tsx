import { useAtomValue } from "@effect/atom-react";
import { totPlaceLabel, totWaitingQueue } from "@t3tools/client-runtime/tots/entries";
import { totWaitingItemTitle } from "@t3tools/client-runtime/tots/logic";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { environmentThreadShells } from "../../state/threads";
import { useTotEntries } from "../../state/tots";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { updateTotDock } from "./totDockState";
import { TotFace } from "./TotFace";

function WaitingRow(props: {
  readonly character: string;
  readonly pose: "needs" | "working";
  readonly title: string;
  readonly detail: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="flex-row items-center gap-3 px-3.5 py-3 active:opacity-70"
      onPress={props.onPress}
    >
      <TotFace character={props.character} pose={props.pose} size={34} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={2} className="font-t3-medium text-sm text-foreground">
          {props.title}
        </Text>
        <Text numberOfLines={1} className="font-sans text-xs text-foreground-muted">
          {props.detail}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-foreground-muted" />
    </Pressable>
  );
}

/** Everything the Tots on every connected machine are waiting on. Gone when nothing is. */
export function TotWaitingList() {
  const selectDetail = useSelectWorkspaceDetail();
  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(threadId) },
    });
  const entries = useTotEntries();
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const { items, crewNeeds, total } = totWaitingQueue({
    entries,
    threads: shells,
    threadStatus: resolveThreadListV2Status,
  });
  if (total === 0) return null;
  return (
    <View className="mx-4 mb-3 mt-1" testID="tot-waiting-list">
      <Text className="mb-1.5 px-1 font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Waiting on you · {total}
      </Text>
      <View className="overflow-hidden rounded-[20px] border border-border bg-card">
        {items.map(({ entry, item, at }, index) => (
          <View key={item.id} className={index === 0 ? "" : "border-t border-border-subtle"}>
            <WaitingRow
              character={entry.tot.character}
              pose="needs"
              title={totWaitingItemTitle(item, entry.displayName, entry.tot.voice)}
              detail={`${totPlaceLabel(entry)} · ${relativeTime(at)} ago`}
              onPress={() => {
                updateTotDock(entry.threadRef, { openItemId: item.id, minimized: false });
                openThread(entry.environmentId, entry.threadId);
              }}
            />
          </View>
        ))}
        {crewNeeds.map(({ entry, thread, label }, index) => (
          <View
            key={`${thread.environmentId}:${thread.id}`}
            className={items.length + index === 0 ? "" : "border-t border-border-subtle"}
          >
            <WaitingRow
              character={entry.tot.character}
              pose="working"
              title={label}
              detail={totPlaceLabel(entry)}
              onPress={() => openThread(thread.environmentId, thread.id)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}
