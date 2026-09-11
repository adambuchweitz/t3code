import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";

import {
  isAutoReadAloudEnabled,
  resetAutoReadAloudForTests,
  setAutoReadAloud,
} from "./readAloudAutoStore";

const refA: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const refB: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-b"),
};

afterEach(() => {
  resetAutoReadAloudForTests();
});

describe("readAloudAutoStore", () => {
  it("defaults to off", () => {
    expect(isAutoReadAloudEnabled(refA)).toBe(false);
  });

  it("tracks modes per thread", () => {
    setAutoReadAloud(refA, true);
    expect(isAutoReadAloudEnabled(refA)).toBe(true);
    expect(isAutoReadAloudEnabled(refB)).toBe(false);
  });

  it("turns a thread back off", () => {
    setAutoReadAloud(refA, true);
    setAutoReadAloud(refA, false);
    expect(isAutoReadAloudEnabled(refA)).toBe(false);
  });
});
