import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadFocusedHookPayload } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../state/environments";
import { hooksEnvironment } from "../state/hooks";
import { useAtomCommand } from "../state/use-atom-command";
import { useFocusedReport } from "./useFocusedReport";

type FocusedThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "projectId" | "title" | "branch" | "worktreePath"
>;

const nonEmpty = (value: string | null) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Focus goes to this client's own server, so its local subscribers hear about remote threads
 * too. A client without one, such as the hosted web app, reports to the thread's environment.
 */
export function threadFocusReport(
  thread: FocusedThread,
  primaryEnvironmentId: EnvironmentId | null,
): { readonly environmentId: EnvironmentId; readonly input: ThreadFocusedHookPayload } {
  return {
    environmentId: primaryEnvironmentId ?? thread.environmentId,
    input: {
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      branch: nonEmpty(thread.branch),
      worktreePath: nonEmpty(thread.worktreePath),
    },
  };
}

/** A title change alone is not a new focus; a branch or worktree appearing later is. */
export const threadFocusReportKey = ({
  environmentId,
  input,
}: ReturnType<typeof threadFocusReport>) => [
  environmentId,
  input.environmentId,
  input.threadId,
  input.branch,
  input.worktreePath,
];

/** Reports the thread on screen while this window has focus. */
export function useThreadFocusReporter(thread: FocusedThread | null): void {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const report = thread === null ? null : threadFocusReport(thread, primaryEnvironmentId);
  const canReport = useAtomValue(
    hooksEnvironment.reportThreadFocused.permissionAtom(report?.environmentId ?? null),
  );
  const send = useAtomCommand(hooksEnvironment.reportThreadFocused, "thread focus hook report");
  useFocusedReport(canReport ? report : null, threadFocusReportKey, (value) =>
    send(value).then((result) => result._tag === "Success"),
  );
}
