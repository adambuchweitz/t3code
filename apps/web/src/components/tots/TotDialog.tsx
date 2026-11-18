import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isListedThreadLineage,
  TOT_CHARTER_MAX_LENGTH,
  type ScopedThreadRef,
  EMPTY_TOT_WAKE_SETTINGS,
  type TotCrewModel,
  type TotJob,
  type TotVoice,
  type TotWakeSettings,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { useThreadShells } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useTotEntries, type TotEntry } from "~/state/tots";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { TOT_CHARACTERS, totCharacter } from "@t3tools/client-runtime/tots/character";
import { TotCharacter } from "./TotCharacter";
import { TotCharterEditor } from "./TotCharterEditor";
import { TotCrewPanel } from "./TotCrewPanel";
import { TotWakesPanel } from "./TotWakesPanel";
import { closeTotDialog, totDialogTargetAtom } from "./totDialogState";
import { suggestTotCharacterIndex, TOT_VOICE_OPTIONS } from "@t3tools/client-runtime/tots/logic";

const MAX_PICKABLE_THREADS = 40;

export function TotDialogHost() {
  // Keeps the Tot subscriptions alive for the whole app, so menus and the header can read them.
  const entries = useTotEntries();
  const target = useAtomValue(totDialogTargetAtom);
  if (target === null) return null;
  if (target.kind === "pick-thread") return <PickThreadTotDialog />;
  const { environmentId, threadId } = target.threadRef;
  const existing =
    entries.find((entry) => entry.environmentId === environmentId && entry.threadId === threadId) ??
    null;
  return (
    <TotFormDialog
      key={`${target.threadRef.environmentId}:${target.threadRef.threadId}`}
      threadRef={target.threadRef}
      existing={existing}
    />
  );
}

