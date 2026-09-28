import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CanvasSession } from "./canvas-session.js";

test("MCP 读取当前激活网页的画布", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");

    session.activateClient("first");
    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-first");

    session.activateClient("second");
    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-second");
});

test("画布写操作只发送给当前激活网页", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.activateClient("second");

    const result = session.callTool("canvas_create_text_node", { text: "只写入第二个画布" });
    const call = second.event("tool_call");
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(field(call, "name"), "canvas_apply_ops");
    session.resolveResult("second", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.equal(field(await result, "appliedOpCount"), 1);
});

test("当前 turn 的图片附件可在发起标签页画布创建图片节点", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    const dataUrl = "data:image/png;base64,aW1hZ2U=";
    session.setTurnAttachments("first", [{ id: "attachment-1", name: "商品.png", type: "image/png", size: 5, width: 1200, height: 600, dataUrl }]);
    session.bindClient("first");

    const result = session.callTool("canvas_create_attachment_nodes", { attachmentIds: ["attachment-1"], x: 100, y: 200 });
    const call = first.event("tool_call");
    const input = field(call, "input") as Record<string, unknown>;
    const nodes = input.nodes as Array<Record<string, unknown>>;
    assert.equal(field(call, "name"), "canvas_create_attachment_nodes");
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].attachmentId, "attachment-1");
    assert.equal(nodes[0].title, "商品.png");
    assert.deepEqual(nodes[0].position, { x: 100, y: 200 });
    assert.equal(nodes[0].width, 640);
    assert.equal(nodes[0].height, 320);
    assert.equal("dataUrl" in nodes[0], false);
    assert.equal(session.getTurnAttachment("first", "attachment-1").dataUrl, dataUrl);

    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true } });
    const created = (await result) as { nodes: Array<{ id: string; attachmentId: string; title: string }> };
    assert.equal(created.nodes[0].id, nodes[0].id);
    assert.equal(created.nodes[0].attachmentId, "attachment-1");
    session.clearTurnAttachments("first");
    assert.throws(() => session.getTurnAttachment("first", "attachment-1"), /找不到/);
});

test("图片附件只允许发起 turn 的标签页读取和落入画布", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.setTurnAttachments("first", [{ id: "attachment-1", name: "商品.png", type: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }]);
    session.bindClient("second");

    await assert.rejects(session.callTool("canvas_create_attachment_nodes", { attachmentIds: ["attachment-1"] }), /发起标签页/);
    assert.throws(() => session.getTurnAttachment("second", "attachment-1"), /发起标签页/);
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(second.event("tool_call"), undefined);
});

test("本地图片路径可短参数导入我的素材", async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "canvas-agent-local-image-"));
    t.after(async () => rm(workspace, { recursive: true, force: true }));
    const imagePath = path.join(workspace, "sample.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));

    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    session.setCodexWorkspacePath(workspace);

    const result = session.callTool("assets_add", { kind: "image", title: "本地样例", localFilePath: imagePath });
    const call = await first.waitForEvent("tool_call");
    const input = field(call, "input") as Record<string, unknown>;
    assert.equal(field(call, "name"), "assets_add");
    assert.equal("localFilePath" in input, false);
    assert.match(String(input.imageUrl), /^data:image\/png;base64,/);

    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true, id: "asset-1", kind: "image" } });
    assert.deepEqual(await result, { ok: true, id: "asset-1", kind: "image" });
});

test("本地图片路径不能越过当前 Codex 工作区", async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "canvas-agent-workspace-"));
    const outside = await mkdtemp(path.join(tmpdir(), "canvas-agent-outside-"));
    t.after(async () => Promise.all([rm(workspace, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
    const imagePath = path.join(outside, "sample.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));

    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    session.setCodexWorkspacePath(workspace);

    await assert.rejects(session.callTool("assets_add", { kind: "image", title: "越界样例", localFilePath: imagePath }), /当前 Codex 工作区/);
    assert.equal(first.event("tool_call"), undefined);
});

test("素材 ID 可创建不含内联图片的画布节点", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    t.after(() => first.close());
    session.updateState(snapshot("canvas-first"), "first");

    const result = session.callTool("canvas_create_node", { nodeType: "image", assetId: "asset-1", title: "素材节点", x: 100, y: 200 });
    const assetCall = await first.waitForEvent("tool_call", 0);
    assert.equal(field(assetCall, "name"), "assets_get");
    assert.deepEqual(field(assetCall, "input"), { id: "asset-1" });
    session.resolveResult("first", {
        requestId: String(field(assetCall, "requestId")),
        result: { id: "asset-1", kind: "image", title: "素材", coverUrl: "blob:asset-1", storageKey: "image:key-1", width: 1200, height: 600, bytes: 1000, mimeType: "image/png" },
    });

    const canvasCall = await first.waitForEvent("tool_call", 1);
    const input = field(canvasCall, "input") as { ops: Array<Record<string, unknown>> };
    const op = input.ops[0];
    assert.equal(field(canvasCall, "name"), "canvas_apply_ops");
    assert.equal(op.width, 640);
    assert.equal(op.height, 320);
    assert.deepEqual(op.metadata, { content: "blob:asset-1", storageKey: "image:key-1", status: "success", naturalWidth: 1200, naturalHeight: 600, bytes: 1000, mimeType: "image/png" });
    assert.ok(!JSON.stringify(input).includes("data:image"));

    session.resolveResult("first", { requestId: String(field(canvasCall, "requestId")), result: { ok: true } });
    assert.equal(field(await result, "appliedOpCount"), 1);
});

test("tool result is accepted only from the request client", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.activateClient("first");

    const result = session.callTool("canvas_create_text_node", { text: "first only" });
    const call = first.event("tool_call");
    const requestId = String(field(call, "requestId"));

    assert.equal(session.resolveResult("second", { requestId, result: { client: "second" } }), false);
    assert.equal(session.resolveResult("first", { requestId, result: { client: "first" } }), true);
    assert.equal(field(await result, "appliedOpCount"), 1);
});

test("生成状态查询由当前激活网页返回", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.activateClient("second");

    const result = session.callTool("generation_get_status", { scope: "all" });
    const call = second.event("tool_call");
    assert.equal(first.event("tool_call"), undefined);
    assert.equal(field(call, "name"), "generation_get_status");
    session.resolveResult("second", { requestId: String(field(call, "requestId")), result: { total: 1, tasks: [{ id: "image-1", status: "running" }] } });
    assert.deepEqual(await result, { total: 1, tasks: [{ id: "image-1", status: "running" }] });
});

