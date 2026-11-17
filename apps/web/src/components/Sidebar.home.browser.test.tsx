import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  homeShell: null as unknown,
}));

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const primaryServerConfigAtom = Atom.make<ServerConfig | null>(null).pipe(Atom.keepAlive);
  return {
    ...actual,
    primaryServerConfigAtom,
    primaryServerSettingsAtom: Atom.make(
      (get) => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
    ),
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: ((ref: { environmentId: string; threadId: string } | null) =>
    ref !== null && scopedThreadKey(ref as never) === scopedThreadKey(homeRef)
      ? state.homeShell
      : null) as never,
}));

import { act, render } from "../../test/render";
import { appAtomRegistry, AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { primaryServerConfigAtom as mockedPrimaryServerConfigAtom } from "../state/server";
import { useUiStateStore } from "../uiStateStore";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

// The mock above replaces the derived atom with a writable one the test can seed.
const primaryServerConfigAtom = mockedPrimaryServerConfigAtom as Atom.Writable<ServerConfig | null>;

const environmentId = EnvironmentId.make("environment-home");
const homeThreadId = ThreadId.make("thread-home");
const homeRef = scopeThreadRef(environmentId, homeThreadId);
const NOW = DateTime.makeUnsafe("2026-10-21T09:00:00.000Z");

function completedHomeShell(): OrchestrationV2ThreadShell {
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id: homeThreadId,
    projectId: ProjectId.make("project-home"),
    title: "Home",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: homeThreadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: RunId.make("run-home"),
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    latestRunRequestedAt: NOW,
    latestRunStartedAt: NOW,
    latestRunCompletedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
}

// The sidebar reads only the environment, the Home settings and the workspace root.
function serverConfig(homeThreadId: ThreadId | null): ServerConfig {
  return {
    environment: {
      environmentId,
      label: "This device",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      home: { ...DEFAULT_SERVER_SETTINGS.home, threadId: homeThreadId },
    },
    homeWorkspaceRoot: "/srv/home",
  } as unknown as ServerConfig;
}

function setup() {
  // This server does not track visits, so the browser-local watermark decides what is unseen.
  const { lastVisitedAt: _serverLastVisitedAt, ...shell } = completedHomeShell();
  state.homeShell = presentThreadShell(environmentId, shell as OrchestrationV2ThreadShell);
  useUiStateStore.setState({
    threadLastVisitedAtById: { [scopedThreadKey(homeRef)]: "2026-10-21T08:00:00.000Z" },
  });
  appAtomRegistry.set(primaryServerConfigAtom, serverConfig(homeThreadId));
  return {
    [Symbol.dispose]() {
      appAtomRegistry.set(primaryServerConfigAtom, null);
    },
  };
}

const ui = (
  <AppAtomRegistryProvider>
    <SidebarProvider defaultOpen>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  </AppAtomRegistryProvider>
);

it("shows the current Home thread with its status and opens it", async () => {
  using _env = setup();
  await using screen = await render(ui, { router: "/" });

  const row = screen.getByRole("button", { name: "Home, Done" });
  await expect.element(row).toBeVisible();

  // Visiting Home clears the unseen completion, so the status leaves the row.
  await act(() =>
    useUiStateStore
      .getState()
      .markThreadVisited(scopedThreadKey(homeRef), "2026-10-21T09:30:00.000Z"),
  );
  await expect.element(screen.getByRole("button", { name: "Home", exact: true })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Home", exact: true }));
  await expect
    .poll(() => screen.router?.state.location.pathname)
    .toBe(`/${environmentId}/${homeThreadId}`);
});

it("has no Home row without a current Home thread", async () => {
  using _env = setup();
  appAtomRegistry.set(primaryServerConfigAtom, serverConfig(null));
  await using screen = await render(ui, { router: "/" });
  await expect.element(screen.getByRole("combobox", { name: "Search threads" })).toBeVisible();
  expect(screen.container.querySelector('[data-testid="sidebar-home-row"]')).toBeNull();
});
