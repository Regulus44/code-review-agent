import type { ToolExecutionMode } from "@code-review-agent/contracts";

/** Default maximum number of in-flight parallel-safe tool calls per step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10;

/** Host-side safety ceiling for configured parallel tool calls. */
export const MAX_PARALLEL_TOOL_CALLS = 512;

export interface ToolCallSchedulerOptions<TCall, TResult> {
  readonly calls: readonly TCall[];
  /** Reads the live execution mode immediately before a call is started. */
  readonly executionMode: (call: TCall) => ToolExecutionMode;
  /** Starts one call. The scheduler never invokes this for an aborted/skipped call. */
  readonly execute: (call: TCall) => Promise<TResult>;
  /** Creates a durable structured result for a call that was not dispatched after abort. */
  readonly skip?: (call: TCall) => Promise<TResult> | TResult;
  /** Commits a settled result in model declaration order. */
  readonly commit?: (call: TCall, result: TResult, index: number) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly maxParallelToolCalls?: number;
}

export interface ToolCallSchedulerResult<TResult> {
  readonly results: readonly TResult[];
  readonly aborted: boolean;
  readonly startedCount: number;
}

interface Settled<TResult> {
  readonly result: TResult;
}

interface GroupResult {
  readonly consumed: number;
  readonly aborted: boolean;
  readonly startedCount: number;
}

/**
 * Executes one assistant step's tool calls using DSH-style barriers and a
 * bounded rolling pool. Calls are returned and committed in model order even
 * when their underlying promises settle out of order.
 */
export async function scheduleToolCalls<TCall, TResult>(options: ToolCallSchedulerOptions<TCall, TResult>): Promise<ToolCallSchedulerResult<TResult>> {
  const maxParallelToolCalls = resolveMaxParallelToolCalls(options.maxParallelToolCalls);
  const results: (TResult | undefined)[] = Array.from({ length: options.calls.length });
  let next = 0;
  let startedCount = 0;
  let aborted = options.signal?.aborted === true;

  while (next < options.calls.length) {
    const first = options.calls[next];
    if (first === undefined) break;
    const mode = safeExecutionMode(options.executionMode, first);
    const group = mode === "parallel" ? options.calls.slice(next) : options.calls.slice(next, next + 1);
    const outcome = await runGroup(group, next, mode, options, maxParallelToolCalls, results);
    next += outcome.consumed;
    startedCount += outcome.startedCount;
    if (outcome.aborted) {
      aborted = true;
      break;
    }
  }

  if (aborted && next < options.calls.length) {
    for (let index = next; index < options.calls.length; index += 1) {
      const call = options.calls[index];
      if (call === undefined) continue;
      const result = options.skip === undefined
        ? await options.execute(call)
        : await options.skip(call);
      results[index] = result;
      await options.commit?.(call, result, index);
    }
  }

  if (results.some((result) => result === undefined)) {
    throw new Error("TOOL_CALL_SCHEDULER_INCOMPLETE: scheduler did not produce one result per model call");
  }
  return { results: results as TResult[], aborted, startedCount };
}

async function runGroup<TCall, TResult>(
  group: readonly TCall[],
  offset: number,
  mode: ToolExecutionMode,
  options: ToolCallSchedulerOptions<TCall, TResult>,
  maxParallelToolCalls: number,
  results: (TResult | undefined)[],
): Promise<GroupResult> {
  const slots: (Settled<TResult> | undefined)[] = Array.from({ length: group.length });
  const inFlight = new Map<number, Promise<number>>();
  let nextToStart = 0;
  let committed = 0;
  let startedCount = 0;
  let aborted = options.signal?.aborted === true;
  let schedulerFailure: unknown;

  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const slot = slots[committed];
      if (slot === undefined) break;
      const index = offset + committed;
      const call = group[committed];
      if (call === undefined) throw new Error("TOOL_CALL_SCHEDULER_MISSING_CALL");
      results[index] = slot.result;
      await options.commit?.(call, slot.result, index);
      committed += 1;
    }
  };

  const start = (index: number): void => {
    const call = group[index];
    if (call === undefined) throw new Error("TOOL_CALL_SCHEDULER_MISSING_CALL");
    startedCount += 1;
    const pending = Promise.resolve()
      .then(() => options.execute(call))
      .then(
        (result) => {
          slots[index] = { result };
          return index;
        },
        (error: unknown) => {
          schedulerFailure ??= error;
          return index;
        },
      );
    inFlight.set(index, pending);
  };

  const fillPool = async (): Promise<void> => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      const call = group[nextToStart];
      if (call === undefined) throw new Error("TOOL_CALL_SCHEDULER_MISSING_CALL");
      if (nextToStart > 0 && mode === "parallel" && safeExecutionMode(options.executionMode, call) !== "parallel") break;
      start(nextToStart);
      nextToStart += 1;
      await commitReady();
      if (schedulerFailure !== undefined) throw schedulerFailure;
      if (options.signal?.aborted === true) aborted = true;
    }
  };

  try {
    await fillPool();
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values());
      inFlight.delete(settledIndex);
      if (schedulerFailure !== undefined) throw schedulerFailure;
      await commitReady();
      if (options.signal?.aborted === true) aborted = true;
      await fillPool();
    }
    await commitReady();
    if (schedulerFailure !== undefined) throw schedulerFailure;
  } catch (error) {
    schedulerFailure ??= error;
    await Promise.allSettled(inFlight.values());
    throw schedulerFailure;
  }

  if (aborted) {
    // Drain all started calls first. Their results are committed in model order
    // before the caller receives synthetic results for the unstarted suffix.
    if (inFlight.size > 0) await Promise.allSettled(inFlight.values());
    await commitReady();
    return { consumed: nextToStart, aborted: true, startedCount };
  }
  if (committed !== nextToStart) throw new Error("TOOL_CALL_SCHEDULER_UNCOMMITTED: settled calls remain");
  return { consumed: nextToStart, aborted: false, startedCount };
}

function safeExecutionMode<TCall>(reader: (call: TCall) => ToolExecutionMode, call: TCall): ToolExecutionMode {
  try {
    return reader(call);
  } catch {
    // Unknown or disabled tools are handled by the execution callback. Treat
    // them as an exclusive barrier so a registry mutation cannot fan out an
    // invalid call into the parallel pool.
    return "exclusive";
  }
}

export function resolveMaxParallelToolCalls(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_PARALLEL_TOOL_CALLS) {
    throw new Error(`maxParallelToolCalls must be an integer between 1 and ${MAX_PARALLEL_TOOL_CALLS}`);
  }
  return resolved;
}
