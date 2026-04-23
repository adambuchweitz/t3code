import { describe, expect, it } from "vitest";

import { summarizeDesktopMemoryTelemetry } from "./memoryTelemetry.ts";

describe("summarizeDesktopMemoryTelemetry", () => {
  it("aggregates Electron process metrics by type and keeps the largest processes first", () => {
    const snapshot = summarizeDesktopMemoryTelemetry({
      browserProcessPid: 101,
      backendPid: 202,
      uptimeSeconds: 120,
      windowCount: 2,
      appMetrics: [
        {
          pid: 11,
          type: "Browser",
          memory: {
            workingSetSize: 100,
            peakWorkingSetSize: 140,
            privateBytes: 90,
          },
        },
        {
          pid: 22,
          type: "Tab",
          memory: {
            workingSetSize: 300,
            peakWorkingSetSize: 320,
            privateBytes: 240,
          },
        },
        {
          pid: 33,
          type: "Tab",
          memory: {
            workingSetSize: 200,
            peakWorkingSetSize: 260,
            privateBytes: 170,
          },
        },
      ],
    });

    expect(snapshot.processCount).toBe(3);
    expect(snapshot.totalWorkingSetSizeKiB).toBe(600);
    expect(snapshot.byType).toEqual({
      Browser: {
        count: 1,
        workingSetSizeKiB: 100,
      },
      Tab: {
        count: 2,
        workingSetSizeKiB: 500,
      },
    });
    expect(snapshot.topProcesses.map((entry) => entry.pid)).toEqual([22, 33, 11]);
  });
});
