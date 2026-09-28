import assert from "node:assert/strict";
import test from "node:test";

import { compactCanvasMutationResult, compactCanvasState, queryCanvasNodes } from "../src/canvas/tools.js";
import type { CanvasSnapshot } from "../src/canvas/types.js";

test("canvas state summaries stay small and exclude inline media", () => {
    const state: CanvasSnapshot = {
        projectId: "project-1",
        title: "Large canvas",
        selectedNodeIds: ["image-0"],
        viewport: { x: 10, y: 20, k: 1 },
        nodes: Array.from({ length: 120 }, (_, index) => ({
            id: `image-${index}`,
            type: "image" as const,
            title: `Candidate ${index}`,
            position: { x: index * 20, y: 0 },
            width: 512,
            height: 512,
            metadata: {
                content: `data:image/png;base64,${"a".repeat(100_000)}`,
                prompt: "p".repeat(5_000),
                references: [`data:image/png;base64,${"b".repeat(50_000)}`, "image:reference"],
                status: index % 2 ? "loading" : "success",
                storageKey: `image:key-${index}`,
                bytes: 1_500_000,
                unboundedInternalField: "x".repeat(10_000),
            },
        })),
        connections: [],
    };

    const json = JSON.stringify(compactCanvasState(state));

    assert.ok(json.length < 64_000, `summary is ${json.length} characters`);
    assert.ok(!json.includes("data:image"));
    assert.ok(!json.includes("unboundedInternalField"));
    assert.equal(compactCanvasState(state).nodes[0]?.metadata?.storageKey, "image:key-0");
});

test("targeted node queries support compact generation polling", () => {
    const state: CanvasSnapshot = {
        nodes: [
            { id: "known", type: "image", title: "Known", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "success" } },
            { id: "new-loading", type: "image", title: "New", position: { x: 100, y: 0 }, width: 100, height: 100, metadata: { status: "loading" } },
            { id: "new-success", type: "image", title: "New", position: { x: 200, y: 0 }, width: 100, height: 100, metadata: { status: "success", storageKey: "image:new" } },
            { id: "text", type: "text", title: "Prompt", position: { x: 300, y: 0 }, width: 100, height: 100, metadata: { status: "success" } },
        ],
    };

    const result = queryCanvasNodes(state, { excludeIds: ["known"], types: ["image"], statuses: ["success"], limit: 10 });

    assert.deepEqual(result.nodes.map((node) => node.id), ["new-success"]);
    assert.equal(result.matchedNodeCount, 1);
});

test("canvas mutations return acknowledgements instead of snapshots", () => {
    const before: CanvasSnapshot = {
        nodes: [{ id: "existing", type: "text", title: "Old", position: { x: 0, y: 0 }, width: 100, height: 100 }],
    };
    const result: CanvasSnapshot = {
        nodes: [
            { id: "existing", type: "text", title: "Updated", position: { x: 0, y: 0 }, width: 100, height: 100 },
            {
                id: "created",
                type: "image",
                title: "Created",
                position: { x: 100, y: 0 },
                width: 100,
                height: 100,
                metadata: { content: `data:image/png;base64,${"a".repeat(100_000)}`, status: "loading" },
            },
        ],
    };
    const input = {
        ops: [
            { type: "add_node", nodeType: "image" },
            { type: "update_node", id: "existing", patch: { title: "Updated" } },
            { type: "run_generation", nodeId: "created", mode: "image" },
        ],
    };

    const acknowledgement = compactCanvasMutationResult(input, result, before);
    const json = JSON.stringify(acknowledgement);

    assert.ok(json.length < 8_000);
    assert.ok(!json.includes("data:image"));
    assert.deepEqual(acknowledgement.createdNodeIds, ["created"]);
    assert.deepEqual(acknowledgement.updatedNodeIds, ["existing"]);
    assert.deepEqual(acknowledgement.generationNodeIds, ["created"]);
});

test("an empty selection query returns no unrelated nodes", () => {
    const state: CanvasSnapshot = {
        projectId: "project-1", title: "Canvas", selectedNodeIds: [], connections: [],
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [{ id: "node-1", type: "text", position: { x: 0, y: 0 }, width: 100, height: 100 }],
    };
    assert.deepEqual(queryCanvasNodes(state, { ids: [] }).nodes, []);
});
