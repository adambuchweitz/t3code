import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TotEntry } from "@t3tools/client-runtime/tots/entries";
import { orderTotRequestOptions } from "@t3tools/client-runtime/tots/logic";
import type { TotRequest } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

function TotResearchSheet(props: {
  readonly request: TotRequest;
  readonly answers: React.ReactNode;
  readonly onClose: () => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  const insets = useSafeAreaInsets();
  return (
    <Sheet title="Research" onClose={props.onClose}>
      <View className="flex-1">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 }}
        >
          <Text className="mb-3 font-t3-bold text-lg text-foreground">
            {props.request.question}
          </Text>
          <SelectableMarkdownText
            markdown={props.request.details}
            textStyle={styles.nativeTextStyle}
            onLinkPress={(href) => void openLink(href)}
          />
        </ScrollView>
        {/* The answers stay in reach, so finishing the read doesn't mean scrolling back. */}
        <View
          className="border-t border-border px-5 pt-3"
          style={{ paddingBottom: Math.max(16, insets.bottom) }}
        >
          {props.answers}
        </View>
      </View>
    </Sheet>
  );
}

/** Answers stack full width, because a row of buttons doesn't fit a thumb or a long option. */
export function TotRequestAnswers(props: {
  readonly entry: TotEntry;
  readonly request: TotRequest;
}) {
  const { entry, request } = props;
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const answer = useAtomCommand(serverEnvironment.answerTotRequest, { reportFailure: false });
  const canOperate = useAtomValue(
    serverEnvironment.answerTotRequest.permissionAtom(entry.environmentId),
  );
  const respond = async (text: string | null) => {
    setSending(true);
    setError(null);
    const result = await answer({
      environmentId: entry.environmentId,
      input: { id: entry.tot.id, requestId: request.id, answer: text },
    });
    setSending(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Couldn't send your answer. Try again.");
  };
  const disabled = sending || !canOperate;
  const options = orderTotRequestOptions(request);

  const answers = writing ? (
    <View className="gap-2">
      <TextInput
        multiline
        autoFocus
        placeholder="Write your answer"
        accessibilityLabel={`Your answer to ${entry.displayName}`}
        editable={!disabled}
        value={draft}
        onChangeText={setDraft}
        textAlignVertical="top"
        className="max-h-40 min-h-20"
      />
      <Button
        label="Send answer"
        tone="primary"
        fullWidth
        disabled={disabled || draft.trim() === ""}
        loading={sending}
        onPress={() => void respond(draft.trim())}
      />
      <Button label="Back to the options" tone="text" fullWidth onPress={() => setWriting(false)} />
    </View>
  ) : (
    <View className="gap-2">
      {options.map((option) => (
        <Button
          key={option}
          label={option}
          tone={option === request.recommendedOption ? "primary" : "secondary"}
          fullWidth
          disabled={disabled}
          onPress={() => void respond(option)}
        />
      ))}
      <View className="flex-row flex-wrap justify-between">
        <Button
          label="Write my own"
          tone="text"
          size="compact"
          disabled={disabled}
          onPress={() => setWriting(true)}
        />
        <Button
          label="Not needed"
          tone="text"
          size="compact"
          disabled={disabled}
          onPress={() => void respond(null)}
        />
      </View>
    </View>
  );

  return (
    <View className="gap-2.5" testID="tot-request">
      {request.summary === "" ? null : (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {request.summary}
        </Text>
      )}
      {request.details === "" ? null : (
        <Button
          label="Read the research"
          icon="doc.text"
          tone="secondary"
          size="compact"
          onPress={() => setResearchOpen(true)}
        />
      )}
      {answers}
      {error === null ? null : (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      )}
      {researchOpen ? (
        <TotResearchSheet
          request={request}
          answers={answers}
          onClose={() => setResearchOpen(false)}
        />
      ) : null}
    </View>
  );
}
