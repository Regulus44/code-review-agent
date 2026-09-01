import type { JsonSchema } from "@coding-agent/contracts";

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export class SchemaValidationError extends Error {
  readonly code = "INVALID_TOOL_INPUT";

  constructor(readonly issues: readonly SchemaIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
}

export function validateSchema(schema: JsonSchema, value: unknown, path = "$", issues: SchemaIssue[] = []): readonly SchemaIssue[] {
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ path, message: "value is not one of the allowed enum values" });
    return issues;
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    issues.push({ path, message: `expected ${schema.type}` });
    return issues;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `length must be at least ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, message: `length must be at most ${schema.maxLength}` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) issues.push({ path, message: "does not match pattern" });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must contain at most ${schema.maxItems} items` });
    if (schema.items !== undefined) value.forEach((item, index) => validateSchema(schema.items!, item, `${path}[${index}]`, issues));
  }
  if (isObject(value) && schema.properties !== undefined) {
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) issues.push({ path: `${path}.${required}`, message: "is required" });
    }
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validateSchema(childSchema, value[key], `${path}.${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) issues.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
      }
    }
  }
  return issues;
}

export function assertValidInput(schema: JsonSchema, value: unknown): void {
  const issues = validateSchema(schema, value);
  if (issues.length > 0) throw new SchemaValidationError(issues);
}

function matchesType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
