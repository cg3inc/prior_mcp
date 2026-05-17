/**
 * Prior API client shared between local MCP (stdio) and remote MCP server.
 *
 * Supports:
 * - API keys for durable machine auth
 * - first-party OIDC browser login for interactive human auth
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_PATH = path.join(os.homedir(), ".prior", "config.json");
export const OIDC_CLIENT_ID = "prior-mcp";

const VERSION = "0.7.0";
const DEFAULT_TIMEOUT_MS = 180_000;
// Renamed prior:read/prior:write → account:read/account:write on 2026-04-26 per
// the oauth-scope-namespace-overhaul initiative (operations/initiatives/...).
// Breaking change for callers using DEFAULT_OIDC_SCOPES; bump npm minor.
const DEFAULT_OIDC_SCOPES = "openid profile email account:read account:write offline_access";

export type PriorAuthType = "api_key" | "oidc";

export interface PriorConfig {
  authType?: PriorAuthType;
  apiKey?: string;
  agentId?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
  displayName?: string;
  email?: string;
}

export interface PriorStatus {
  id: string;
  authType: PriorAuthType;
  credits: number;
  tier: string;
  contributions?: number;
  displayName?: string;
  email?: string;
}

export interface PriorClientOptions {
  /** Base URL for the Prior API */
  apiUrl?: string;
  /** Pre-set API key (e.g. from env var or session state) */
  apiKey?: string;
  /** Pre-set agent ID */
  agentId?: string;
  /** Pre-set OIDC access token */
  accessToken?: string;
  /** Pre-set OIDC refresh token */
  refreshToken?: string;
  /** Pre-set expiry timestamp */
  expiresAt?: string;
  /** Whether to persist config to ~/.prior/config.json (default: true) */
  persistConfig?: boolean;
  /** User-Agent string override */
  userAgent?: string;
  /** Trace ID to forward as X-Request-Id on all outbound API calls */
  traceId?: string;
}

interface OidcDiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface UserInfoResponse {
  sub?: string;
  name?: string;
  email?: string;
}

function compactConfig(config: PriorConfig): PriorConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as PriorConfig;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deriveExpiresAt(accessToken: string, expiresIn?: number): string | undefined {
  if (typeof expiresIn === "number" && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }
  const payload = decodeJwtPayload(accessToken);
  if (typeof payload?.exp === "number") {
    return new Date(payload.exp * 1000).toISOString();
  }
  return undefined;
}

function isExpired(expiresAt?: string, accessToken?: string): boolean {
  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isNaN(expiryMs)) {
      return expiryMs <= (Date.now() + 30_000);
    }
  }
  const payload = accessToken ? decodeJwtPayload(accessToken) : null;
  if (typeof payload?.exp === "number") {
    return (payload.exp * 1000) <= (Date.now() + 30_000);
  }
  return false;
}

function launchDetached(command: string, args: string[]): void {
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      launchDetached("open", [url]);
    } else if (platform === "win32") {
      launchDetached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
    } else {
      launchDetached("xdg-open", [url]);
    }
  } catch {
    // Best effort only. We always print the URL for manual fallback.
  }
}

