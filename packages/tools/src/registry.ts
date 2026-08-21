import type { ToolDefinition } from "@code-review-agent/contracts";
import { assertValidInput } from "./schema.js";

export class ToolNotFoundError extends Error {
  readonly code = "TOOL_NOT_FOUND";
}

export class ToolDisabledError extends Error {
  readonly code = "TOOL_DISABLED";
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly disabled = new Set<string>();

  register(definition: ToolDefinition): void {
    if (definition.name.trim() === "") throw new Error("Tool name cannot be empty");
    if (this.definitions.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    this.definitions.set(definition.name, definition);
  }

  registerMany(definitions: readonly ToolDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  unregister(name: string): boolean {
    this.disabled.delete(name);
    return this.definitions.delete(name);
  }

  enable(name: string): boolean {
    if (!this.definitions.has(name)) return false;
    this.disabled.delete(name);
    return true;
  }

  disable(name: string): boolean {
    if (!this.definitions.has(name)) return false;
    this.disabled.add(name);
    return true;
  }

  isEnabled(name: string): boolean {
    return this.definitions.has(name) && !this.disabled.has(name);
  }

  get(name: string): ToolDefinition {
    const definition = this.definitions.get(name);
    if (definition === undefined) throw new ToolNotFoundError(`Unknown tool: ${name}`);
    if (this.disabled.has(name)) throw new ToolDisabledError(`Tool is disabled: ${name}`);
    return definition;
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.definitions.values()].filter((definition) => !this.disabled.has(definition.name)).sort((left, right) => left.name.localeCompare(right.name));
  }

  listAll(): readonly ToolDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  validate(name: string, input: unknown): ToolDefinition {
    const definition = this.get(name);
    assertValidInput(definition.inputSchema, input);
    return definition;
  }
}
