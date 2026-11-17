import { describe, expect, it, vi } from "vite-plus/test";

import type { AudioPlayback } from "./audioStreamPlayer";
import {
  createSpeechPlayback,
  type SpeechLoader,
  type SpeechPlaybackState,
} from "./speechPlayback";

function deferred<A>() {
  let resolve: (value: A) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** A request that settles only when told to, and rejects on abort as fetch does. */
function pendingLoad() {
  const stream = new ReadableStream<Uint8Array>();
  let signal: AbortSignal | undefined;
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const load: SpeechLoader = (received) => {
    signal = received;
    return new Promise((onResolve, onReject) => {
      resolve = () => onResolve(stream);
      reject = onReject;
      received.addEventListener("abort", () => onReject(received.reason), { once: true });
    });
  };
  return {
    load,
    signal: () => signal,
    resolve: () => resolve(),
    fail: (message: string) => reject(new Error(message)),
  };
}

function harness() {
  const states: SpeechPlaybackState[] = [];
  const waiters: Array<{ readonly state: SpeechPlaybackState; readonly resolve: () => void }> = [];
  /** Resolves when the controller next reports `state`. */
  const reaches = (state: SpeechPlaybackState) =>
    new Promise<void>((resolve) => waiters.push({ state, resolve }));
  const onError = vi.fn<(message: string) => void>();
  const players: Array<{
    readonly signal: AbortSignal;
    readonly stop: ReturnType<typeof vi.fn>;
    readonly end: () => void;
    readonly fail: (error: Error) => void;
  }> = [];
  const playback = createSpeechPlayback({
    onStateChange: (state) => {
      states.push(state);
      for (const waiter of waiters.splice(0)) {
        if (waiter.state === state) waiter.resolve();
        else waiters.push(waiter);
      }
    },
    onError,
    playStream: async (_stream, signal): Promise<AudioPlayback> => {
      const { promise, resolve, reject } = deferred<void>();
      const stop = vi.fn(() => resolve());
      players.push({ signal, stop, end: resolve, fail: reject });
      return { finished: promise, stop };
    },
  });
  return { playback, states, onError, players, reaches };
}

describe("speech playback cancellation", () => {
  it("aborts the request when stopped while speech is being prepared", async () => {
    const { playback, states, onError, players } = harness();
    const request = pendingLoad();

    const reading = playback.play(request.load);
    expect(states).toEqual(["loading"]);
    playback.stop();
    await reading;

    expect(request.signal()?.aborted).toBe(true);
    expect(states).toEqual(["loading", "idle"]);
    expect(onError).not.toHaveBeenCalled();
    expect(players).toEqual([]);
  });

  it("cancels the audio body of a request that answered after it was stopped", async () => {
    const { playback, onError, players } = harness();
    // A transport that cannot stop the request still has its late audio discarded.
    const stream = new ReadableStream<Uint8Array>();
    const cancel = vi.spyOn(stream, "cancel");
    const { promise, resolve } = deferred<ReadableStream<Uint8Array>>();

    const reading = playback.play(() => promise);
    playback.stop();
    resolve(stream);
    await reading;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(players).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stops playing audio and aborts the player's body", async () => {
    const { playback, states, onError, players, reaches } = harness();
    const request = pendingLoad();

    const playing = reaches("playing");
    const reading = playback.play(request.load);
    request.resolve();
    await playing;

    playback.stop();
    await reading;
    expect(players[0]?.stop).toHaveBeenCalledTimes(1);
    expect(players[0]?.signal.aborted).toBe(true);
    expect(states.at(-1)).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
  });

  it("supersedes an older read without reporting its failure", async () => {
    const { playback, states, onError, players, reaches } = harness();
    const older = pendingLoad();
    const newer = pendingLoad();

    const first = playback.play(older.load);
    const second = playback.play(newer.load);
    await first;
    expect(older.signal()?.aborted).toBe(true);
    expect(newer.signal()?.aborted).toBe(false);

    const playing = reaches("playing");
    newer.resolve();
    await playing;
    expect(players).toHaveLength(1);
    players[0]?.end();
    await second;
    expect(states.at(-1)).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a real failure of the current read once", async () => {
    const { playback, states, onError } = harness();
    const request = pendingLoad();

    const reading = playback.play(request.load);
    request.fail("Could not reach VoiceStudio on lan-party.");
    await reading;

    expect(onError).toHaveBeenCalledExactlyOnceWith("Could not reach VoiceStudio on lan-party.");
    expect(states).toEqual(["loading", "idle"]);
  });

  it("closes the audio request when the player fails, reporting that failure once", async () => {
    const { playback, onError, players, reaches } = harness();
    const request = pendingLoad();

    const playing = reaches("playing");
    const reading = playback.play(request.load);
    request.resolve();
    await playing;
    players[0]?.fail(new Error("Could not play the response audio."));
    await reading;

    // The player's body is cancelled, so the environment stops streaming VoiceStudio audio.
    expect(players[0]?.signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Could not play the response audio.");

    // The next read starts clean and is not cut short by the failed one.
    const next = pendingLoad();
    const nextPlaying = reaches("playing");
    const nextReading = playback.play(next.load);
    next.resolve();
    await nextPlaying;
    expect(players[1]?.signal.aborted).toBe(false);
    players[1]?.end();
    await nextReading;
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
