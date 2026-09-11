/**
 * Plays a streamed mp3 response as it arrives. Uses MediaSource when the
 * browser can stream mp3 (Chromium and Firefox); otherwise it buffers the
 * whole response into an object URL before playing, matching the old behavior.
 *
 * @module web/audioStreamPlayer
 */

export interface AudioPlayback {
  /** Resolves when playback ends, rejects when it fails. */
  readonly finished: Promise<void>;
  /** Stops playback immediately and resolves `finished`. */
  readonly stop: () => void;
}

function supportsStreamingMp3(): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  } catch {
    return false;
  }
}

function makePlaybackState(
  audio: HTMLAudioElement,
  cleanup: () => void,
): {
  readonly finished: Promise<void>;
  readonly stop: () => void;
  readonly finish: () => void;
  readonly fail: (error: unknown) => void;
  readonly isSettled: () => boolean;
} {
  let settled = false;
  let resolveFinished!: () => void;
  let rejectFinished!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  // The caller may only listen to `finished` on some paths; never let an
  // ignored rejection surface as an unhandled rejection.
  finished.catch(() => {});

  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveFinished();
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectFinished(error);
  };
  const stop = () => {
    if (!settled) {
      settled = true;
      audio.pause();
      cleanup();
      resolveFinished();
    }
  };

  return { finished, stop, finish, fail, isSettled: () => settled };
}

async function playBuffered(response: Response): Promise<AudioPlayback> {
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const state = makePlaybackState(audio, () => URL.revokeObjectURL(url));
  audio.addEventListener("ended", state.finish);
  audio.addEventListener("error", () => state.fail(new Error("Could not play the response audio.")));
  try {
    await audio.play();
  } catch (error) {
    state.fail(error);
    throw error;
  }
  return { finished: state.finished, stop: state.stop };
}

async function playStreamed(response: Response): Promise<AudioPlayback> {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audio = new Audio(url);
  const state = makePlaybackState(audio, () => {
    URL.revokeObjectURL(url);
    audio.removeAttribute("src");
  });

  let stopRequested = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stop = () => {
    stopRequested = true;
    void reader?.cancel().catch(() => {});
    state.stop();
  };

  audio.addEventListener("ended", state.finish);
  audio.addEventListener("error", () => state.fail(new Error("Could not play the response audio.")));

  await new Promise<void>((resolve) => {
    if (mediaSource.readyState === "open") {
      resolve();
      return;
    }
    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
  });
  if (state.isSettled()) {
    return { finished: state.finished, stop };
  }

  const buffer = mediaSource.addSourceBuffer("audio/mpeg");
  buffer.mode = "sequence";

  const queue: Uint8Array[] = [];
  let appending = false;
  let streamDone = false;

  const flush = () => {
    if (state.isSettled() || appending || buffer.updating) return;
    const chunk = queue.shift();
    if (!chunk) {
      if (streamDone && mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          // The element already ended or errored; nothing to close.
        }
      }
      return;
    }
    appending = true;
    try {
      // Streamed chunks are plain ArrayBuffer-backed; the lib types only widen
      // them to ArrayBufferLike.
      buffer.appendBuffer(chunk as BufferSource);
    } catch (error) {
      appending = false;
      state.fail(error);
    }
  };

  buffer.addEventListener("updateend", () => {
    appending = false;
    flush();
  });

  const readStream = async () => {
    if (!response.body) {
      state.fail(new Error("The response had no audio stream."));
      return;
    }
    reader = response.body.getReader();
    try {
      while (!stopRequested) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          queue.push(value);
          flush();
        }
      }
      streamDone = true;
      flush();
    } catch (error) {
      if (!stopRequested) {
        state.fail(error instanceof Error ? error : new Error("Read-aloud stream failed."));
      }
    }
  };
  void readStream();

  // The element plays as soon as the first buffer is appended.
  void audio.play().catch((error) => state.fail(error));

  return { finished: state.finished, stop };
}

export async function playAudioStream(response: Response): Promise<AudioPlayback> {
  return supportsStreamingMp3() ? playStreamed(response) : playBuffered(response);
}
