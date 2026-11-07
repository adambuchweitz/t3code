import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TotEntry } from "@t3tools/client-runtime/tots/entries";
import { diffCharterLines } from "@t3tools/client-runtime/tots/logic";
import { TOT_CHARTER_MAX_LENGTH, type TotCharterProposal } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const LINE_CLASS = {
  same: "text-foreground-muted",
  added: "bg-primary/10 text-foreground",
  removed: "bg-danger text-foreground-muted line-through",
};
const LINE_PREFIX = { same: "  ", added: "+ ", removed: "- " };

export function TotCharterAnswer(props: {
  readonly entry: TotEntry;
  readonly proposal: TotCharterProposal;
}) {
  const { entry, proposal } = props;
  const [draft, setDraft] = useState(proposal.charter);
  const [comparing, setComparing] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = draft !== proposal.charter;
  const tooLong = draft.length > TOT_CHARTER_MAX_LENGTH;
  // With no charter yet, every line is new and a comparison would only be a wall of green.
  const canCompare = entry.tot.charter.trim() !== "";
  const answer = useAtomCommand(serverEnvironment.answerTotCharterProposal, {
    reportFailure: false,
  });
  const canOperate = useAtomValue(
    serverEnvironment.answerTotCharterProposal.permissionAtom(entry.environmentId),
  );
  const respond = async (approve: boolean) => {
    setAnswering(true);
    setError(null);
    const result = await answer({
      environmentId: entry.environmentId,
      input: {
        id: entry.tot.id,
        proposalId: proposal.id,
        approve,
        ...(approve && edited ? { charter: draft } : {}),
      },
    });
    setAnswering(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Couldn't save your answer. Try again.");
  };
  const disabled = answering || !canOperate;
  return (
    <View className="gap-2.5" testID="tot-charter-proposal">
      {proposal.reason === "" ? null : (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {proposal.reason}
        </Text>
      )}
      {comparing ? (
        <ScrollView
          nestedScrollEnabled
          className="max-h-64 rounded-2xl border border-border bg-input p-3"
        >
          {diffCharterLines(entry.tot.charter, draft).map((line, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Lines repeat and never reorder.
            <Text key={index} className={cn("font-mono text-xs", LINE_CLASS[line.kind])}>
              {LINE_PREFIX[line.kind]}
              {line.text}
            </Text>
          ))}
        </ScrollView>
      ) : (
        <TextInput
          multiline
          scrollEnabled
          textAlignVertical="top"
          accessibilityLabel={`Proposed charter for ${entry.displayName}`}
          editable={!disabled}
          value={draft}
          onChangeText={setDraft}
          className="max-h-64 min-h-32 text-sm"
        />
      )}
      {tooLong ? (
        <Text accessibilityRole="alert" className="font-sans text-xs text-danger-foreground">
          {draft.length - TOT_CHARTER_MAX_LENGTH} characters over the limit.
        </Text>
      ) : null}
      <Button
        label={edited ? "Approve with my edits" : "Approve"}
        tone="primary"
        fullWidth
        disabled={disabled || tooLong}
        loading={answering}
        onPress={() => void respond(true)}
      />
      <View className="flex-row flex-wrap justify-between">
        {canCompare ? (
          <Button
            label={comparing ? "Back to editing" : "Compare"}
            tone="text"
            size="compact"
            onPress={() => setComparing((current) => !current)}
          />
        ) : (
          <View />
        )}
        <Button
          label="Dismiss"
          tone="text"
          size="compact"
          disabled={disabled}
          onPress={() => void respond(false)}
        />
      </View>
      {error === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      )}
    </View>
  );
}
