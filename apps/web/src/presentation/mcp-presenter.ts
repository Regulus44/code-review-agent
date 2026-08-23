import type { McpServerView } from "../client/api.js";
import { presentBoundedValue, type BoundedDisplayValue } from "./safe-value.js";

export interface McpCatalogRenderIntent {
  readonly name: string;
  readonly enabled: boolean;
  readonly riskLevel: string;
  readonly approvalMode: string;
  readonly disabledReason?: string;
  readonly schemaWarning?: string;
}

export interface McpRenderIntent {
  readonly name: string;
  readonly status: string;
  readonly scope: string;
  readonly transport: string;
  readonly revision: number;
  readonly generation: number;
  readonly auth: string;
  readonly activeCount: number;
  readonly disabledCount: number;
  readonly catalog: readonly McpCatalogRenderIntent[];
  readonly retryAt?: string;
  readonly lastError?: string;
  readonly details: BoundedDisplayValue;
}

export interface McpPresenterOptions {
  readonly maxDetailChars?: number;
}

/** Convert the host-owned MCP status/catalog view into safe render intent. */
export function presentMcpServer(server: McpServerView, options: McpPresenterOptions = {}): McpRenderIntent {
  const config = asRecord(server.config);
  const catalog = Array.isArray(server.catalog) ? server.catalog.flatMap(toCatalogIntent) : [];
  const status = stringValue(server.status) ?? "unknown";
  const retry = asRecord(server.retry);
  const credentialRef = asRecord(config?.["credentialRef"]);
  const retryAt = stringValue(retry?.["nextAttemptAt"]);
  const lastError = stringValue(server.lastError);
  const auth = status === "needs_auth"
    ? "needs authorization"
    : credentialRef !== undefined
      ? "credential reference configured"
      : "no credential reference";
  return {
    name: stringValue(config?.["name"]) ?? stringValue(server.name) ?? "MCP server",
    status,
    scope: stringValue(config?.["scope"]) ?? "unknown",
    transport: stringValue(config?.["transport"]) ?? "unknown",
    revision: numberValue(server.revision) ?? numberValue(config?.["revision"]) ?? 0,
    generation: numberValue(server.generation) ?? 0,
    auth,
    activeCount: catalog.filter((item) => item.enabled).length,
    disabledCount: catalog.filter((item) => !item.enabled).length,
    catalog,
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(lastError === undefined ? {} : { lastError }),
    details: presentBoundedValue({ config: server.config, catalog: server.catalog, retry: server.retry, lastError: server.lastError }, options.maxDetailChars ?? 8_000),
  };
}

function toCatalogIntent(value: unknown): McpCatalogRenderIntent[] {
  const record = asRecord(value);
  if (record === undefined) return [];
  const name = stringValue(record["name"]) ?? stringValue(record["rawName"]);
  if (name === undefined) return [];
  const disabledReason = stringValue(record["disabledReason"]);
  const schemaWarning = stringValue(record["schemaWarning"]);
  return [{
    name,
    enabled: record["enabled"] !== false,
    riskLevel: stringValue(record["riskLevel"]) ?? "unknown",
    approvalMode: stringValue(record["approvalMode"]) ?? "unknown",
    ...(disabledReason === undefined ? {} : { disabledReason }),
    ...(schemaWarning === undefined ? {} : { schemaWarning }),
  }];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