test("活动网页关闭后回退到仍连接的画布", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.activateClient("second");
    second.close();

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-first");
});

test("closing the active client falls back to the most recently focused client", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    const third = connect(session, "third");
    t.after(() => {
        first.close();
        second.close();
        third.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.updateState(snapshot("canvas-third"), "third");
    session.activateClient("third");
    session.activateClient("second");
    second.close();

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-third");
});

test("closing a client rejects its pending tool requests", async () => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const result = session.callTool("canvas_create_text_node", { text: "pending" });
    const call = first.event("tool_call");
    const requestId = String(field(call, "requestId"));
    first.close();

    const outcome = await Promise.race([
        result.then(() => "resolved", (error) => error instanceof Error ? error.message : String(error)),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    if (outcome === "pending") session.resolveResult("first", { requestId, result: null });
    assert.match(outcome, /断开/);
});

test("shared thread events are broadcast with the active thread id", (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });

    session.emitThread("workspace_changed", "thread-2", { activeThreadId: "thread-2" });

    assert.deepEqual(first.event("workspace_changed"), { activeThreadId: "thread-2", threadId: "thread-2" });
    assert.deepEqual(second.event("workspace_changed"), { activeThreadId: "thread-2", threadId: "thread-2" });
});

test("new clients receive the current Codex state and later updates", (t) => {
    const session = new CanvasSession();
    session.setCodexState({ busy: true, threadId: "thread-2", turnId: "turn-1" });
    const client = connect(session, "first");
    t.after(() => client.close());

    assert.deepEqual(field(client.event("hello"), "codex"), { busy: true, threadId: "thread-2", turnId: "turn-1" });

    session.setCodexState({ busy: false });
    assert.deepEqual(client.event("codex_state"), { busy: false, threadId: "thread-2", turnId: "turn-1" });
});

test("a bound client remains the tool target while focus changes", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.bindClient("first");
    session.activateClient("second");

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-first");
    const result = session.callTool("canvas_create_text_node", { text: "bound" });
    const call = first.event("tool_call");
    assert.equal(second.event("tool_call"), undefined);
    session.resolveResult("first", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.equal(field(await result, "appliedOpCount"), 1);

    session.releaseClient("first");
    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-second");
});

test("closing the bound client falls back to the active client", async (t) => {
    const session = new CanvasSession();
    const first = connect(session, "first");
    const second = connect(session, "second");
    t.after(() => {
        first.close();
        second.close();
    });
    session.updateState(snapshot("canvas-first"), "first");
    session.updateState(snapshot("canvas-second"), "second");
    session.bindClient("first");
    session.activateClient("second");
    first.close();

    assert.equal(field(await session.callTool("canvas_get_state", {}), "projectId"), "canvas-second");
    const result = session.callTool("canvas_create_text_node", { text: "fallback" });
    const call = second.event("tool_call");
    session.resolveResult("second", { requestId: String(field(call, "requestId")), result: { ok: true } });
    assert.equal(field(await result, "appliedOpCount"), 1);
});

function connect(session: CanvasSession, clientId: string) {
    const response = new FakeSseResponse();
    session.openEvents(new URL(`http://127.0.0.1/events?clientId=${clientId}`), response as unknown as ServerResponse);
    return response;
}

function snapshot(projectId: string) {
    return { projectId, title: projectId, nodes: [], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
}

function field(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

class FakeSseResponse extends EventEmitter {
    private chunks: string[] = [];

    writeHead() {
        return this;
    }

    write(chunk: string) {
        this.chunks.push(chunk);
        return true;
    }

    event(type: string, index = 0) {
        const chunk = this.chunks.filter((item) => item.startsWith(`event: ${type}\n`))[index];
        const data = chunk?.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        return data ? (JSON.parse(data) as unknown) : undefined;
    }

    async waitForEvent(type: string, eventIndex = 0) {
        for (let index = 0; index < 50; index += 1) {
            const value = this.event(type, eventIndex);
            if (value !== undefined) return value;
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return undefined;
    }

    close() {
        this.emit("close");
    }
}
