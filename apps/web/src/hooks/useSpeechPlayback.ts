import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { createSpeechPlayback, type SpeechPlaybackState } from "~/lib/speechPlayback";

/** A component's single read-aloud slot; unmounting cancels whatever it was doing. */
export function useSpeechPlayback(onError: (message: string) => void) {
  const [state, setState] = useState<SpeechPlaybackState>("idle");
  const reportError = useStableCallback(onError);
  const [playback] = useState(() =>
    createSpeechPlayback({ onStateChange: setState, onError: reportError }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the external audio playback when the component unmounts
  useEffect(() => playback.stop, [playback]);
  return { state, play: playback.play, stop: playback.stop };
}
