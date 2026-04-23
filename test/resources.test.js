const { test } = require("node:test");
const assert = require("node:assert");

function loadResourcesModule() {
  delete require.cache[require.resolve("../dist/resources.js")];
  return require("../dist/resources.js");
}

test("prior://agent/status omits email from assistant-facing resource output", async () => {
  const { registerResources } = loadResourcesModule();
  const handlers = new Map();
  const server = {
    registerResource(name, _uri, _config, handler) {
      handlers.set(name, handler);
    },
  };
  const client = {
    async getStatus() {
      return {
        id: "acct_123",
        authType: "oidc",
        credits: 42,
        tier: "pro",
        contributions: 7,
        displayName: "Prior Human",
        email: "human@example.com",
      };
    },
  };

  registerResources(server, { client });
  const result = await handlers.get("agent-status")();
  const payload = JSON.parse(result.contents[0].text);

  assert.deepStrictEqual(payload, {
    id: "acct_123",
    authType: "oidc",
    credits: 42,
    tier: "pro",
    contributions: 7,
    displayName: "Prior Human",
  });
});
