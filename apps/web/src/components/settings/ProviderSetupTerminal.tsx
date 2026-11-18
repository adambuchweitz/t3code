import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
} from "@t3tools/client-runtime/state/terminal";
import {
  ThreadId,
  type EnvironmentId,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, Var } from "gt-react";
import { ExternalLinkIcon, TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport, type TerminalSessionActivity } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import {
  takeFreshSignInUrl,
  type ProviderSetupTerminalAction,
} from "./providerSetupTerminal.logic";
import { SettingsRow } from "./settingsLayout";

// Terminal lists are always read per real thread, so this id keeps setup shells out of them.
const SETUP_THREAD_ID = ThreadId.make("provider-setup-terminal");
const NO_KEYBINDINGS: ResolvedKeybindingsConfig = [];
// Enough to hold a URL that arrives across output chunks.
const URL_SCAN_TAIL_CHARS = 4096;

interface SetupTerminalSession {
  readonly kind: ProviderSetupTerminalAction["kind"];
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly command: string;
  readonly label: string;
  readonly keybindings: ResolvedKeybindingsConfig;
}

export function ProviderSetupTerminalRow({
  environmentId,
  environmentLabel,
  instanceId,
  providerLabel,
  action,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly providerLabel: string;
  readonly action: ProviderSetupTerminalAction;
}) {
  const gt = useGT();
  const cwd = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.cwd ?? null,
  );
  const keybindings = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.keybindings ?? NO_KEYBINDINGS,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  // The command is fixed when the terminal opens, so a provider refresh cannot swap it mid-run.
  const [session, setSession] = useState<SetupTerminalSession | null>(null);
  const install = action.kind === "install";

  return (
    <SettingsRow
      title={
        install
          ? gt("Install", { $context: "settings row for installing a provider" })
          : gt("Account", { $context: "settings row for signing in to a provider" })
      }
      description={
        install
          ? gt("{provider} is not installed on {environment}. Install it from a terminal.", {
              provider: providerLabel,
              environment: environmentLabel,
            })
          : gt("Sign in to {provider} from a terminal on {environment}.", {
              provider: providerLabel,
              environment: environmentLabel,
            })
      }
      control={
        session === null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={cwd === null}
            onClick={() => {
              if (cwd === null) return;
              setSession({
                kind: action.kind,
                environmentId,
                providerInstanceId: instanceId,
                cwd,
                command: action.command,
                label: install
                  ? gt("Install {provider}", { provider: providerLabel })
                  : gt("Sign in to {provider}", { provider: providerLabel }),
                keybindings,
              });
            }}
          >
            <TerminalIcon />
            {install ? gt("Install in terminal") : gt("Sign in with terminal")}
          </Button>
        ) : null
      }
    >
      {session ? (
        <div className="py-2">
          <ProviderSetupTerminalSession
            session={session}
            onCommandFinished={() => {
              // A finished setup clears this row's action, which unmounts the terminal.
              void refreshProviders({ environmentId, input: { instanceId } });
            }}
            onClose={() => {
              setSession(null);
              void refreshProviders({ environmentId, input: { instanceId } });
            }}
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** Opens a disposable PTY on the provider's environment and types the command without running it. */
function ProviderSetupTerminalSession({
  session,
  onCommandFinished,
  onClose,
}: {
  readonly session: SetupTerminalSession;
  readonly onCommandFinished: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const { command, cwd, environmentId, keybindings, kind, label, providerInstanceId } = session;
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const activeGenerationRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const [terminalBaseId] = useState(() => `setup-${randomUUID()}`);
  const [attempt, setAttempt] = useState(0);
  const terminalId = `${terminalBaseId}-${attempt}`;
  const threadRef = scopeThreadRef(environmentId, SETUP_THREAD_ID);
  const [state, setState] = useState<"preparing" | "ready" | "openFailed" | "writeFailed">(
    "preparing",
  );
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const outputScanRef = useRef({
    cursor: INITIAL_TERMINAL_OUTPUT_CURSOR,
    tail: "",
    seenUrls: new Set<string>(),
    openedThisRun: false,
    commandRunning: false,
  });

  // The CLI cannot open a browser on the client's machine, so the client opens what it prints.
  const handleSessionChange = (terminal: TerminalSessionActivity) => {
    const scan = outputScanRef.current;
    const update = readTerminalOutputUpdate(terminal.output, scan.cursor);
    scan.cursor = update.cursor;
    if (kind === "signIn" && update.type !== "none") {
      const text = (update.type === "reset" ? "" : scan.tail) + update.data;
      scan.tail = text.slice(-URL_SCAN_TAIL_CHARS);
      const url = takeFreshSignInUrl(text, scan.seenUrls);
      if (url !== null) {
        setSignInUrl(url);
        if (!scan.openedThisRun) {
          scan.openedThisRun = true;
          void readLocalApi()
            ?.shell.openExternal(url)
            .catch(() => undefined);
        }
      }
    }
    if (terminal.hasRunningSubprocess) {
      scan.commandRunning = true;
    } else if (scan.commandRunning) {
      // A finished login's link has expired; a rerun prints and opens a fresh one.
      scan.commandRunning = false;
      scan.openedThisRun = false;
      setSignInUrl(null);
      onCommandFinished();
    }
  };

  // Serialize open and close so a late open can never leave a shell running after unmount.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the setup PTY on the environment while mounted and closes it on unmount
  useEffect(() => {
    const generation = ++generationRef.current;
    activeGenerationRef.current = generation;
    const isActive = () => activeGenerationRef.current === generation;

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (!isActive()) return;
      const opened = await openTerminal({
        environmentId,
        input: { threadId: SETUP_THREAD_ID, terminalId, cwd, providerInstanceId },
      });
      if (opened._tag !== "Success") {
        if (isActive()) setState("openFailed");
        return;
      }
      if (!isActive()) return;
      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: SETUP_THREAD_ID, terminalId, data: command },
      });
      if (isActive()) setState(wrote._tag === "Success" ? "ready" : "writeFailed");
    });

    return () => {
      if (isActive()) activeGenerationRef.current = null;
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        await closeTerminal({
          environmentId,
          input: { threadId: SETUP_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    terminalId,
    writeTerminal,
  ]);

  const terminalReady = state === "ready" || state === "writeFailed";

  return (
    <div
      data-thread-terminal-drawer
      data-terminal-owner="settings"
      className="overflow-hidden rounded-md border border-border bg-background text-foreground"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <p role="status" className="min-w-0 text-xs text-muted-foreground">
          {state === "writeFailed" ? (
            <T>
              Type{" "}
              <code className="select-all font-mono text-foreground [overflow-wrap:anywhere]">
                <Var>{command}</Var>
              </code>{" "}
              and press Enter.
            </T>
          ) : state === "ready" ? (
            gt("Review the command, then press Enter to run it.")
          ) : state === "openFailed" ? (
            gt("Could not open a terminal on this environment.")
          ) : (
            gt("Opening terminal…")
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {signInUrl !== null ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                void readLocalApi()
                  ?.shell.openExternal(signInUrl)
                  .catch(() => undefined);
              }}
            >
              <ExternalLinkIcon />
              <T>Open sign-in page</T>
            </Button>
          ) : null}
          {state === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setState("preparing");
                setAttempt((value) => value + 1);
              }}
            >
              <T>Retry</T>
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            <T context="verb, close the setup terminal">Close</T>
          </Button>
        </div>
      </div>
      <div className="h-64">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={SETUP_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={label}
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            exclusiveInput={{ onCloseShortcut: onClose }}
            onSessionExited={onClose}
            onSessionChange={handleSessionChange}
            autoFocus
            visible
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
