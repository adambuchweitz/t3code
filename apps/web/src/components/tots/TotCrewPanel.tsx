import { useAtomValue } from "@effect/atom-react";
import type { ProviderInstanceId, ServerProvider, TotCrewModel } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { serverEnvironment } from "~/state/server";
import type { TotEntry } from "~/state/tots";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

export function TotCrewPanel(props: {
  readonly entry: TotEntry;
  readonly value: ReadonlyArray<TotCrewModel>;
  readonly onChange: (next: ReadonlyArray<TotCrewModel>) => void;
}) {
  const { entry, value, onChange } = props;
  const gt = useGT();
  const settings = useEnvironmentSettings(entry.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(entry.environmentId)) ?? EMPTY_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, entry.projectId);
  const fallback = entry.thread?.modelSelection ?? null;
  const replace = (index: number, next: Partial<TotCrewModel>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...next } : row)));

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        <T>
          Tell the Tot which model does what. It picks these when it starts crew threads. The Tot's
          own model is set from its thread, and its wakes run on that model.
        </T>
      </p>
      {value.map((row, index) => {
        const modelOptions = getCustomModelOptionsByInstance(
          settings,
          providers,
          row.instanceId,
          row.model,
        );
        // The picker falls back to its first option's name for a model it doesn't list.
        const listed = modelOptions
          .get(row.instanceId)
          ?.some((option) => option.slug === row.model);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- Roles are edited in place and can repeat.
          <div key={index} className="flex flex-wrap items-center gap-2">
            <div className="min-w-32 flex-1">
              <Input
                aria-label={gt("Crew role")}
                placeholder={gt("Reviews", { $context: "example crew role name" })}
                maxLength={60}
                value={row.role}
                onChange={(event) => replace(index, { role: event.currentTarget.value })}
              />
            </div>
            <ProviderModelPicker
              environmentId={entry.environmentId}
              activeInstanceId={row.instanceId}
              model={row.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptions}
              isComposerOwned={false}
              onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
                replace(index, { instanceId, model })
              }
            />
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={
                row.role ? gt("Remove {role}", { role: row.role }) : gt("Remove this role")
              }
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <Trash2Icon />
            </Button>
            {listed ? null : (
              <p className="w-full text-xs text-warning-foreground">
                <T>
                  Actually set to <Var>{row.model}</Var>, which this machine doesn't list.
                </T>
              </p>
            )}
          </div>
        );
      })}
      <div>
        <Button
          size="xs"
          variant="outline"
          disabled={fallback === null || value.length >= 12}
          onClick={() => {
            if (fallback === null) return;
            onChange([
              ...value,
              { role: "", instanceId: fallback.instanceId, model: fallback.model },
            ]);
          }}
        >
          <PlusIcon />
          <T>Add a role</T>
        </Button>
      </div>
    </div>
  );
}
