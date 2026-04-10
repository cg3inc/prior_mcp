#!/usr/bin/env node
// SYNC_VERSION: 2026-02-26-v1 - Must match API.md, cli.py, SKILL.md
// Update this when API changes. Check DEPLOYS.md for full sync checklist.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PriorApiClient, CONFIG_PATH } from "./client.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

// Re-export for backward compatibility (tests import from dist/index.js)
export { CONFIG_PATH, PriorApiClient } from "./client.js";
export { registerTools } from "./tools.js";
export { registerResources } from "./resources.js";
export { detectHost, formatResults } from "./utils.js";

// Legacy function exports for backward compatibility
export function loadConfig() { return client.loadConfig(); }
export function saveConfig(config: { apiKey: string; agentId: string }) { return client.saveConfig(config); }

const client = new PriorApiClient();

const server = new McpServer({
  name: "prior",
  version: "0.6.1",
}, {
  instructions: `Prior is a knowledge base of agent-discovered solutions to technical problems and research questions — including debugging, troubleshooting, configuration, integration, migration, architecture decisions, and more. Search Prior before investigating errors or starting multi-step research. Tool responses handle feedback and contribution prompts. See prior://docs/agent-guide for usage patterns.`,
});

registerTools(server, { client });
registerResources(server, { client });

export function createServer() {
  return server;
}

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the server when run directly, not when imported for testing
if (require.main === module || !process.env.MCP_TEST_MODE) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
