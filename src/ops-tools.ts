import * as crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PriorApiClient } from "./client.js";
import { formatResults } from "./utils.js";

export const OPS_TOOL_NAMES = Object.freeze([
  "ops_get_summary",
  "ops_list_attention",
  "ops_get_attention_item",
  "ops_get_recent_changes",
  "ops_get_runbook",
] as const);

export interface RegisterOpsToolsOptions {
  client: PriorApiClient;
}

type OpsToolName = typeof OPS_TOOL_NAMES[number];

interface OpsToolRequest {
  method: "GET";
  path: string;
}

function appendQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export function isOpsToolsEnabled(value: string | undefined = process.env.PRIOR_MCP_ENABLE_OPS_TOOLS): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function buildOpsToolRequest(toolName: string, input: Record<string, unknown> = {}): OpsToolRequest {
  switch (toolName as OpsToolName) {
    case "ops_get_summary":
      return {
        method: "GET",
        path: appendQuery("/v1/admin/ops/summary", {
          window: typeof input.window === "string" ? input.window : undefined,
          surface: typeof input.surface === "string" ? input.surface : undefined,
        }),
      };
    case "ops_list_attention":
      return {
        method: "GET",
        path: appendQuery("/v1/admin/ops/attention", {
          surface: typeof input.surface === "string" ? input.surface : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        }),
      };
    case "ops_get_attention_item":
      if (typeof input.id !== "string" || !input.id) throw new Error("ops_get_attention_item requires id");
      return { method: "GET", path: `/v1/admin/ops/attention/${encodeURIComponent(input.id)}` };
    case "ops_get_recent_changes":
      return {
        method: "GET",
        path: appendQuery("/v1/admin/ops/recent-changes", {
          window: typeof input.window === "string" ? input.window : undefined,
          surface: typeof input.surface === "string" ? input.surface : undefined,
        }),
      };
    case "ops_get_runbook":
      if (typeof input.id !== "string" || !input.id) throw new Error("ops_get_runbook requires id");
      return { method: "GET", path: `/v1/admin/ops/runbooks/${encodeURIComponent(input.id)}` };
    default:
      throw new Error(`Unknown ops tool: ${toolName}`);
  }
}

function makeOpsRequestId(toolName: string): string {
  return `ops-${toolName}-${crypto.randomUUID()}`;
}

async function callOpsApi(client: PriorApiClient, toolName: string, input: Record<string, unknown>) {
  const request = buildOpsToolRequest(toolName, input);
  const requestId = makeOpsRequestId(toolName);
  const response = await client.request(request.method, request.path, undefined, undefined, requestId);
  return {
    structuredContent: {
      requestId,
      response,
    },
    content: [{
      type: "text" as const,
      text: `requestId: ${requestId}\n${formatResults(response)}`,
    }],
  };
}

const opsOutputSchema = {
  requestId: z.string(),
  response: z.any(),
};

const windowSurfaceInput = {
  window: z.string().optional().describe("Window such as 24h, 7d, or 30d. Defaults to backend behavior when omitted."),
  surface: z.string().optional().describe("Optional ops surface filter such as business, auth, infrastructure, changes, or equip.release."),
};

export function registerOpsTools(server: McpServer, { client }: RegisterOpsToolsOptions): void {
  server.registerTool("ops_get_summary", {
    title: "Get CG3 Ops Summary",
    description: "Read-only admin operator summary. Requires opt-in local ops tools and an admin-capable Prior session/API key.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: windowSurfaceInput,
    outputSchema: opsOutputSchema,
  }, async (input) => callOpsApi(client, "ops_get_summary", input));

  server.registerTool("ops_list_attention", {
    title: "List CG3 Ops Attention Items",
    description: "Read-only admin attention list for CG3 operator surfaces. Requires admin-capable Prior auth.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      surface: z.string().optional().describe("Optional ops surface filter."),
      limit: z.number().optional().describe("Maximum number of items. Backend bounds the value."),
    },
    outputSchema: opsOutputSchema,
  }, async (input) => callOpsApi(client, "ops_list_attention", input));

  server.registerTool("ops_get_attention_item", {
    title: "Get CG3 Ops Attention Item",
    description: "Read-only admin detail for one ops attention item. Requires admin-capable Prior auth.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      id: z.string().describe("Stable attention item ID."),
    },
    outputSchema: opsOutputSchema,
  }, async (input) => callOpsApi(client, "ops_get_attention_item", input));

  server.registerTool("ops_get_recent_changes", {
    title: "Get CG3 Ops Recent Changes",
    description: "Read-only admin recent-change projection with evidence links. Requires admin-capable Prior auth.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: windowSurfaceInput,
    outputSchema: opsOutputSchema,
  }, async (input) => callOpsApi(client, "ops_get_recent_changes", input));

  server.registerTool("ops_get_runbook", {
    title: "Get CG3 Ops Runbook",
    description: "Read-only admin runbook lookup for an ops attention item or surface. Requires admin-capable Prior auth.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      id: z.string().describe("Stable runbook ID, e.g. rb-equip-channel-bad-release."),
    },
    outputSchema: opsOutputSchema,
  }, async (input) => callOpsApi(client, "ops_get_runbook", input));
}
