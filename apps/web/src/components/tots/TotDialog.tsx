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
  type TotJob,
  type TotVoice,
} from "@t3tools/contracts";
import { useState } from "react";

import { useThreadShells } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { readTotForThread, useTotEntries, type TotEntry } from "~/state/tots";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { TOT_CHARACTERS, TotCharacter, totCharacter } from "./TotCharacter";
import { closeTotDialog, totDialogTargetAtom } from "./totDialogState";
import { suggestTotCharacterIndex, TOT_VOICE_OPTIONS } from "./tots.logic";

const MAX_PICKABLE_THREADS = 40;

export function TotDialogHost() {
  // Keeps the Tot subscriptions alive for the whole app, so menus and the header can read them.
  useTotEntries();
  const target = useAtomValue(totDialogTargetAtom);
  if (target === null) return null;
  if (target.kind === "pick-thread") return <PickThreadTotDialog />;
  const existing = readTotForThread(target.threadRef);
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
          <DialogTitle>Which thread should become a Tot?</DialogTitle>
          <DialogDescription>
            Its history and automations carry on. You can turn it back at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select value={threadKey} onValueChange={(value) => setThreadKey(value)}>
            <SelectTrigger aria-label="Thread">
              <SelectValue>{() => "Choose a recent thread"}</SelectValue>
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
  const [charter, setCharter] = useState(tot?.charter ?? "");
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
      description: error instanceof Error ? error.message : "Try again.",
    });
  };

  const save = async () => {
    setSaving(true);
    const fields = { name: savedName, nameEnabled, character, job, voice };
    const result = tot
      ? await updateTot({
          environmentId,
          // Left out when untouched, so saving a name can't undo a charter approved elsewhere.
          input: { id: tot.id, ...fields, ...(charter === tot.charter ? {} : { charter }) },
        })
      : await adoptTot({
          environmentId,
          input: { threadId: threadRef.threadId, ...fields, charter },
        });
    setSaving(false);
    if (result._tag === "Success") {
      closeTotDialog();
      return;
    }
    fail(tot ? "Couldn't save the Tot" : "Couldn't make the Tot", result);
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
    fail("Couldn't turn it back into a thread", result);
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
          <DialogTitle>{tot ? `Edit ${existing?.displayName}` : "Make this a Tot"}</DialogTitle>
          <DialogDescription>
            {tot
              ? "Changes to its job, voice and charter apply from its next turn."
              : "Its history and automations carry on. From its next turn it knows its job, voice and charter."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            <div className="grid gap-2">
              <Label>Character</Label>
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
                {TOT_CHARACTERS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-label={option.label}
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
                <Label htmlFor="tot-name">Name</Label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Use its own name
                  <Switch
                    aria-label="Use its own name"
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
                <p className="text-xs text-muted-foreground">It'll go by its project's name.</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Job</Label>
              <ToggleGroup
                aria-label="Job"
                variant="segmented"
                value={[job]}
                onValueChange={(next) => {
                  if (next[0] === "manager" || next[0] === "hands_on") setJob(next[0]);
                }}
              >
                <Toggle value="manager">Project manager</Toggle>
                <Toggle value="hands_on">Hands-on</Toggle>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                A steer for the Tot, not a lock. It can still run the odd command either way.
              </p>
            </div>
            <div className="grid gap-2">
              <Label>Voice</Label>
              <ToggleGroup
                aria-label="Voice"
                variant="segmented"
                value={[voice]}
                onValueChange={(next) => {
                  const picked = TOT_VOICE_OPTIONS.find((option) => option.value === next[0]);
                  if (picked) setVoice(picked.value);
                }}
              >
                {TOT_VOICE_OPTIONS.map((option) => (
                  <Toggle key={option.value} value={option.value}>
                    {option.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                "{TOT_VOICE_OPTIONS.find((option) => option.value === voice)?.sample}" Commits and
                PRs always stay plain.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tot-charter">Charter</Label>
              <Textarea
                id="tot-charter"
                value={charter}
                rows={6}
                maxLength={TOT_CHARTER_MAX_LENGTH}
                placeholder={
                  "What it looks after, the rules it must follow, and what matters right now.\nThe Tot can suggest changes for you to approve."
                }
                onChange={(event) => setCharter(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground">
                {tot?.charterProposal && charter !== tot.charter
                  ? "Saving this dismisses the change the Tot proposed."
                  : "Sent to the Tot on every turn, so shorter is better."}
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
              Turn back into a thread
            </Button>
          ) : null}
          <Button variant="ghost" disabled={saving} onClick={closeTotDialog}>
            Cancel
          </Button>
          <Button
            disabled={saving || !canOperate || (nameEnabled && trimmedName.length === 0)}
            onClick={() => void save()}
          >
            {tot ? "Save" : "Make it a Tot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