function extractData<T>(value: unknown): T {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function buildMissingAuthMessage(): string {
  return [
    "No Prior auth configured.",
    "Run `prior-mcp --login` for browser OIDC auth,",
    "configure PRIOR_API_KEY for durable machine auth,",
    "or use PRIOR_IDENTITY_ACCESS_TOKEN only for advanced manual delegated-token overrides.",
  ].join(" ");
}

function hardenConfigPermissions(filePath: string): void {
  const configDir = path.dirname(filePath);

  if (process.platform === "win32") {
    try {
      childProcess.execSync(`icacls "${configDir}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`, {
        stdio: "ignore",
        shell: "cmd.exe",
      });
    } catch {
      // Best effort only.
    }
    try {
      childProcess.execSync(`icacls "${filePath}" /inheritance:r /grant:r "%USERNAME%:F"`, {
        stdio: "ignore",
        shell: "cmd.exe",
      });
    } catch {
      // Best effort only.
    }
    return;
  }

  try {
    fs.chmodSync(configDir, 0o700);
  } catch {
    // Best effort only.
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
}

export class PriorApiClient {
  private apiUrl: string;
  private _authType: PriorAuthType | undefined;
  private _apiKey: string | undefined;
  private _agentId: string | undefined;
  private _accessToken: string | undefined;
  private _refreshToken: string | undefined;
  private _expiresAt: string | undefined;
  private _accountId: string | undefined;
  private _displayName: string | undefined;
  private _email: string | undefined;
  private persistConfig: boolean;
  private userAgent: string;
  private traceId: string | undefined;

  constructor(options: PriorClientOptions = {}) {
    this.apiUrl = options.apiUrl || process.env.PRIOR_API_URL || "https://api.cg3.io";
    this._apiKey = options.apiKey || process.env.PRIOR_API_KEY;
    this._agentId = options.agentId;
    this._accessToken = options.accessToken || process.env.PRIOR_IDENTITY_ACCESS_TOKEN;
    this._refreshToken = options.refreshToken || process.env.PRIOR_REFRESH_TOKEN;
    this._expiresAt = options.expiresAt;
    this.persistConfig = options.persistConfig ?? true;
    this.userAgent = options.userAgent || `prior-mcp/${VERSION}`;
    this.traceId = options.traceId;

    if (this._accessToken) {
      this._authType = "oidc";
    } else if (this._apiKey) {
      this._authType = "api_key";
    }

    if ((!this._apiKey && !this._accessToken) && this.persistConfig) {
      const config = this.loadConfig();
      if (config) {
        this.applyConfig(config);
      }
    }
  }

  get authType(): PriorAuthType | undefined { return this._authType; }
  get apiKey(): string | undefined { return this._apiKey; }
  get agentId(): string | undefined { return this._agentId; }
  get accessToken(): string | undefined { return this._accessToken; }

  private prefersOidc(): boolean {
    if (this._authType === "oidc") return true;
    if (this._authType === "api_key") return false;
    return Boolean(this._accessToken || this._refreshToken);
  }

  loadConfig(): PriorConfig | null {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      return JSON.parse(raw) as PriorConfig;
    } catch {
      return null;
    }
  }

  saveConfig(config: PriorConfig): void {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(compactConfig(config), null, 2));
    hardenConfigPermissions(CONFIG_PATH);
  }

  clearOidcConfig(): void {
    const existing = this.loadConfig() || {};
    const next = { ...existing };
    delete next.authType;
    delete next.accessToken;
    delete next.refreshToken;
    delete next.expiresAt;
    delete next.accountId;
    delete next.displayName;
    delete next.email;
    this.saveConfig(next);
    this._accessToken = undefined;
    this._refreshToken = undefined;
    this._expiresAt = undefined;
    this._accountId = undefined;
    this._displayName = undefined;
    this._email = undefined;
    this._authType = this._apiKey ? "api_key" : undefined;
  }

  async logout(): Promise<{ remoteRevoked: boolean }> {
    let remoteRevoked = false;

    if (this._refreshToken) {
      try {
        const revokeUrl = new URL("/revoke", this.apiUrl).toString();
        const response = await fetch(revokeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": this.userAgent,
          },
          body: new URLSearchParams({
            token: this._refreshToken,
            token_type_hint: "refresh_token",
          }).toString(),
          signal: AbortSignal.timeout(5_000),
        });
        remoteRevoked = response.ok;
      } catch {
        // Best effort only. We always clear local state.
      }
    }

    this.clearOidcConfig();
    return { remoteRevoked };
  }

  private applyConfig(config: PriorConfig): void {
    this._authType = config.authType
      || (config.accessToken ? "oidc" : config.apiKey ? "api_key" : undefined);
    this._apiKey = this._apiKey || config.apiKey;
    this._agentId = this._agentId || config.agentId;
    this._accessToken = this._accessToken || config.accessToken;
    this._refreshToken = this._refreshToken || config.refreshToken;
    this._expiresAt = this._expiresAt || config.expiresAt;
    this._accountId = this._accountId || config.accountId;
    this._displayName = this._displayName || config.displayName;
    this._email = this._email || config.email;
  }

  private persistCurrentConfig(patch: PriorConfig): void {
    if (!this.persistConfig) return;
    const base = this.loadConfig() || {};
    this.saveConfig({ ...base, ...patch });
  }

  private async loadDiscovery(): Promise<OidcDiscoveryDocument> {
    const discoveryUrl = new URL("/.well-known/openid-configuration", this.apiUrl).toString();
    const res = await fetch(discoveryUrl, {
      headers: { "User-Agent": this.userAgent },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed (${res.status})`);
    }
    return await res.json() as OidcDiscoveryDocument;
  }

  private async fetchUserInfo(token: string, explicitUrl?: string): Promise<UserInfoResponse> {
    const userinfoUrl = explicitUrl || new URL("/userinfo", this.apiUrl).toString();
    const res = await fetch(userinfoUrl, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": this.userAgent,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`userinfo request failed (${res.status})`);
    }
    return await res.json() as UserInfoResponse;
  }

  async loginInteractive(): Promise<PriorConfig> {
    const discovery = await this.loadDiscovery();
    const authorizeUrl = discovery.authorization_endpoint || new URL("/authorize", this.apiUrl).toString();
    const tokenUrl = discovery.token_endpoint || new URL("/token", this.apiUrl).toString();
    const userinfoUrl = discovery.userinfo_endpoint || new URL("/userinfo", this.apiUrl).toString();
    const state = crypto.randomBytes(16).toString("hex");
    const nonce = crypto.randomBytes(16).toString("hex");
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    return await new Promise<PriorConfig>((resolve, reject) => {
      let settled = false;
      const finishResolve = (config: PriorConfig) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(config);
      };
      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      };
      const closeServer = () => {
        try {
          server.close();
        } catch {
          // Ignore close races when the callback and timeout fire near-simultaneously.
        }
      };

      const server = http.createServer(async (req, res) => {
        if (!req.url?.startsWith("/callback")) {
          res.writeHead(404);
          res.end();
          return;
        }

        const callbackUrl = new URL(req.url, `http://${req.headers.host}`);
        const returnedState = callbackUrl.searchParams.get("state");
        const code = callbackUrl.searchParams.get("code");
        const error = callbackUrl.searchParams.get("error");

        if (returnedState !== state) {
          res.writeHead(403, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          res.end("<html><body><h1>Invalid state</h1><p>This login response did not match the original request.</p></body></html>");
          return;
        }

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          res.end(`<html><body><h1>Login cancelled</h1><p>${escapeHtml(error)}</p></body></html>`);
          finishReject(new Error(`OIDC login cancelled: ${error}`));
          closeServer();
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          res.end("<html><body><h1>Missing authorization code</h1></body></html>");
          finishReject(new Error("OIDC login failed: missing authorization code"));
          closeServer();
          return;
        }

        try {
          const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
          const tokenRes = await fetch(tokenUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": this.userAgent,
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: OIDC_CLIENT_ID,
              code,
              code_verifier: codeVerifier,
              redirect_uri: redirectUri,
            }).toString(),
            signal: AbortSignal.timeout(10_000),
          });

          const tokenBody = await tokenRes.json() as TokenResponse;
          if (!tokenRes.ok || !tokenBody.access_token) {
            const message = tokenBody.error_description || tokenBody.error || `OIDC token exchange failed (${tokenRes.status})`;
            res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
            res.end(`<html><body><h1>Login failed</h1><p>${escapeHtml(message)}</p></body></html>`);
            finishReject(new Error(message));
            closeServer();
            return;
          }

          const userinfo = await this.fetchUserInfo(tokenBody.access_token, userinfoUrl);
          const config: PriorConfig = {
            ...(this.loadConfig() || {}),
            authType: "oidc",
            accessToken: tokenBody.access_token,
            refreshToken: tokenBody.refresh_token,
            expiresAt: deriveExpiresAt(tokenBody.access_token, tokenBody.expires_in),
            accountId: userinfo.sub,
            displayName: userinfo.name,
            email: userinfo.email,
          };

          this.applyConfig(config);
          this.persistCurrentConfig(config);

          res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          res.end(`<html><body><h1>Connected to Prior</h1><p>You can close this tab.</p><script>setTimeout(()=>window.close(), 1500)</script></body></html>`);
          finishResolve(config);
          closeServer();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          res.writeHead(500, { "Content-Type": "text/html", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          res.end(`<html><body><h1>Login failed</h1><p>${escapeHtml(message)}</p></body></html>`);
          finishReject(new Error(message));
          closeServer();
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as { port: number };
        const redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const loginUrl = `${authorizeUrl}?${new URLSearchParams({
          response_type: "code",
          client_id: OIDC_CLIENT_ID,
          redirect_uri: redirectUri,
          scope: DEFAULT_OIDC_SCOPES,
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        }).toString()}`;

        process.stderr.write(`[prior-mcp] Opening browser login for ${OIDC_CLIENT_ID}\n`);
        process.stderr.write(`[prior-mcp] If the browser does not open, visit: ${loginUrl}\n`);
        openBrowser(loginUrl);
      });

      const timeoutHandle = setTimeout(() => {
        closeServer();
        finishReject(new Error("OIDC login timed out"));
      }, DEFAULT_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });
  }

  private async refreshOidcAccessToken(): Promise<boolean> {
    if (!this._refreshToken) {
      return false;
    }

    const tokenUrl = new URL("/token", this.apiUrl).toString();
    try {
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.userAgent,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: OIDC_CLIENT_ID,
          refresh_token: this._refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });

      const body = await res.json() as TokenResponse;
      if (!res.ok || !body.access_token) {
        this.clearOidcConfig();
        return false;
      }

      this._authType = "oidc";
      this._accessToken = body.access_token;
      this._refreshToken = body.refresh_token || this._refreshToken;
      this._expiresAt = deriveExpiresAt(body.access_token, body.expires_in);
      this.persistCurrentConfig({
        authType: "oidc",
        accessToken: this._accessToken,
        refreshToken: this._refreshToken,
        expiresAt: this._expiresAt,
        accountId: this._accountId,
        displayName: this._displayName,
        email: this._email,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureAuth(): Promise<string> {
    if (this.prefersOidc()) {
      this._authType = "oidc";
      if (this._accessToken && !isExpired(this._expiresAt, this._accessToken)) {
        return this._accessToken;
      }
      const refreshed = await this.refreshOidcAccessToken();
      if (refreshed && this._accessToken) {
        return this._accessToken;
      }
      if (this._accessToken || this._refreshToken) {
        throw new Error(
          "Stored Prior OIDC auth is no longer usable. Run `prior-mcp --login` to refresh it " +
          "or `prior-mcp --logout` to clear it before falling back to machine auth.",
        );
      }
    }

    if (this._apiKey) {
      this._authType = "api_key";
      return this._apiKey;
    }

    throw new Error(buildMissingAuthMessage());
  }

  async getStatus(): Promise<PriorStatus> {
    const auth = await this.ensureAuth();

    if (this._authType === "oidc") {
      const [accountEnvelope, profileEnvelope, userinfo] = await Promise.all([
        this.request("GET", "/v1/account", undefined, auth),
        this.request("GET", "/v1/prior/me/profile", undefined, auth),
        this.fetchUserInfo(auth),
      ]);
      const account = extractData<any>(accountEnvelope);
      const profile = extractData<any>(profileEnvelope);
      const displayName = userinfo.name || this._displayName;
      const email = userinfo.email || this._email;

      this._accountId = userinfo.sub || account?.account?.id || this._accountId;
      this._displayName = displayName;
      this._email = email;
      this.persistCurrentConfig({
        authType: "oidc",
        accessToken: this._accessToken,
        refreshToken: this._refreshToken,
        expiresAt: this._expiresAt,
        accountId: this._accountId,
        displayName: this._displayName,
        email: this._email,
      });

      return {
        id: account?.account?.id || userinfo.sub || "",
        authType: "oidc",
        credits: Number(profile?.subscription?.credits ?? 0),
        tier: profile?.subscription?.tier || "free",
        contributions: profile?.reputation?.contributionCount,
        displayName,
        email,
      };
    }

    const data = await this.request("GET", "/v1/agents/me", undefined, auth);
    const agent = extractData<any>(data);
    return {
      id: agent?.id || "",
      authType: "api_key",
      credits: agent?.credits ?? 0,
      tier: agent?.tier || "free",
      contributions: agent?.contributions,
      displayName: agent?.agentName,
    };
  }

  async request(method: string, requestPath: string, body?: unknown, key?: string, requestId?: string): Promise<unknown> {
    const auth = key || await this.ensureAuth();
    const res = await fetch(`${this.apiUrl}${requestPath}`, {
      method,
      headers: {
        "Authorization": `Bearer ${auth}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        ...(requestId || this.traceId ? { "X-Request-Id": requestId || this.traceId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${text}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
