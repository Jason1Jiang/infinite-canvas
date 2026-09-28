import { toolInputSchemas, toolNames, type ToolName } from "./schemas.js";
import type { CanvasConnection, CanvasNode, CanvasNodeType, CanvasSnapshot } from "./types.js";

const MAX_RESULT_CHARS = 64_000;
const MAX_NODES = 100;
const MAX_CONNECTIONS = 200;

export type CanvasNodeQuery = {
    ids?: string[];
    excludeIds?: string[];
    types?: CanvasNodeType[];
    statuses?: string[];
    limit?: number;
};

export function isToolName(name: unknown): name is ToolName {
    return typeof name === "string" && toolNames.includes(name as ToolName);
}

export function parseToolInput(name: ToolName, input: unknown) {
    return toolInputSchemas[name].parse(input ?? {});
}

export function compactCanvasState(state: CanvasSnapshot | null) {
    if (!state) throw new Error("当前没有已连接画布");
    const nodes = (state.nodes || []).slice(0, MAX_NODES).map(compactNode);
    const connections = (state.connections || []).slice(0, MAX_CONNECTIONS).map(compactConnection);
    const result = {
        projectId: safeString(state.projectId, 200),
        title: safeString(state.title, 200),
        nodeCount: state.nodes?.length || 0,
        connectionCount: state.connections?.length || 0,
        returnedNodeCount: nodes.length,
        returnedConnectionCount: connections.length,
        nodesTruncated: (state.nodes?.length || 0) > nodes.length,
        connectionsTruncated: (state.connections?.length || 0) > connections.length,
        nodes,
        connections,
        selectedNodeIds: (state.selectedNodeIds || []).slice(0, MAX_NODES).map((id) => safeString(id, 200) || ""),
        viewport: state.viewport,
    };
    return fitCanvasResult(result);
}

export function compactNode(node: CanvasNode) {
    return {
        id: safeString(node.id, 200) || "",
        type: node.type,
        title: safeString(node.title, 200),
        position: node.position,
        width: node.width,
        height: node.height,
        metadata: compactMetadata(node),
    };
}

export function queryCanvasNodes(state: CanvasSnapshot | null, query: CanvasNodeQuery) {
    if (!state) throw new Error("当前没有已连接画布");
    const ids = query.ids?.length ? new Set(query.ids) : null;
    const excludedIds = new Set(query.excludeIds || []);
    const types = query.types?.length ? new Set(query.types) : null;
    const statuses = query.statuses?.length ? new Set(query.statuses) : null;
    const matched = (state.nodes || []).filter((node) => {
        if (ids && !ids.has(node.id)) return false;
        if (excludedIds.has(node.id)) return false;
        if (types && !types.has(node.type)) return false;
        const status = typeof node.metadata?.status === "string" ? node.metadata.status : "";
        return !statuses || statuses.has(status);
    });
    const limit = Math.min(MAX_NODES, Math.max(1, Math.trunc(query.limit || 50)));
    const result = {
        matchedNodeCount: matched.length,
        returnedNodeCount: Math.min(matched.length, limit),
        truncated: matched.length > limit,
        nodes: matched.slice(0, limit).map(compactNode),
    };
    return fitNodeQueryResult(result);
}

export function compactCanvasMutationResult(input: Record<string, unknown>, result: unknown, beforeState: CanvasSnapshot | null) {
    const ops = Array.isArray(input.ops) ? input.ops.filter(isRecord) : [];
    const afterNodes = isRecord(result) && Array.isArray(result.nodes) ? result.nodes.filter(isCanvasNode) : [];
    const beforeIds = new Set((beforeState?.nodes || []).map((node) => node.id));
    const createdNodeIds = [
        ...ops.filter((op) => op.type === "add_node" && typeof op.id === "string").map((op) => op.id as string),
        ...afterNodes.filter((node) => !beforeIds.has(node.id)).map((node) => node.id),
    ];
    const selected = [...ops].reverse().find((op) => op.type === "select_nodes");
    return {
        ok: true,
        appliedOpCount: ops.length,
        createdNodeIds: uniqueStrings(createdNodeIds),
        updatedNodeIds: uniqueStrings(ops.filter((op) => op.type === "update_node").map((op) => op.id)),
        deletedNodeIds: uniqueStrings(
            ops
                .filter((op) => op.type === "delete_node")
                .flatMap((op) => [op.id, ...(Array.isArray(op.ids) ? op.ids : [])]),
        ),
        generationNodeIds: uniqueStrings(ops.filter((op) => op.type === "run_generation").map((op) => op.nodeId)),
        selectedNodeIds: uniqueStrings(Array.isArray(selected?.ids) ? selected.ids : []),
    };
}

