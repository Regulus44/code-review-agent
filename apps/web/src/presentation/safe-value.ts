export interface BoundedDisplayValue {
  readonly text: string;
  readonly truncated: boolean;
  readonly untrusted: boolean;
}

/**
 * Produce a bounded, redacted display value for host/event data. The output is
 * presentation-only and must never be treated as a trusted command or schema.
 */
export function presentBoundedValue(value: unknown, maxChars = 8_000): BoundedDisplayValue {
  const boundedChars = Math.max(256, Math.floor(maxChars));
  const text = stringify(redactValue(value));
  if (text.length <= boundedChars) return { text, truncated: false, untrusted: true };
  return {
    text: `${text.slice(0, Math.max(0, boundedChars - 32))}\n… [output truncated]`,
    truncated: true,
    untrusted: true,
  };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, "", seen));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey, seen)]));
}

function isSensitiveKey(key: string): boolean {
  return /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i.test(key);
}
