import type { TotEntry } from "@t3tools/client-runtime/tots/entries";
import {
  totRequestsHeading,
  totWaitingItems,
  totWaitingItemTitle,
  type TotWaitingItem,
} from "@t3tools/client-runtime/tots/logic";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { useTotForThread } from "../../state/tots";
import { TotCharterAnswer } from "./TotCharterAnswer";
import { TotDeskSheet } from "./TotDeskSheet";
import { updateTotDock, useTotDock } from "./totDockState";
import { TotFace } from "./TotFace";
import { TotRequestAnswers } from "./TotRequestAnswers";

function itemMeta(item: TotWaitingItem): string {
  if (item.kind === "charter") return `Proposed ${relativeTime(item.proposal.proposedAt)} ago`;
  const blocks = item.request.blocks === null ? "" : ` · Blocks ${item.request.blocks}`;
  return `Asked ${relativeTime(item.request.askedAt)} ago${blocks}`;
}

export function TotItemBody(props: { readonly entry: TotEntry; readonly item: TotWaitingItem }) {
  return props.item.kind === "request" ? (
    <TotRequestAnswers entry={props.entry} request={props.item.request} />
  ) : (
    <TotCharterAnswer key={props.item.id} entry={props.entry} proposal={props.item.proposal} />
  );
}

/** Pinned above the composer, so a run of wakes can't scroll what the Tot needs out of sight. */
export function TotDock(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly maxHeight: DerivedValue<number>;
}) {
  const entry = useTotForThread(props.threadRef);
  const heightStyle = useAnimatedStyle(() => ({ maxHeight: props.maxHeight.value * 0.6 }));
  if (entry === null) return null;
  return <TotDockForEntry entry={entry} heightStyle={heightStyle} />;
}

function TotDockForEntry(props: {
  readonly entry: TotEntry;
  readonly heightStyle: ReturnType<typeof useAnimatedStyle>;
}) {
  const { entry } = props;
  const dock = useTotDock(entry.threadRef);
  const items = totWaitingItems(entry.tot);
  const first = items[0];
  const desk = dock.deskOpen ? (
    <TotDeskSheet
      entry={entry}
      onClose={() => updateTotDock(entry.threadRef, { deskOpen: false })}
    />
  ) : null;
  if (first === undefined) return desk;
  const open = items.find((item) => item.id === dock.openItemId) ?? first;
  const heading = totRequestsHeading(entry.displayName, entry.tot.voice);
  return (
    <>
      <Animated.View
        style={props.heightStyle}
        className="mx-3.5 my-2 overflow-hidden rounded-[20px] border border-border bg-card-alt"
        testID="tot-dock"
      >
        <View className="flex-row items-center gap-2.5 px-3.5 py-2.5">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${entry.displayName}'s desk`}
            hitSlop={8}
            onPress={() => updateTotDock(entry.threadRef, { deskOpen: true })}
          >
            <TotFace character={entry.tot.character} pose="needs" size={30} />
          </Pressable>
          <Text numberOfLines={1} className="min-w-0 flex-1 font-t3-bold text-sm text-foreground">
            {dock.minimized
              ? totWaitingItemTitle(first, entry.displayName, entry.tot.voice)
              : heading}
          </Text>
          {items.length > 1 ? (
            <Text className="font-sans text-xs text-foreground-muted">{items.length} waiting</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dock.minimized ? "Show what's waiting" : "Minimize"}
            accessibilityState={{ expanded: !dock.minimized }}
            hitSlop={10}
            onPress={() => updateTotDock(entry.threadRef, { minimized: !dock.minimized })}
          >
            <SymbolView
              name={dock.minimized ? "chevron.up" : "chevron.down"}
              size={16}
              tintColorClassName="accent-foreground-muted"
            />
          </Pressable>
        </View>
        {dock.minimized ? null : (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            style={{ flexShrink: 1 }}
            className="border-t border-border"
          >
            {items.map((item) => {
              const isOpen = item.id === open.id;
              return (
                <View key={item.id} className="border-b border-border-subtle">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isOpen }}
                    className="flex-row items-start gap-2 px-3.5 py-2.5 active:opacity-70"
                    onPress={() => updateTotDock(entry.threadRef, { openItemId: item.id })}
                  >
                    <SymbolView
                      name={isOpen ? "chevron.down" : "chevron.right"}
                      size={12}
                      tintColorClassName="accent-foreground-muted"
                    />
                    <View className="min-w-0 flex-1">
                      <Text className="font-t3-medium text-sm text-foreground">
                        {totWaitingItemTitle(item, entry.displayName, entry.tot.voice)}
                      </Text>
                      <Text className="font-sans text-xs text-foreground-muted">
                        {itemMeta(item)}
                      </Text>
                    </View>
                  </Pressable>
                  {isOpen ? (
                    <View className="px-3.5 pb-3.5">
                      <TotItemBody entry={entry} item={item} />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        )}
      </Animated.View>
      {desk}
    </>
  );
}
