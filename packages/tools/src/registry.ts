import type { ToolDefinition } from "@code-review-agent/contracts";
import { assertValidInput } from "./schema.js";

export class ToolNotFoundError extends Error {
  readonly code = "TOOL_NOT_FOUND";
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (definition.name.trim() === "") throw new Error("Tool name cannot be empty");
    if (this.definitions.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
    this.definitions.set(definition.name, definition);
  }

  registerMany(definitions: readonly ToolDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  unregister(name: string): boolean {
    return this.definitions.delete(name);
  }

  get(name: string): ToolDefinition {
    const definition = this.definitions.get(name);
    if (definition === undefined) throw new ToolNotFoundError(`Unknown tool: ${name}`);
    return definition;
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  validate(name: string, input: unknown): ToolDefinition {
    const definition = this.get(name);
    assertValidInput(definition.inputSchema, input);
    return definition;
  }
}
