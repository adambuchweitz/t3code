const DESKTOP_MEMORY_TOP_PROCESS_LIMIT = 8;

interface DesktopProcessMetricLike {
  readonly pid: number;
  readonly type: string;
  readonly memory: {
    readonly workingSetSize: number;
    readonly peakWorkingSetSize: number;
    readonly privateBytes?: number;
  };
}

interface ProcessTypeSummary {
  readonly count: number;
  readonly workingSetSizeKiB: number;
}

export interface DesktopMemoryTelemetrySnapshot {
  readonly browserProcessPid: number;
  readonly backendPid: number | null;
  readonly uptimeSeconds: number;
  readonly windowCount: number;
  readonly processCount: number;
  readonly totalWorkingSetSizeKiB: number;
  readonly byType: Readonly<Record<string, ProcessTypeSummary>>;
  readonly topProcesses: ReadonlyArray<{
    readonly pid: number;
    readonly type: string;
    readonly workingSetSizeKiB: number;
    readonly peakWorkingSetSizeKiB: number;
    readonly privateBytesKiB: number;
    readonly sharedBytesKiB: number;
  }>;
}

export function summarizeDesktopMemoryTelemetry(input: {
  readonly browserProcessPid: number;
  readonly backendPid: number | null;
  readonly uptimeSeconds: number;
  readonly windowCount: number;
  readonly appMetrics: ReadonlyArray<DesktopProcessMetricLike>;
}): DesktopMemoryTelemetrySnapshot {
  const byType = new Map<string, ProcessTypeSummary>();
  const topProcesses = input.appMetrics
    .map((metric) => {
      const workingSetSizeKiB = metric.memory.workingSetSize;
      const current = byType.get(metric.type) ?? {
        count: 0,
        workingSetSizeKiB: 0,
      };
      byType.set(metric.type, {
        count: current.count + 1,
        workingSetSizeKiB: current.workingSetSizeKiB + workingSetSizeKiB,
      });

      return {
        pid: metric.pid,
        type: metric.type,
        workingSetSizeKiB,
        peakWorkingSetSizeKiB: metric.memory.peakWorkingSetSize,
        privateBytesKiB: metric.memory.privateBytes ?? 0,
        sharedBytesKiB: Math.max(workingSetSizeKiB - (metric.memory.privateBytes ?? 0), 0),
      };
    })
    .toSorted((left, right) => right.workingSetSizeKiB - left.workingSetSizeKiB)
    .slice(0, DESKTOP_MEMORY_TOP_PROCESS_LIMIT);

  return {
    browserProcessPid: input.browserProcessPid,
    backendPid: input.backendPid,
    uptimeSeconds: input.uptimeSeconds,
    windowCount: input.windowCount,
    processCount: input.appMetrics.length,
    totalWorkingSetSizeKiB: input.appMetrics.reduce(
      (total, metric) => total + metric.memory.workingSetSize,
      0,
    ),
    byType: Object.fromEntries(byType),
    topProcesses,
  };
}
