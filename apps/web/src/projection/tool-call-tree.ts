import type { ToolCallView } from "./conversation.js";

export type ToolTreeWarning = "orphan" | "cycle" | "depth-limit";

export interface ToolCallTreeNode {
  readonly call: ToolCallView;
  readonly depth: number;
  readonly children: readonly ToolCallTreeNode[];
  readonly warning?: ToolTreeWarning;
}

export interface ToolCallTree {
  readonly roots: readonly ToolCallTreeNode[];
  readonly nodes: readonly ToolCallTreeNode[];
  readonly warnings: readonly { readonly callId: string; readonly warning: ToolTreeWarning }[];
  readonly maxDepth: number;
}

interface MutableNode {
  readonly call: ToolCallView;
  depth: number;
  children: MutableNode[];
  warning?: ToolTreeWarning;
}

export interface ToolCallTreeOptions {
  readonly maxDepth?: number;
}

/**
 * Build a bounded ToolCall tree from host-provided lineage fields. Missing or
 * hostile lineage never hides a call: the affected node is promoted to a root
 * and carries a warning for the inspector.
 */
export function buildToolCallTree(calls: readonly ToolCallView[], options: ToolCallTreeOptions = {}): ToolCallTree {
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 8));
  const unique = new Map<string, ToolCallView>();
  for (const call of calls) if (!unique.has(call.id)) unique.set(call.id, call);
  const mutable = new Map<string, MutableNode>();
  for (const call of unique.values()) mutable.set(call.id, { call, depth: 0, children: [] });
  const warnings: { callId: string; warning: ToolTreeWarning }[] = [];

  for (const node of mutable.values()) {
    const resolution = resolveParent(node.call.id, mutable, maxDepth);
    node.depth = resolution.depth;
    if (resolution.warning !== undefined) {
      node.warning = resolution.warning;
      warnings.push({ callId: node.call.id, warning: resolution.warning });
    }
    if (resolution.parentId !== undefined) mutable.get(resolution.parentId)?.children.push(node);
  }

  const roots = [...mutable.values()]
    .filter((node) => resolveParent(node.call.id, mutable, maxDepth).parentId === undefined)
    .sort(compareNodes)
    .map((node) => freezeNode(node));
  const nodes = [...mutable.values()].sort(compareNodes).map((node) => freezeNode(node));
  return {
    roots,
    nodes,
    warnings,
    maxDepth,
  };
}

function resolveParent(
  callId: string,
  nodes: ReadonlyMap<string, MutableNode>,
  maxDepth: number,
): { readonly parentId?: string; readonly depth: number; readonly warning?: ToolTreeWarning } {
  const call = nodes.get(callId)?.call;
  const parentId = call?.parentCallId;
  if (parentId === undefined || parentId.length === 0) return { depth: 0 };
  if (parentId === callId) return { depth: 0, warning: "cycle" };
  if (!nodes.has(parentId)) return { depth: 0, warning: "orphan" };

  const visited = new Set<string>([callId]);
  let cursor: string | undefined = parentId;
  let depth = 1;
  while (cursor !== undefined) {
    if (visited.has(cursor)) return { depth: 0, warning: "cycle" };
    visited.add(cursor);
    if (depth > maxDepth) return { depth: maxDepth, warning: "depth-limit" };
    const ancestor: string | undefined = nodes.get(cursor)?.call.parentCallId;
    if (ancestor === undefined || ancestor.length === 0) return { parentId, depth };
    if (!nodes.has(ancestor)) return { parentId, depth, warning: "orphan" };
    cursor = ancestor;
    depth += 1;
  }
  return { parentId, depth };
}

function compareNodes(left: MutableNode, right: MutableNode): number {
  return left.call.sequence - right.call.sequence || left.call.id.localeCompare(right.call.id);
}

function freezeNode(node: MutableNode): ToolCallTreeNode {
  return {
    call: node.call,
    depth: node.depth,
    ...(node.warning === undefined ? {} : { warning: node.warning }),
    children: node.children.sort(compareNodes).map((child) => freezeNode(child)),
  };
}