export function nextCanvasX(state: CanvasSnapshot | null) {
    const nodes = state?.nodes || [];
    return nodes.length ? Math.max(...nodes.map((node) => node.position.x + node.width)) + 80 : 0;
}

function compactMetadata(node: CanvasNode) {
    const source = node.metadata || {};
    const metadata: Record<string, unknown> = {};
    const shortStrings = ["status", "storageKey", "mimeType", "generationMode", "generationType", "model", "size", "quality", "seconds", "vquality", "audioVoice", "audioFormat", "batchId", "batchParentId", "groupId"];
    const longStrings = ["prompt", "composerContent", "audioInstructions", "errorDetails", "source"];
    const numbers = ["bytes", "naturalWidth", "naturalHeight", "count", "audioSpeed", "durationMs", "fontSize"];
    const booleans = ["generateAudio", "watermark", "freeResize"];
    shortStrings.forEach((key) => copySafeString(metadata, source, key, 200));
    longStrings.forEach((key) => copySafeString(metadata, source, key, 800));
    numbers.forEach((key) => {
        if (typeof source[key] === "number" && Number.isFinite(source[key])) metadata[key] = source[key];
    });
    booleans.forEach((key) => {
        if (typeof source[key] === "boolean") metadata[key] = source[key];
    });
    if ((node.type === "text" || node.type === "config") && typeof source.content === "string" && !containsInlineMedia(source.content)) {
        metadata.content = truncate(source.content, 1_200);
    }
    if (Array.isArray(source.references)) metadata.referenceCount = source.references.length;
    return metadata;
}

function compactConnection(connection: CanvasConnection) {
    return {
        id: safeString(connection.id, 200) || "",
        fromNodeId: safeString(connection.fromNodeId, 200) || "",
        toNodeId: safeString(connection.toNodeId, 200) || "",
    };
}

function fitCanvasResult<T extends { nodes: unknown[]; connections: unknown[]; returnedNodeCount: number; returnedConnectionCount: number; nodesTruncated: boolean; connectionsTruncated: boolean }>(result: T) {
    while (JSON.stringify(result).length >= MAX_RESULT_CHARS && result.nodes.length) {
        result.nodes.pop();
        result.returnedNodeCount = result.nodes.length;
        result.nodesTruncated = true;
    }
    while (JSON.stringify(result).length >= MAX_RESULT_CHARS && result.connections.length) {
        result.connections.pop();
        result.returnedConnectionCount = result.connections.length;
        result.connectionsTruncated = true;
    }
    return result;
}

function fitNodeQueryResult<T extends { nodes: unknown[]; returnedNodeCount: number; truncated: boolean }>(result: T) {
    while (JSON.stringify(result).length >= MAX_RESULT_CHARS && result.nodes.length) {
        result.nodes.pop();
        result.returnedNodeCount = result.nodes.length;
        result.truncated = true;
    }
    return result;
}

function copySafeString(target: Record<string, unknown>, source: Record<string, unknown>, key: string, maxLength: number) {
    const value = safeString(source[key], maxLength);
    if (value !== undefined) target[key] = value;
}

function safeString(value: unknown, maxLength: number) {
    if (typeof value !== "string" || containsInlineMedia(value)) return undefined;
    return truncate(value, maxLength);
}

function truncate(value: string, maxLength: number) {
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function containsInlineMedia(value: string) {
    return /(?:data|blob):/i.test(value);
}

function uniqueStrings(values: unknown[]) {
    return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanvasNode(value: unknown): value is CanvasNode {
    return isRecord(value) && typeof value.id === "string";
}
