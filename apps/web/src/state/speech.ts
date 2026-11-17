import { createEnvironmentSpeechCommands } from "@t3tools/client-runtime/state/speech";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentSpeech = createEnvironmentSpeechCommands(connectionAtomRuntime);
