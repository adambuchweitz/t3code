import { msg } from "gt-react";

import { m } from "../i18n/messages";

/**
 * Plays streamed mp3 as it arrives. MediaSource streams it where the browser
 * supports mp3 there (Chromium, Firefox); elsewhere the whole body is buffered
 * into an object URL first.
 *
 * @module web/audioStreamPlayer
 */

export interface AudioPlayback {
  /** Resolves when playback ends or is stopped; rejects when it fails. */
  readonly finished: Promise<void>;
  readonly stop: () => void;
}

function supportsStreamingMp3(): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  } catch {
    return false;
  }
}

function makePlaybackState(audio: HTMLAudioElement, cleanup: () => void) {
  let settled = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // Some callers only await `finished` on some paths; an ignored failure must
  // not surface as an unhandled rejection.
  finished.catch(() => {});
  const settle = (outcome: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    outcome();
  };
  return {
    finished,
    finish: () => settle(resolveFinished),
    fail: (error: unknown) => settle(() => rejectFinished(error)),
    stop: () =>
      settle(() => {
        audio.pause();
        resolveFinished();
      }),
    isSettled: () => settled,
  };
}

const playbackError = () => new Error(m(msg("Could not play the response audio.")));

async function playBuffered(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<AudioPlayback> {
  // Buffering can take the whole synthesis; a stop meanwhile cancels the body.
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "audio/mpeg" }));
  const audio = new Audio(url);
  const state = makePlaybackState(audio, () => URL.revokeObjectURL(url));
  audio.addEventListener("ended", state.finish);
  audio.addEventListener("error", () => state.fail(playbackError()));
  try {
    await audio.play();
  } catch (error) {
    state.fail(error);
    throw error;
  }
  return { finished: state.finished, stop: state.stop };
}

async function playStreamed(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<AudioPlayback> {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audio = new Audio(url);
  const state = makePlaybackState(audio, () => {
    URL.revokeObjectURL(url);
    audio.removeAttribute("src");
  });
  const reader = stream.getReader();
  const stop = () => {
    void reader.cancel().catch(() => {});
    state.stop();
  };
  // Covers a stop before the caller holds this playback, while MediaSource opens.
  signal.addEventListener("abort", stop, { once: true });
  audio.addEventListener("ended", state.finish);
  audio.addEventListener("error", () => state.fail(playbackError()));

  await new Promise<void>((resolve) => {
    if (mediaSource.readyState === "open") resolve();
    else mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
  });
  if (state.isSettled()) return { finished: state.finished, stop };

  const buffer = mediaSource.addSourceBuffer("audio/mpeg");
  buffer.mode = "sequence";
  const queue: Uint8Array[] = [];
  let streamDone = false;

  const flush = () => {
    if (state.isSettled() || buffer.updating) return;
    const chunk = queue.shift();
    if (chunk === undefined) {
      if (streamDone && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          // The element already ended or failed; there is nothing left to close.
        }
      }
      return;
    }
    try {
      // Fetched chunks are ArrayBuffer-backed; the DOM types only widen them.
      buffer.appendBuffer(chunk as BufferSource);
    } catch (error) {
      state.fail(error);
    }
  };
  buffer.addEventListener("updateend", flush);

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || state.isSettled()) break;
        if (value.byteLength > 0) {
          queue.push(value);
          flush();
        }
      }
      streamDone = true;
      flush();
    } catch (error) {
      state.fail(error instanceof Error ? error : new Error(m(msg("The response audio stopped."))));
    }
  })();

  // The element starts as soon as the first chunk is appended.
  void audio.play().catch((error: unknown) => state.fail(error));
  return { finished: state.finished, stop };
}

/** Aborting `signal` stops playback and cancels the audio body, as `stop` does. */
export function playAudioStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<AudioPlayback> {
  return supportsStreamingMp3() ? playStreamed(stream, signal) : playBuffered(stream, signal);
}
