import type { ConversationNode, InteractionNode, PermissionNode } from "../projection/conversation.js";
import { presentBoundedValue, type BoundedDisplayValue } from "./safe-value.js";

export type RequestRecoveryState = "none" | "restored" | "expired";
export type PermissionDisplayStatus = PermissionNode["status"];
export type InteractionDisplayStatus = InteractionNode["status"];

export interface RequestPresenterOptions {
  readonly now?: number;
  readonly sessionStatus?: string;
  readonly connection?: string;
  readonly maxDetailChars?: number;
}

export interface PermissionRenderIntent {
  readonly kind: "permission";
  readonly key: string;
  readonly sequence: number;
  readonly id: string;
  readonly permissionId: string;
  readonly toolName: string;
  readonly reason: string;
  readonly caller?: string;
  readonly workspaceRoot?: string;
  readonly command?: string;
  readonly status: PermissionDisplayStatus;
  readonly originalStatus: PermissionNode["status"];
  readonly recovery: RequestRecoveryState;
  readonly recoveryLabel?: string;
  readonly interactive: boolean;
  readonly expiresAt?: string;
  readonly expiresInMs?: number;
  readonly summary: string;
  readonly details: BoundedDisplayValue;
  readonly actions: readonly ("approved" | "denied" | "cancelled")[];
}

export interface InteractionRenderIntent {
  readonly kind: "interaction";
  readonly key: string;
  readonly sequence: number;
  readonly id: string;
  readonly interactionId: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
  readonly allowFreeform: boolean;
  readonly answer?: string;
  readonly status: InteractionDisplayStatus;
  readonly originalStatus: InteractionNode["status"];
  readonly recovery: RequestRecoveryState;
  readonly recoveryLabel?: string;
  readonly interactive: boolean;
  readonly expiresAt?: string;
  readonly expiresInMs?: number;
  readonly summary: string;
  readonly details: BoundedDisplayValue;
  readonly actions: readonly ("answered" | "cancelled")[];
}

export type PendingRequestRenderIntent = PermissionRenderIntent | InteractionRenderIntent;

export interface PendingRequestView {
  readonly kind: PendingRequestRenderIntent["kind"];
  readonly key: string;
  readonly sequence: number;
  readonly request: PendingRequestRenderIntent;
}

export interface PendingRequestsRenderIntent {
  readonly active?: PendingRequestView;
  readonly pending: readonly PendingRequestView[];
  readonly pendingCount: number;
}

/**
 * Convert a permission node into a bounded, time-aware render intent. A
 * pending request that has crossed its deadline is displayed as expired and
 * cannot expose an approval action, even if the settlement event has not
 * reached the browser yet.
 */
export function presentPermission(node: PermissionNode, options: RequestPresenterOptions = {}): PermissionRenderIntent {
  const timing = requestTiming(node.status, node.expiresAt, options);
  const status = timing.expired ? "expired" : node.status;
  const recovery = recoveryState(status, options);
  const command = commandOf(node.input);
  return {
    kind: "permission",
    key: node.key,
    sequence: node.sequence,
    id: String(node.permissionId),
    permissionId: String(node.permissionId),
    toolName: node.toolName,
    reason: node.reason,
    ...(node.caller === undefined ? {} : { caller: node.caller }),
    ...(node.workspaceRoot === undefined ? {} : { workspaceRoot: node.workspaceRoot }),
    ...(command === undefined ? {} : { command }),
    status,
    originalStatus: node.status,
    recovery: recovery.state,
    ...(recovery.label === undefined ? {} : { recoveryLabel: recovery.label }),
    interactive: status === "pending" && !timing.expired,
    ...(node.expiresAt === undefined ? {} : { expiresAt: node.expiresAt }),
    ...(timing.expiresInMs === undefined ? {} : { expiresInMs: timing.expiresInMs }),
    summary: permissionSummary(status, node.toolName),
    details: presentBoundedValue({
      reason: node.reason,
      caller: node.caller,
      workspaceRoot: node.workspaceRoot,
      expiresAt: node.expiresAt,
      input: node.input,
    }, options.maxDetailChars ?? 8_000),
    actions: status === "pending" && !timing.expired ? ["approved", "denied", "cancelled"] : [],
  };
}

