const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ORIGINAL_ENV = { ...process.env };

function loadClientModule() {
  delete require.cache[require.resolve("../dist/client.js")];
  return require("../dist/client.js");
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("PriorApiClient auth flows", () => {
  let originalFetch;
  let tempHome;

  beforeEach(() => {
    originalFetch = global.fetch;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "prior-mcp-auth-"));

    process.env = { ...ORIGINAL_ENV };
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.PRIOR_API_KEY;
    delete process.env.PRIOR_ACCESS_TOKEN;
    delete process.env.PRIOR_REFRESH_TOKEN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  test("stored OIDC auth wins over stored API key for human sessions", async () => {
    const { PriorApiClient, CONFIG_PATH } = loadClientModule();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      authType: "oidc",
      apiKey: "prior_machine_key",
      accessToken: "oidc_access_token",
      refreshToken: "oidc_refresh_token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, null, 2));

    const seenAuthHeaders = [];
    global.fetch = async (_url, options = {}) => {
      seenAuthHeaders.push(options.headers.Authorization);
      return jsonResponse({ ok: true });
    };

    const client = new PriorApiClient({ apiUrl: "https://prior.test" });
    await client.request("GET", "/v1/account");

    assert.strictEqual(client.authType, "oidc");
    assert.deepStrictEqual(seenAuthHeaders, ["Bearer oidc_access_token"]);
  });

  test("OIDC status reads use account, prior profile, and userinfo endpoints", async () => {
    const { PriorApiClient, CONFIG_PATH } = loadClientModule();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      authType: "oidc",
      accessToken: "oidc_access_token",
      refreshToken: "oidc_refresh_token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, null, 2));

    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url, auth: options.headers.Authorization });

      if (url === "https://prior.test/v1/account") {
        return jsonResponse({ data: { account: { id: "acct_123" } } });
      }
      if (url === "https://prior.test/v1/prior/me/profile") {
        return jsonResponse({
          data: {
            subscription: { credits: 42, tier: "pro" },
            reputation: { contributionCount: 7 },
          },
        });
      }
      if (url === "https://prior.test/userinfo") {
        return jsonResponse({
          sub: "acct_123",
          name: "Prior Human",
          email: "human@example.com",
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    const client = new PriorApiClient({ apiUrl: "https://prior.test" });
    const status = await client.getStatus();
    const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

    assert.deepStrictEqual(status, {
      id: "acct_123",
      authType: "oidc",
      credits: 42,
      tier: "pro",
      contributions: 7,
      displayName: "Prior Human",
      email: "human@example.com",
    });
    assert.deepStrictEqual(
      calls.map((call) => call.url),
      [
        "https://prior.test/v1/account",
        "https://prior.test/v1/prior/me/profile",
        "https://prior.test/userinfo",
      ],
    );
    assert.strictEqual(persisted.authType, "oidc");
    assert.strictEqual(persisted.accountId, "acct_123");
    assert.strictEqual(persisted.displayName, "Prior Human");
    assert.strictEqual(persisted.email, "human@example.com");
  });

  test("API key status still uses the machine-auth agents endpoint", async () => {
    const { PriorApiClient } = loadClientModule();
    const seenUrls = [];

    global.fetch = async (url, options = {}) => {
      seenUrls.push({ url, auth: options.headers.Authorization });
      if (url === "https://prior.test/v1/agents/me") {
        return jsonResponse({
          data: {
            id: "agent_123",
            credits: 9,
            tier: "team",
            contributions: 3,
            agentName: "Machine Agent",
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const client = new PriorApiClient({
      apiUrl: "https://prior.test",
      apiKey: "prior_machine_key",
      persistConfig: false,
    });
    const status = await client.getStatus();

    assert.deepStrictEqual(status, {
      id: "agent_123",
      authType: "api_key",
      credits: 9,
      tier: "team",
      contributions: 3,
      displayName: "Machine Agent",
    });
    assert.deepStrictEqual(seenUrls, [{
      url: "https://prior.test/v1/agents/me",
      auth: "Bearer prior_machine_key",
    }]);
  });

  test("logout revokes the stored refresh token before clearing local OIDC state", async () => {
    const { PriorApiClient, CONFIG_PATH } = loadClientModule();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      authType: "oidc",
      apiKey: "prior_machine_key",
      accessToken: "oidc_access_token",
      refreshToken: "oidc_refresh_token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accountId: "acct_123",
      displayName: "Prior Human",
      email: "human@example.com",
    }, null, 2));

    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method, body: options.body });
      return jsonResponse({}, 200);
    };

    const client = new PriorApiClient({ apiUrl: "https://prior.test" });
    const result = await client.logout();

    const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    assert.strictEqual(result.remoteRevoked, true);
    assert.deepStrictEqual(calls, [{
      url: "https://prior.test/revoke",
      method: "POST",
      body: "token=oidc_refresh_token&token_type_hint=refresh_token",
    }]);
    assert.deepStrictEqual(persisted, { apiKey: "prior_machine_key" });
    assert.strictEqual(client.authType, "api_key");
    assert.strictEqual(client.apiKey, "prior_machine_key");
    assert.strictEqual(client.accessToken, undefined);
  });

  test("logout still clears local OIDC state when remote revoke fails", async () => {
    const { PriorApiClient, CONFIG_PATH } = loadClientModule();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      authType: "oidc",
      accessToken: "oidc_access_token",
      refreshToken: "oidc_refresh_token",
    }, null, 2));

    global.fetch = async () => {
      throw new Error("network down");
    };

    const client = new PriorApiClient({ apiUrl: "https://prior.test" });
    const result = await client.logout();
    const persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

    assert.strictEqual(result.remoteRevoked, false);
    assert.deepStrictEqual(persisted, {});
    assert.strictEqual(client.authType, undefined);
    assert.strictEqual(client.accessToken, undefined);
  });
});
