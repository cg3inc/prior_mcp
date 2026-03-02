/**
 * Prior API client — shared between local MCP (stdio) and remote MCP server.
 *
 * Requires an API key via PRIOR_API_KEY env var or ~/.prior/config.json.
 * Get your key at https://prior.cg3.io/account
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const CONFIG_PATH = path.join(os.homedir(), ".prior", "config.json");
const VERSION = "0.5.0";

export interface PriorConfig {
  apiKey: string;
  agentId: string;
}

export interface PriorClientOptions {
  /** Base URL for the Prior API */
  apiUrl?: string;
  /** Pre-set API key (e.g. from env var or session state) */
  apiKey?: string;
  /** Pre-set agent ID */
  agentId?: string;
  /** Whether to persist config to ~/.prior/config.json (default: true) */
  persistConfig?: boolean;
  /** User-Agent string override */
  userAgent?: string;
}

export class PriorApiClient {
  private apiUrl: string;
  private _apiKey: string | undefined;
  private _agentId: string | undefined;
  private persistConfig: boolean;
  private userAgent: string;

  constructor(options: PriorClientOptions = {}) {
    this.apiUrl = options.apiUrl || process.env.PRIOR_API_URL || "https://api.cg3.io";
    this._apiKey = options.apiKey || process.env.PRIOR_API_KEY;
    this._agentId = options.agentId;
    this.persistConfig = options.persistConfig ?? true;
    this.userAgent = options.userAgent || `prior-mcp/${VERSION}`;

    // Load config on startup if no key provided
    if (!this._apiKey && this.persistConfig) {
      const config = this.loadConfig();
      if (config) {
        this._apiKey = config.apiKey;
        this._agentId = config.agentId;
      }
    }

    // Require an API key — no more auto-registration
    if (!this._apiKey) {
      throw new Error(
        "No Prior API key configured. " +
        "Get your key at https://prior.cg3.io/getkey then set PRIOR_API_KEY in your environment, " +
        "or add it to ~/.prior/config.json as {\"apiKey\": \"...\"}."
      );
    }
  }

  get apiKey(): string | undefined { return this._apiKey; }
  get agentId(): string | undefined { return this._agentId; }

  loadConfig(): PriorConfig | null {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      return JSON.parse(raw) as PriorConfig;
    } catch {
      return null;
    }
  }

  saveConfig(config: PriorConfig): void {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  async request(method: string, path: string, body?: unknown, key?: string): Promise<unknown> {
    const k = key || this._apiKey;
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        ...(k ? { "Authorization": `Bearer ${k}` } : {}),
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
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
