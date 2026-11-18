import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { type AudioPlayback, playAudioStream } from "./audioStreamPlayer";

export type SpeechPlaybackState = "idle" | "loading" | "playing";

/** Loads audio for one read; aborting `signal` must cancel the request behind it. */
export type SpeechLoader = (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;

interface ActiveRead {
  readonly controller: AbortController;
  playback: AudioPlayback | null;
}

/**
 * One read at a time: a new read or stop aborts the loading request or playing audio. Only the
 * current read reports errors, so a slow or failing older request never surfaces later.
 */
export function createSpeechPlayback(options: {
  readonly onStateChange: (state: SpeechPlaybackState) => void;
  readonly onError: (message: string) => void;
  readonly playStream?: (
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ) => Promise<AudioPlayback>;
}) {
  const playStream = options.playStream ?? playAudioStream;
  let active: ActiveRead | null = null;

  const stop = () => {
    const current = active;
    if (current === null) return;
    active = null;
    current.controller.abort();
    current.playback?.stop();
    options.onStateChange("idle");
  };

  const play = async (load: SpeechLoader) => {
    stop();
    const read: ActiveRead = { controller: new AbortController(), playback: null };
    active = read;
    const { signal } = read.controller;
    options.onStateChange("loading");
    try {
      const stream = await load(signal);
      if (signal.aborted) {
        void stream.cancel().catch(() => {});
        return;
      }
      const playback = await playStream(stream, signal);
      if (signal.aborted) {
        playback.stop();
        return;
      }
      read.playback = playback;
      options.onStateChange("playing");
      await playback.finished;
    } catch (error) {
      if (!signal.aborted) {
        options.onError(error instanceof Error ? error.message : m(msg("Read aloud failed.")));
      }
    } finally {
      // Ending any way, a failed player included, closes the request and its
      // audio body, so the environment stops streaming. After a clean finish
      // the body is already done and this changes nothing.
      read.controller.abort();
      if (active === read) {
        active = null;
        options.onStateChange("idle");
      }
    }
  };

  return { play, stop };
}
