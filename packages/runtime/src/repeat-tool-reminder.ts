export interface RepeatToolReminderConfig {
  readonly thresholds?: readonly number[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly argumentsPreviewChars?: number;
}

export interface RepeatToolNotice {
  readonly content: string;
  readonly source: {
    readonly kind: "plugin";
    readonly plugin: "repeat-tool-reminder";
    readonly form: "notice";
    readonly summary: string;
  };
}

interface Chain {
  readonly key: string;
  readonly count: number;
}

const DEFAULT_THRESHOLDS = [3, 5, 8] as const;
const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500;

const GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. "
  + "Carefully analyze the previous result before calling again: if the task is "
  + "not complete, try a different approach or different arguments instead of "
  + "repeating the call.";

export class RepeatToolReminder {
  private readonly thresholds: readonly number[];
  private readonly thresholdSet: ReadonlySet<number>;
  private readonly include: readonly RegExp[];
  private readonly exclude: readonly RegExp[];
  private readonly argumentsPreviewChars: number;
  private readonly chains = new Map<string, Chain>();

  constructor(config: RepeatToolReminderConfig = {}) {
    this.thresholds = validateThresholds(config.thresholds ?? DEFAULT_THRESHOLDS);
    this.thresholdSet = new Set(this.thresholds);
    this.include = (config.include ?? []).map(wildcardToRegExp);
    this.exclude = (config.exclude ?? []).map(wildcardToRegExp);
    this.argumentsPreviewChars = config.argumentsPreviewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;
    if (!Number.isInteger(this.argumentsPreviewChars) || this.argumentsPreviewChars < 1) {
      throw new Error(`repeat-tool-reminder: invalid argumentsPreviewChars ${this.argumentsPreviewChars} — must be an integer >= 1`);
    }
  }

  observe(sessionId: string, toolName: string, rawArguments: string): RepeatToolNotice | undefined {
    if (!this.tracked(toolName)) return undefined;
    const canonicalArguments = canonicalize(parseArguments(rawArguments));
    const key = JSON.stringify([toolName, canonicalArguments]);
    const prior = this.chains.get(sessionId);
    const count = prior !== undefined && prior.key === key ? prior.count + 1 : 1;
    this.chains.set(sessionId, { key, count });
    if (!this.thresholdSet.has(count)) return undefined;
    const content = count === this.thresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(toolName, count, previewArguments(canonicalArguments, this.argumentsPreviewChars));
    return {
      content,
      source: {
        kind: "plugin",
        plugin: "repeat-tool-reminder",
        form: "notice",
        summary: `${toolName} × ${count}`,
      },
    };
  }

  reset(sessionId: string): void {
    this.chains.delete(sessionId);
  }

  clear(): void {
    this.chains.clear();
  }

  private tracked(toolName: string): boolean {
    if (this.include.length > 0 && !this.include.some((pattern) => pattern.test(toolName))) return false;
    return !this.exclude.some((pattern) => pattern.test(toolName));
  }
}

function parseArguments(raw: string): unknown {
  try {
    return raw.trim() === "" ? {} : JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

export function canonicalizeToolArguments(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function canonicalize(value: unknown): string {
  return canonicalizeToolArguments(value);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

function previewArguments(canonical: string, cap: number): string {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}… (+${canonical.length - cap} more chars)`;
}

function detailedReminder(toolName: string, count: number, canonicalArguments: string): string {
  return "Repeated tool call detected:\n"
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + "The repeated calls are not making progress. Do not call this tool with "
    + "these exact arguments again. Inspect the latest result and choose a "
    + "different action, different arguments, or finish the task if enough "
    + "evidence has been gathered.";
}

function validateThresholds(values: readonly number[]): number[] {
  if (values.length === 0) throw new Error("repeat-tool-reminder: `thresholds` must not be empty");
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2) throw new Error(`repeat-tool-reminder: invalid threshold ${value} — every threshold must be an integer >= 2`);
  }
  if (new Set(values).size !== values.length) throw new Error("repeat-tool-reminder: `thresholds` must not contain duplicates");
  return [...values].sort((a, b) => a - b);
}
