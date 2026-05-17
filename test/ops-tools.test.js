const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { PriorApiClient } = require("../dist/client.js");
const { registerTools } = require("../dist/tools.js");
const {
  OPS_TOOL_NAMES,
  buildOpsToolRequest,
  isOpsToolsEnabled,
  registerOpsTools,
} = require("../dist/ops-tools.js");

function captureRegisteredTools() {
  const handlers = new Map();
  const names = [];
  return {
    names,
    handlers,
    server: {
      registerTool(name, _config, handler) {
        names.push(name);
        handlers.set(name, handler);
      },
    },
  };
}

describe("ops MCP tools", () => {
  const originalEnableOpsTools = process.env.PRIOR_MCP_ENABLE_OPS_TOOLS;

  afterEach(() => {
    if (originalEnableOpsTools === undefined) {
      delete process.env.PRIOR_MCP_ENABLE_OPS_TOOLS;
    } else {
      process.env.PRIOR_MCP_ENABLE_OPS_TOOLS = originalEnableOpsTools;
    }
  });

  test("maps read-only ops tools to admin API endpoints", () => {
    assert.deepStrictEqual(buildOpsToolRequest("ops_get_summary", {
      window: "24h",
      surface: "business",
    }), {
      method: "GET",
      path: "/v1/admin/ops/summary?window=24h&surface=business",
    });

    assert.deepStrictEqual(buildOpsToolRequest("ops_list_attention", {
      limit: 10,
      surface: "equip.release",
    }), {
      method: "GET",
      path: "/v1/admin/ops/attention?surface=equip.release&limit=10",
    });

    assert.deepStrictEqual(buildOpsToolRequest("ops_get_attention_item", {
      id: "auth/needs review",
    }), {
      method: "GET",
      path: "/v1/admin/ops/attention/auth%2Fneeds%20review",
    });

    assert.deepStrictEqual(buildOpsToolRequest("ops_get_recent_changes", {
      window: "7d",
    }), {
      method: "GET",
      path: "/v1/admin/ops/recent-changes?window=7d",
    });

    assert.deepStrictEqual(buildOpsToolRequest("ops_get_runbook", {
      id: "rb-equip-channel-bad-release",
    }), {
      method: "GET",
      path: "/v1/admin/ops/runbooks/rb-equip-channel-bad-release",
    });
  });

  test("validates required detail identifiers", () => {
    assert.throws(() => buildOpsToolRequest("ops_get_attention_item"), /requires id/);
    assert.throws(() => buildOpsToolRequest("ops_get_runbook", { id: "" }), /requires id/);
    assert.throws(() => buildOpsToolRequest("ops_missing"), /Unknown ops tool/);
  });

  test("requires an explicit opt-in flag", () => {
    assert.strictEqual(isOpsToolsEnabled("1"), true);
    assert.strictEqual(isOpsToolsEnabled("true"), true);
    assert.strictEqual(isOpsToolsEnabled("TRUE"), true);
    assert.strictEqual(isOpsToolsEnabled("0"), false);
    assert.strictEqual(isOpsToolsEnabled(undefined), false);
  });

  test("does not register ops tools by default", () => {
    delete process.env.PRIOR_MCP_ENABLE_OPS_TOOLS;
    const { names, server } = captureRegisteredTools();

    registerTools(server, { client: {} });

    assert(!OPS_TOOL_NAMES.some((name) => names.includes(name)));
    assert(names.includes("prior_search"));
  });

  test("registers ops tools when enabled explicitly", () => {
    const { names, server } = captureRegisteredTools();

    registerTools(server, { client: {}, enableOpsTools: true });

    for (const name of OPS_TOOL_NAMES) {
      assert(names.includes(name), `${name} should be registered`);
    }
    assert(names.includes("prior_search"));
  });

  test("ops tool handlers attach request ids and preserve backend payloads", async () => {
    const { handlers, server } = captureRegisteredTools();
    const requests = [];
    const client = {
      async request(method, path, body, key, requestId) {
        requests.push({ method, path, body, key, requestId });
        return { ok: true, surface: "business" };
      },
    };

    registerOpsTools(server, { client });
    const result = await handlers.get("ops_get_summary")({ window: "24h" });

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].method, "GET");
    assert.strictEqual(requests[0].path, "/v1/admin/ops/summary?window=24h");
    assert.strictEqual(requests[0].body, undefined);
    assert.strictEqual(requests[0].key, undefined);
    assert.match(requests[0].requestId, /^ops-ops_get_summary-/);
    assert.deepStrictEqual(result.structuredContent.response, { ok: true, surface: "business" });
    assert.strictEqual(result.structuredContent.requestId, requests[0].requestId);
    assert(result.content[0].text.includes(`requestId: ${requests[0].requestId}`));
  });
});

describe("PriorApiClient request ids", () => {
  let server;
  let apiUrl;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        requestId: req.headers["x-request-id"],
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("forwards per-call request id over trace id", async () => {
    const client = new PriorApiClient({
      apiUrl,
      apiKey: "ask_test",
      persistConfig: false,
      traceId: "trace-default",
    });

    const response = await client.request("GET", "/test", undefined, undefined, "ops-test-request");

    assert.deepStrictEqual(response, { requestId: "ops-test-request" });
  });
});
