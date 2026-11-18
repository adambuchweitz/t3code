import {
  AuthOrchestrationOperateScope,
  DEFAULT_SPEECH_OPTIONS,
  DEFAULT_SPEECH_VOICE,
  type EnvironmentId,
  SPEECH_ACCENTS,
  SPEECH_AGES,
  SPEECH_GENDERS,
  SPEECH_PITCHES,
  type SpeechOptions,
  type SpeechVoiceProfiles,
  isDefaultSpeechVoice,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { useSpeechPlayback } from "~/hooks/useSpeechPlayback";
import { m } from "~/i18n/messages";
import { requestSpeechAudio, requestVoiceProfiles } from "~/lib/readAloud";
import { cn } from "~/lib/utils";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const DEFAULT_PREVIEW_TEXT = "Here is a preview of your read-aloud voice.";

/** Commits on blur or Enter; an invalid draft snaps back instead of saving. */
function DraftInput({
  label,
  value,
  parse,
  placeholder,
  type = "text",
  inputMode,
  className = "w-28",
}: {
  label: string;
  value: string;
  parse: (draft: string) => { readonly ok: true; readonly commit: () => void } | { ok: false };
  placeholder?: string;
  type?: "text" | "number";
  inputMode?: "decimal" | "numeric";
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setDraft(value);
  }
  const parsed = parse(draft.trim());
  return (
    <div className={className}>
      <Input
        type={type}
        inputMode={inputMode}
        aria-label={label}
        aria-invalid={!parsed.ok}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (parsed.ok) parsed.commit();
          else setDraft(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

const numberIn =
  (
    min: number,
    max: number,
    options: { readonly integer?: boolean; readonly blank?: () => void },
    commit: (value: number) => void,
  ) =>
  (draft: string) => {
    if (draft === "")
      return options.blank ? { ok: true as const, commit: options.blank } : { ok: false as const };
    const value = Number(draft);
    const ok =
      Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!options.integer || Number.isInteger(value));
    return ok ? { ok: true as const, commit: () => commit(value) } : { ok: false as const };
  };

const ATTRIBUTES = [
  {
    key: "gender",
    title: msg("Gender", { $context: "read-aloud voice attribute" }),
    label: msg("Voice gender"),
    values: SPEECH_GENDERS,
  },
  {
    key: "age",
    title: msg("Age", { $context: "read-aloud voice attribute" }),
    label: msg("Voice age"),
    values: SPEECH_AGES,
  },
  {
    key: "pitch",
    title: msg("Pitch", { $context: "read-aloud voice attribute" }),
    label: msg("Voice pitch"),
    values: SPEECH_PITCHES,
  },
  {
    key: "accent",
    title: msg("Accent", { $context: "read-aloud voice attribute" }),
    label: msg("Voice accent"),
    values: SPEECH_ACCENTS,
  },
] as const;

type SpeechAttributeValue = Exclude<SpeechOptions[(typeof ATTRIBUTES)[number]["key"]], "">;

const ATTRIBUTE_VALUE_LABELS = {
  male: msg("Male", { $context: "read-aloud voice gender" }),
  female: msg("Female", { $context: "read-aloud voice gender" }),
  child: msg("Child", { $context: "read-aloud voice age" }),
  teenager: msg("Teenager", { $context: "read-aloud voice age" }),
  "young adult": msg("Young adult", { $context: "read-aloud voice age" }),
  "middle-aged": msg("Middle-aged", { $context: "read-aloud voice age" }),
  elderly: msg("Elderly", { $context: "read-aloud voice age" }),
  "very low pitch": msg("Very low pitch"),
  "low pitch": msg("Low pitch"),
  "moderate pitch": msg("Moderate pitch"),
  "high pitch": msg("High pitch"),
  "very high pitch": msg("Very high pitch"),
  "american accent": msg("American accent"),
  "british accent": msg("British accent"),
  "australian accent": msg("Australian accent"),
  "chinese accent": msg("Chinese accent"),
  "canadian accent": msg("Canadian accent"),
  "indian accent": msg("Indian accent"),
  "korean accent": msg("Korean accent"),
  "portuguese accent": msg("Portuguese accent"),
  "russian accent": msg("Russian accent"),
  "japanese accent": msg("Japanese accent"),
} satisfies Record<SpeechAttributeValue, string>;

export function VoiceSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  // Keyed so profiles and an in-flight preview never carry over to another environment.
  return <VoiceSettingsContent key={environmentId ?? "none"} environmentId={environmentId} />;
}

function VoiceSettingsContent({ environmentId }: { environmentId: EnvironmentId | null }) {
  const gt = useGT();
  const messages = useMessages();
  const enabled = useClientSettings((settings) => settings.readAloudEnabled);
  const savedVoice = useClientSettings((settings) => settings.readAloudVoice);
  const options = useClientSettings((settings) => settings.readAloudOptions);
  const connected = usePreparedConnection(environmentId)._tag === "Some";
  const canSpeak = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const reachable = environmentId !== null && connected && canSpeak;

  const voice = isDefaultSpeechVoice(savedVoice) ? DEFAULT_SPEECH_VOICE : savedVoice;
  // Each load is tagged with the request that started it, so loading and a
  // stale error are derived instead of being reset from an effect.
  const [profileRequest, setProfileRequest] = useState(0);
  const [profileResult, setProfileResult] = useState<{
    readonly request: number;
    readonly profiles: SpeechVoiceProfiles;
    readonly error: string | null;
  } | null>(null);
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const preview = useSpeechPlayback(setPreviewError);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads voice profiles from the environment, aborting the request on change or unmount
  useEffect(() => {
    if (!reachable || environmentId === null) return;
    const request = profileRequest;
    // A refresh or leaving the page cancels the load still in flight.
    const controller = new AbortController();
    requestVoiceProfiles(environmentId, controller.signal).then(
      (profiles) => {
        if (!controller.signal.aborted) setProfileResult({ request, profiles, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setProfileResult((previous) => ({
          request,
          profiles: previous?.profiles ?? [],
          error: error instanceof Error ? error.message : m(msg("Could not load profiles.")),
        }));
      },
    );
    return () => controller.abort();
  }, [reachable, environmentId, profileRequest]);
  const loadingProfiles = reachable && profileResult?.request !== profileRequest;
  const profiles = profileResult?.profiles ?? [];
  const profileError = loadingProfiles ? null : (profileResult?.error ?? null);

  const updateOptions = (patch: Partial<SpeechOptions>) =>
    void updateClientSettings({ readAloudOptions: { ...options, ...patch } });

  const savedProfile = profiles.find((profile) => profile.id === voice);
  const voiceLabel =
    voice === DEFAULT_SPEECH_VOICE
      ? gt("Default OmniVoice")
      : (savedProfile?.name ??
        (loadingProfiles ? gt("Loading profiles…") : gt("Missing profile ({voice})", { voice })));

  const unavailableReason =
    environmentId === null || !connected
      ? gt("Connect to an environment to load profiles and preview voices.")
      : !canSpeak
        ? gt(
            "This connection can't use read aloud. It needs permission to operate this environment.",
          )
        : null;

  const { id, title } = useSearchableSetting()("read-aloud-enabled");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={enabled ? `${voiceLabel} · ${options.speed}×` : gt("Read aloud off")}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void updateClientSettings({ readAloudEnabled: checked })}
          aria-label={gt("Read responses aloud")}
        />
      }
    >
      <SettingsRow
        title={gt("Voice profile")}
        description={gt(
          "Profiles come from VoiceStudio on lan-party. The environment that hosts a thread must reach it over Tailscale.",
        )}
        status={unavailableReason ?? profileError}
        control={
          <div className="flex items-center gap-2">
            <Select
              value={voice}
              onValueChange={(value) => {
                if (value !== null) void updateClientSettings({ readAloudVoice: value });
              }}
              disabled={!reachable || loadingProfiles}
            >
              <SelectTrigger size="sm" className="w-full sm:w-48" aria-label={gt("Voice profile")}>
                <SelectValue>{voiceLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={DEFAULT_SPEECH_VOICE}>{gt("Default OmniVoice")}</SelectItem>
                {profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
                {voice !== DEFAULT_SPEECH_VOICE && savedProfile === undefined ? (
                  <SelectItem value={voice} disabled>
                    <T>
                      Missing profile (<Var>{voice}</Var>)
                    </T>
                  </SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              disabled={!reachable || loadingProfiles}
              onClick={() => setProfileRequest((count) => count + 1)}
            >
              <T>Refresh</T>
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={gt("Speaking speed")}
        description={gt("1× is normal speed, from 0.25× to 4×.")}
        control={
          <DraftInput
            label={gt("Speaking speed")}
            type="number"
            inputMode="decimal"
            value={String(options.speed)}
            parse={numberIn(0.25, 4, {}, (speed) => updateOptions({ speed }))}
          />
        }
      />
      <SettingsRow
        title={gt("Language")}
        description={gt(
          "A code such as en, es, or ja guides pronunciation. It does not translate the response.",
        )}
        control={
          <DraftInput
            label={gt("Speech language")}
            value={options.language}
            placeholder={gt("Automatic", { $context: "detect the speech language automatically" })}
            className="w-36"
            parse={(draft) =>
              draft.length <= 20
                ? { ok: true, commit: () => updateOptions({ language: draft }) }
                : { ok: false }
            }
          />
        }
      />
      {ATTRIBUTES.map(({ key, title, label, values }) => (
        <SettingsRow
          key={key}
          title={messages(title)}
          description={
            key === "gender"
              ? gt("Optional. A cloned profile can override attributes that conflict with it.")
              : undefined
          }
          control={
            <Select
              value={options[key] || "default"}
              onValueChange={(value) => {
                if (value !== null) updateOptions({ [key]: value === "default" ? "" : value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-48" aria-label={messages(label)}>
                <SelectValue>
                  {options[key]
                    ? messages(ATTRIBUTE_VALUE_LABELS[options[key]])
                    : gt("Default", { $context: "marks the default option" })}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="default">
                  <T context="marks the default option">Default</T>
                </SelectItem>
                {values.map((value) => (
                  <SelectItem key={value} value={value}>
                    {messages(ATTRIBUTE_VALUE_LABELS[value])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ))}
      <SettingsRow
        title={gt("Whisper", { $context: "read-aloud setting, speak in a whisper" })}
        control={
          <Switch
            checked={options.whisper}
            onCheckedChange={(whisper) => updateOptions({ whisper })}
            aria-label={gt("Whisper", { $context: "read-aloud setting, speak in a whisper" })}
          />
        }
      />
      <AdvancedVoiceSettings options={options} updateOptions={updateOptions} />
      <SettingsRow
        title={gt("Preview voice", { $context: "verb, hear the read-aloud voice" })}
        description={gt(
          "Speaks this text as written. VoiceStudio can take about 25 seconds to load on its first request.",
        )}
        status={previewError}
        control={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-96">
            <div className="min-w-0 flex-1">
              <Input
                aria-label={gt("Voice preview text")}
                value={previewText}
                maxLength={4000}
                onChange={(event) => setPreviewText(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!reachable || (preview.state === "idle" && previewText.trim() === "")}
              onClick={() => {
                if (preview.state !== "idle" || environmentId === null) {
                  preview.stop();
                  return;
                }
                setPreviewError(null);
                void preview.play((signal) =>
                  requestSpeechAudio(
                    environmentId,
                    { text: previewText.trim(), voice, options, verbatim: true },
                    signal,
                  ),
                );
              }}
            >
              {preview.state === "loading"
                ? gt("Cancel")
                : preview.state === "playing"
                  ? gt("Stop", { $context: "stop playing the voice preview" })
                  : gt("Preview", { $context: "verb, play the voice preview" })}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={gt("Reset voice")}
        description={gt(
          "Returns the profile and every voice setting to its default. Read aloud stays on or off.",
        )}
        control={
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void updateClientSettings({
                readAloudVoice: DEFAULT_SPEECH_VOICE,
                readAloudOptions: DEFAULT_SPEECH_OPTIONS,
              })
            }
          >
            <T context="verb, reset the voice settings">Reset</T>
          </Button>
        }
      />
    </FoldedSettingsSection>
  );
}

function AdvancedVoiceSettings({
  options,
  updateOptions,
}: {
  options: SpeechOptions;
  updateOptions: (patch: Partial<SpeechOptions>) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-4 text-left text-sm text-foreground/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <T>Advanced voice settings</T>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <SettingsRow
          title={gt("Seed", { $context: "random seed for voice generation" })}
          description={gt(
            "Blank uses VoiceStudio's sampling. A fixed seed makes settings easier to compare.",
          )}
          control={
            <DraftInput
              label={gt("Voice seed")}
              type="number"
              inputMode="numeric"
              value={options.seed === null ? "" : String(options.seed)}
              placeholder={gt("Automatic", { $context: "no fixed voice seed" })}
              parse={numberIn(
                0,
                2_147_483_647,
                { integer: true, blank: () => updateOptions({ seed: null }) },
                (seed) => updateOptions({ seed }),
              )}
            />
          }
        />
        <SettingsRow
          title={gt("Generation steps")}
          description={gt("16 is the default and 32 the quality preset. More steps take longer.")}
          control={
            <DraftInput
              label={gt("Generation steps")}
              type="number"
              inputMode="numeric"
              value={String(options.steps)}
              parse={numberIn(1, 128, { integer: true }, (steps) => updateOptions({ steps }))}
            />
          }
        />
        <SettingsRow
          title={gt("Guidance", { $context: "how closely voice generation follows the voice" })}
          description={gt("How strongly the model follows the voice. The default is 2.")}
          control={
            <DraftInput
              label={gt("Voice guidance")}
              type="number"
              inputMode="decimal"
              value={String(options.guidance)}
              parse={numberIn(0.1, 20, {}, (guidance) => updateOptions({ guidance }))}
            />
          }
        />
      </CollapsiblePanel>
    </Collapsible>
  );
}
