import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { createReadAloudMessagesAtom } from "~/lib/readAloudMessages";
import { environmentThreadDetails } from "~/state/threads";

const messagesAtom = Atom.family((key: string) =>
  createReadAloudMessagesAtom(environmentThreadDetails.threadAtom(parseThreadKey(key))).pipe(
    Atom.withLabel(`read-aloud:messages:${key}`),
  ),
);

export function useReadAloudMessages(threadRef: ScopedThreadRef) {
  return useAtomValue(messagesAtom(threadKey(threadRef)));
}
