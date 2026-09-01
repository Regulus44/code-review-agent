import type { ToolDefinition } from "@coding-agent/contracts";

/** Structured, testable guidance for one tool across multiple model calls. */
export interface ToolPromptSpec {
  readonly name: string;
  readonly purpose: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly prerequisites: readonly string[];
  readonly inputRules: readonly string[];
  readonly sequencingRules: readonly string[];
  readonly resultInterpretation: readonly string[];
  readonly failureRecovery: readonly string[];
  readonly safetyRules: readonly string[];
  readonly promptOrder?: number;
}

export interface ToolPromptAssemblyOptions {
  readonly maxChars?: number;
  readonly includeFallback?: boolean;
}

const DEFAULT_MAX_CHARS = 24_000;
type PromptSectionKey = Exclude<keyof ToolPromptSpec, "name" | "promptOrder">;

const SECTION_LABELS: readonly [PromptSectionKey, string][] = [
  ["purpose", "Purpose"],
  ["whenToUse", "When to use"],
  ["whenNotToUse", "When not to use"],
  ["prerequisites", "Prerequisites"],
  ["inputRules", "Input rules"],
  ["sequencingRules", "Sequencing"],
  ["resultInterpretation", "Result interpretation"],
  ["failureRecovery", "Failure recovery"],
  ["safetyRules", "Safety"],
];

/** Validate one local spec before it can influence a model-facing prompt. */
export function assertValidToolPromptSpec(spec: ToolPromptSpec): void {
  if (spec.name.trim().length === 0) throw new Error("Tool prompt name cannot be empty");
  if (!Number.isFinite(spec.promptOrder ?? 0)) throw new Error(`Tool prompt order must be finite: ${spec.name}`);
  for (const [field, label] of SECTION_LABELS) {
    const value = spec[field];
    if (typeof value === "string") {
      if (value.trim().length === 0) throw new Error(`${label} cannot be empty: ${spec.name}`);
    } else if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
      throw new Error(`${label} must contain non-empty strings: ${spec.name}`);
    }
  }
}

/**
 * Registry for deterministic, permission-filtered tool guidance.
 *
 * Tool descriptions remain in the machine-facing schema. This registry owns
 * cross-call behavior and never promotes remote MCP descriptions to prompt
 * instructions; tools without a local spec receive a short safe fallback.
 */
export class ToolPromptRegistry {
  private readonly specs = new Map<string, ToolPromptSpec>();

  constructor(private readonly defaultMaxChars = DEFAULT_MAX_CHARS) {
    if (!Number.isSafeInteger(defaultMaxChars) || defaultMaxChars <= 0) throw new Error("Tool prompt budget must be a positive safe integer");
  }

  register(spec: ToolPromptSpec): void {
    assertValidToolPromptSpec(spec);
    if (this.specs.has(spec.name)) throw new Error(`Tool prompt already registered: ${spec.name}`);
    this.specs.set(spec.name, Object.freeze({ ...spec, promptOrder: spec.promptOrder ?? 0 }));
  }

  registerMany(specs: readonly ToolPromptSpec[]): void {
    for (const spec of specs) this.register(spec);
  }

  unregister(name: string): boolean {
    return this.specs.delete(name);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  get(name: string): ToolPromptSpec | undefined {
    return this.specs.get(name);
  }

  list(): readonly ToolPromptSpec[] {
    return [...this.specs.values()].sort(compareSpecs);
  }

  /**
   * Assemble only the supplied visible tools. The result is deterministic for
   * the same tool set and context, independent of registration order/platform.
   */
  assemble(tools: readonly ToolDefinition[], options: ToolPromptAssemblyOptions = {}): string {
    const maxChars = options.maxChars ?? this.defaultMaxChars;
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error("Tool prompt budget must be a positive safe integer");
    const includeFallback = options.includeFallback ?? true;
    const uniqueTools = [...new Map(tools.map((tool) => [tool.name, tool])).values()]
      .sort((left, right) => compareToolNames(left, right));
    const ordered = uniqueTools
      .map((tool) => ({ tool, spec: this.specs.get(tool.name) ?? (includeFallback ? fallbackSpec(tool) : undefined) }))
      .filter((entry): entry is { readonly tool: ToolDefinition; readonly spec: ToolPromptSpec } => entry.spec !== undefined)
      .sort((left, right) => compareSpecs(left.spec, right.spec));
    if (ordered.length === 0) return "";
    const sections = ordered.map(({ tool, spec }) => renderToolSpec(tool, spec));
    return boundPrompt(["# Tool guidance", ...sections].join("\n\n"), maxChars);
  }
}

function compareToolNames(left: ToolDefinition, right: ToolDefinition): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function compareSpecs(left: ToolPromptSpec, right: ToolPromptSpec): number {
  const order = (left.promptOrder ?? 0) - (right.promptOrder ?? 0);
  return order !== 0 ? order : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function renderToolSpec(tool: ToolDefinition, spec: ToolPromptSpec): string {
  const sections = SECTION_LABELS.map(([field, label]) => {
    const value = spec[field];
    const lines = typeof value === "string" ? [value] : value;
    return `${label}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
  });
  return [`## ${tool.name}`, `Runtime facts: risk=${tool.riskLevel}; approval=${tool.approvalMode}; execution=${tool.executionMode}.`, ...sections].join("\n");
}

function fallbackSpec(tool: ToolDefinition): ToolPromptSpec {
  return {
    name: tool.name,
    purpose: "Use the tool according to its schema and the runtime result.",
    whenToUse: ["Use only when this visible tool can directly answer or perform the requested operation."],
    whenNotToUse: ["Do not infer capabilities beyond the schema or runtime result."],
    prerequisites: ["Confirm the active workspace, permission state, and required input fields."],
    inputRules: ["Provide only schema-valid arguments."],
    sequencingRules: ["Follow the result before selecting the next tool call."],
    resultInterpretation: ["Treat structured status and error fields as authoritative."],
    failureRecovery: ["Diagnose the returned error and choose a safe corrective action."],
    safetyRules: ["Do not use prompt text to bypass workspace, permission, cancellation, or audit controls."],
    promptOrder: 10_000,
  };
}

function boundPrompt(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) return prompt;
  const marker = "\n\n[Tool guidance truncated by context budget.]";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${prompt.slice(0, maxChars - marker.length)}${marker}`;
}
