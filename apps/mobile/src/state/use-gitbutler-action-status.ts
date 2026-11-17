import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import {
  gitButlerActionStatus,
  gitButlerChangeRequestLookup,
  gitButlerLinkedBranch,
} from "@t3tools/client-runtime/state/vcs";

import { useEnvironmentQuery } from "./query";
import { vcsEnvironment } from "./vcs";

/** Status as the thread's GitButler branch sees it, including that branch's own change request. */
export function useGitButlerActionStatus(input: {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly cwd: string | null | undefined;
  readonly status: VcsStatusResult | null;
  readonly linkedBranch: string | null | undefined;
}) {
  const branch = gitButlerLinkedBranch(input.status, input.linkedBranch);
  const query = useEnvironmentQuery(
    input.environmentId && input.cwd && branch !== null
      ? vcsEnvironment.gitButlerBranchChangeRequest({
          environmentId: input.environmentId,
          input: { cwd: input.cwd, branch },
        })
      : null,
  );
  return gitButlerActionStatus(
    input.status,
    input.linkedBranch,
    gitButlerChangeRequestLookup(query),
  );
}