function PickThreadTotDialog() {
  const entries = useTotEntries();
  const shells = useThreadShells();
  const gt = useGT();
  const [threadKey, setThreadKey] = useState<string | null>(null);
  const totKeys = new Set(entries.map((entry) => `${entry.environmentId}:${entry.threadId}`));
  const candidates = shells
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        !totKeys.has(`${thread.environmentId}:${thread.id}`),
    )
    .toSorted((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
    )
    .slice(0, MAX_PICKABLE_THREADS);
  const picked = candidates.find((thread) => `${thread.environmentId}:${thread.id}` === threadKey);
  if (picked) {
    return (
      <TotFormDialog threadRef={scopeThreadRef(picked.environmentId, picked.id)} existing={null} />
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && closeTotDialog()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Which thread should become a Tot?</T>
          </DialogTitle>
          <DialogDescription>
            <T>Its history and automations carry on. You can turn it back at any time.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select value={threadKey} onValueChange={(value) => setThreadKey(value)}>
            <SelectTrigger aria-label={gt("Thread")}>
              <SelectValue>{() => gt("Choose a recent thread")}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((thread) => (
                <SelectItem
                  key={`${thread.environmentId}:${thread.id}`}
                  value={`${thread.environmentId}:${thread.id}`}
                >
                  {thread.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function TotFormDialog(props: {
  readonly threadRef: ScopedThreadRef;
  readonly existing: TotEntry | null;
}) {
  const { threadRef, existing } = props;
  const gt = useGT();
  const m = useMessages();
  const tot = existing?.tot ?? null;
  const [character, setCharacter] = useState(() => {
    if (tot) return tot.character;
    const index = suggestTotCharacterIndex(threadRef.threadId, TOT_CHARACTERS.length);
    return TOT_CHARACTERS[index]!.id;
  });
  const [name, setName] = useState(() => tot?.name ?? totCharacter(character).suggestedName);
  const [nameEdited, setNameEdited] = useState(tot !== null);
  const [nameEnabled, setNameEnabled] = useState(tot?.nameEnabled ?? true);
  const [job, setJob] = useState<TotJob>(tot?.job ?? "manager");
  const [voice, setVoice] = useState<TotVoice>(tot?.voice ?? "toddler");
  // The live Tot can change while this is open, so edits are measured against what it opened with.
  const [opened] = useState(() => ({
    name: tot?.name,
    nameEnabled: tot?.nameEnabled,
    character: tot?.character,
    job: tot?.job,
    voice: tot?.voice,
    charter: tot?.charter ?? "",
    wakeSettings: tot?.wakeSettings ?? EMPTY_TOT_WAKE_SETTINGS,
    crewModels: tot?.crewModels ?? [],
  }));
  const [charter, setCharter] = useState(opened.charter);
  const [wakeSettings, setWakeSettings] = useState<TotWakeSettings>(opened.wakeSettings);
  const [crewModels, setCrewModels] = useState<ReadonlyArray<TotCrewModel>>(opened.crewModels);
  const [section, setSection] = useState<"profile" | "wakes" | "crew">("profile");
  const [saving, setSaving] = useState(false);

  const environmentId = threadRef.environmentId;
  const canOperate = useAtomValue(serverEnvironment.adoptTot.permissionAtom(environmentId));
  const adoptTot = useAtomCommand(serverEnvironment.adoptTot, { reportFailure: false });
  const updateTot = useAtomCommand(serverEnvironment.updateTot, { reportFailure: false });
  const releaseTot = useAtomCommand(serverEnvironment.releaseTot, { reportFailure: false });

  const trimmedName = name.trim();
  // With its name off, a Tot never shows this value, so a cleared field shouldn't block saving.
  const savedName = trimmedName || tot?.name || totCharacter(character).suggestedName;
  const fail = (
    title: string,
    result: Exclude<AtomCommandResult<unknown, unknown>, { readonly _tag: "Success" }>,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : gt("Try again."),
    });
  };

  const save = async () => {
    setSaving(true);
    const result = tot
      ? await updateTot({
          environmentId,
          // Untouched fields stay out, so saving one can't undo a change made elsewhere.
          input: {
            id: tot.id,
            ...(savedName === opened.name ? {} : { name: savedName }),
            ...(nameEnabled === opened.nameEnabled ? {} : { nameEnabled }),
            ...(character === opened.character ? {} : { character }),
            ...(job === opened.job ? {} : { job }),
            ...(voice === opened.voice ? {} : { voice }),
            ...(charter === opened.charter ? {} : { charter }),
            // Identity works: the panels only make a new value when the user changes something.
            ...(wakeSettings === opened.wakeSettings
              ? {}
              : {
                  wakeSettings: {
                    ...wakeSettings,
                    wakeChecks: wakeSettings.wakeChecks.flatMap((check) => {
                      const command = check.command.trim();
                      return command === "" ? [] : [{ ...check, command }];
                    }),
                  },
                }),
            ...(crewModels === opened.crewModels ? {} : { crewModels }),
          },
        })
      : await adoptTot({
          environmentId,
          input: {
            threadId: threadRef.threadId,
            name: savedName,
            nameEnabled,
            character,
            job,
            voice,
            charter,
          },
        });
    setSaving(false);
    if (result._tag === "Success") {
      closeTotDialog();
      return;
    }
    fail(tot ? gt("Couldn't save the Tot") : gt("Couldn't make the Tot"), result);
  };

  const release = async () => {
    if (!tot) return;
    setSaving(true);
    const result = await releaseTot({ environmentId, input: { id: tot.id } });
    setSaving(false);
    if (result._tag === "Success") {
      closeTotDialog();
      return;
    }
    fail(gt("Couldn't turn it back into a thread"), result);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) closeTotDialog();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {tot ? gt("Edit {name}", { name: existing?.displayName ?? "" }) : gt("Make this a Tot")}
          </DialogTitle>
          <DialogDescription>
            {tot
              ? gt("Changes to its job, voice and charter apply from its next turn.")
              : gt(
                  "Its history and automations carry on. From its next turn it knows its job, voice and charter.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {existing ? (
            <div className="mb-5">
              <ToggleGroup
                aria-label={gt("Section", { $context: "Tot settings section" })}
                variant="segmented"
                value={[section]}
                onValueChange={(next) => {
                  if (next[0] === "profile" || next[0] === "wakes" || next[0] === "crew") {
                    setSection(next[0]);
                  }
                }}
              >
                <Toggle value="profile">
                  <T context="Tot settings section, its profile">Tot</T>
                </Toggle>
                <Toggle value="wakes">
                  <T context="Tot settings section, when it wakes up">Wakes</T>
                </Toggle>
                <Toggle value="crew">
                  <T>Crew models</T>
                </Toggle>
              </ToggleGroup>
            </div>
          ) : null}
          {existing && section === "wakes" ? (
            <TotWakesPanel entry={existing} value={wakeSettings} onChange={setWakeSettings} />
          ) : null}
          {existing && section === "crew" ? (
            <TotCrewPanel entry={existing} value={crewModels} onChange={setCrewModels} />
          ) : null}
          <div className={cn("grid gap-5", existing && section !== "profile" && "hidden")}>
            <div className="grid gap-2">
              <Label>
                <T context="the Tot's face and figure">Character</T>
              </Label>
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
                {TOT_CHARACTERS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-label={m(option.label)}
                    aria-pressed={character === option.id}
                    onClick={() => {
                      setCharacter(option.id);
                      if (!nameEdited) setName(option.suggestedName);
                    }}
                    className={cn(
                      "flex items-center justify-center rounded-md border border-transparent p-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                      character === option.id && "border-ring bg-accent",
                    )}
                  >
                    <TotCharacter character={option.id} pose="awake" size={56} />
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="tot-name">
                  <T context="noun, the Tot's name">Name</T>
                </Label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <T>Use its own name</T>
                  <Switch
                    aria-label={gt("Use its own name")}
                    checked={nameEnabled}
                    onCheckedChange={setNameEnabled}
                  />
                </label>
              </div>
              <Input
                id="tot-name"
                value={name}
                maxLength={40}
                disabled={!nameEnabled}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setNameEdited(true);
                }}
              />
              {nameEnabled ? null : (
                <p className="text-xs text-muted-foreground">
                  <T>It'll go by its project's name.</T>
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>
                <T context="the Tot's role">Job</T>
              </Label>
              <ToggleGroup
                aria-label={gt("Job", { $context: "the Tot's role" })}
                variant="segmented"
                value={[job]}
                onValueChange={(next) => {
                  if (next[0] === "manager" || next[0] === "hands_on") setJob(next[0]);
                }}
              >
                <Toggle value="manager">
                  <T>Project manager</T>
                </Toggle>
                <Toggle value="hands_on">
                  <T context="Tot job, does the work itself">Hands-on</T>
                </Toggle>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                <T>A steer for the Tot, not a lock. It can still run the odd command either way.</T>
              </p>
            </div>
            <div className="grid gap-2">
              <Label>
                <T context="how the Tot talks">Voice</T>
              </Label>
              <ToggleGroup
                aria-label={gt("Voice", { $context: "how the Tot talks" })}
                variant="segmented"
                value={[voice]}
                onValueChange={(next) => {
                  const picked = TOT_VOICE_OPTIONS.find((option) => option.value === next[0]);
                  if (picked) setVoice(picked.value);
                }}
              >
                {TOT_VOICE_OPTIONS.map((option) => (
                  <Toggle key={option.value} value={option.value}>
                    {m(option.label)}
                  </Toggle>
                ))}
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                <T>
                  "
                  <Var>{m(TOT_VOICE_OPTIONS.find((option) => option.value === voice)?.sample)}</Var>
                  " Commits and PRs always stay plain.
                </T>
              </p>
            </div>
            <div className="grid gap-2">
              <Label>
                <T context="the Tot's standing instructions">Charter</T>
              </Label>
              <TotCharterEditor
                value={charter}
                ariaLabel={gt("Charter", { $context: "the Tot's standing instructions" })}
                placeholder={gt(
                  "What it looks after, the rules it must follow, and what matters right now.",
                )}
                onChange={setCharter}
              />
              {charter.length > TOT_CHARTER_MAX_LENGTH ? (
                <p className="text-xs text-destructive-foreground" role="alert">
                  {gt(
                    "{count, plural, one {{count} characters over the limit.} other {{count} characters over the limit.}}",
                    { count: charter.length - TOT_CHARTER_MAX_LENGTH },
                  )}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {tot?.charterProposal && charter !== opened.charter
                  ? gt("Saving this dismisses the change the Tot proposed.")
                  : gt("Sent to the Tot on every turn, so shorter is better.")}
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          {tot ? (
            <Button
              variant="ghost-destructive"
              className="sm:mr-auto"
              disabled={saving || !canOperate}
              onClick={() => void release()}
            >
              <T>Turn back into a thread</T>
            </Button>
          ) : null}
          <Button variant="ghost" disabled={saving} onClick={closeTotDialog}>
            <T>Cancel</T>
          </Button>
          <Button
            disabled={
              charter.length > TOT_CHARTER_MAX_LENGTH ||
              saving ||
              !canOperate ||
              (nameEnabled && trimmedName.length === 0) ||
              crewModels.some((row) => row.role.trim() === "")
            }
            onClick={() => void save()}
          >
            {tot ? gt("Save") : gt("Make it a Tot")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
