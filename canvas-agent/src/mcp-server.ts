import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "./config.js";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "./schemas.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };

export async function startMcpServer() {
    const config = loadConfig(true);
    const workspacePath = process.cwd();
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, config, workspacePath, name));
    await server.connect(new StdioServerTransport());
    void postCanvasAgentWorkspace(config, workspacePath);
}

function registerCanvasTool(server: McpServer, config: CanvasAgentConfig, workspacePath: string, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        const result = await postCanvasAgentTool(config, workspacePath, name, schema.parse(input));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
}

async function postCanvasAgentTool(config: CanvasAgentConfig, workspacePath: string, name: ToolName, input: unknown) {
    const res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ name, input, workspacePath }) });
    const body = (await res.json()) as CanvasAgentToolResponse;
    if (!body.ok) throw new Error(body.error || "tool call failed");
    return body.result;
}

async function postCanvasAgentWorkspace(config: CanvasAgentConfig, workspacePath: string) {
    try {
        await fetch(`${config.url}/mcp/connect`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ workspacePath }) });
    } catch {
        // HTTP Agent 可能尚未启动，首次工具调用会再次上报工作空间。
    }
}
