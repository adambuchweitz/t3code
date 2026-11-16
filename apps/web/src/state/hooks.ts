import { createHooksEnvironmentAtoms } from "@t3tools/client-runtime/state/hooks";

import { connectionAtomRuntime } from "../connection/runtime";

export const hooksEnvironment = createHooksEnvironmentAtoms(connectionAtomRuntime);