/** Convert an interaction node into a bounded, restart-aware render intent. */
export function presentInteraction(node: InteractionNode, options: RequestPresenterOptions = {}): InteractionRenderIntent {
  const timing = requestTiming(node.status, node.expiresAt, options);
  const status = timing.expired ? "expired" : node.status;
  const recovery = recoveryState(status, options);
  return {
    kind: "interaction",
    key: node.key,
    sequence: node.sequence,
    id: String(node.interactionId),
    interactionId: String(node.interactionId),
    question: node.question,
    options: node.options.slice(0, 32).map((option) => ({
      label: boundText(option.label, 240),
      value: boundText(option.value, 500),
    })),
    allowFreeform: node.allowFreeform,
    ...(node.answer === undefined ? {} : { answer: boundText(node.answer, 1_000) }),
    status,
    originalStatus: node.status,
    recovery: recovery.state,
    ...(recovery.label === undefined ? {} : { recoveryLabel: recovery.label }),
    interactive: status === "pending" && !timing.expired,
    ...(node.expiresAt === undefined ? {} : { expiresAt: node.expiresAt }),
    ...(timing.expiresInMs === undefined ? {} : { expiresInMs: timing.expiresInMs }),
    summary: interactionSummary(status),
    details: presentBoundedValue({
      question: node.question,
      caller: node.caller,
      options: node.options,
      allowFreeform: node.allowFreeform,
      answer: node.answer,
      expiresAt: node.expiresAt,
    }, options.maxDetailChars ?? 8_000),
    actions: status === "pending" && !timing.expired ? ["answered", "cancelled"] : [],
  };
}

/** Select the one pending request that owns the Composer. */
export function presentPendingRequests(
  nodes: readonly ConversationNode[] | undefined,
  options: RequestPresenterOptions = {},
): PendingRequestsRenderIntent {
  const pending = (nodes ?? []).flatMap((node): PendingRequestView[] => {
    if (node.kind === "permission") {
      const request = presentPermission(node, options);
      return request.status === "pending" ? [{ kind: "permission", key: node.key, sequence: node.sequence, request }] : [];
    }
    if (node.kind === "interaction") {
      const request = presentInteraction(node, options);
      return request.status === "pending" ? [{ kind: "interaction", key: node.key, sequence: node.sequence, request }] : [];
    }
    return [];
  }).sort((left, right) => {
    const priority = left.kind === right.kind ? 0 : left.kind === "interaction" ? -1 : 1;
    return priority || left.sequence - right.sequence || left.key.localeCompare(right.key);
  });
  return {
    ...(pending[0] === undefined ? {} : { active: pending[0] }),
    pending,
    pendingCount: pending.length,
  };
}

function requestTiming(status: string, expiresAt: string | undefined, options: RequestPresenterOptions): { readonly expired: boolean; readonly expiresInMs?: number } {
  if (status !== "pending" || expiresAt === undefined) return { expired: false };
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return { expired: false };
  const now = options.now ?? Date.now();
  const expiresInMs = expiresAtMs - now;
  return { expired: expiresInMs <= 0, expiresInMs };
}

function recoveryState(status: string, options: RequestPresenterOptions): { readonly state: RequestRecoveryState; readonly label?: string } {
  if (status === "expired") return { state: "expired", label: "Expired · response disabled" };
  if (status === "pending" && (options.sessionStatus === "interrupted" || options.connection === "reconnecting" || options.connection === "connecting")) {
    return { state: "restored", label: "Recovered request · response will continue the turn" };
  }
  return { state: "none" };
}

function permissionSummary(status: PermissionDisplayStatus, toolName: string): string {
  if (status === "pending") return `Approval required · ${toolName}`;
  if (status === "expired") return `Approval expired · ${toolName}`;
  return `Permission ${status} · ${toolName}`;
}

function interactionSummary(status: InteractionDisplayStatus): string {
  if (status === "pending") return "Agent needs your input";
  if (status === "expired") return "Question expired";
  return `Interaction ${status}`;
}

function commandOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string" && record[key].trim() !== "") return boundText(record[key], 12_000);
  }
  return undefined;
}

function boundText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const limit = Math.max(24, Math.floor(maxChars));
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
