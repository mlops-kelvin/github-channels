import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { homedir } from "os";

// --- Config paths (follows Discord plugin convention) ---

export const configDir = join(homedir(), ".claude", "channels", "github-channels");
export const configFile = join(configDir, "config.json");
export const secretFile = join(homedir(), ".github-channels-secret");

// --- Config types ---

interface Config {
  port: number;
  host: string;
  repos: string[];
  events: string[];
  trusted_actors: string[];
  channel_tip: string;
  muted: boolean;
}

// --- Parse comma-separated string into list ---

function parseList(value: string): string[] {
  return value.split(",").map(s => s.trim()).filter(Boolean);
}

// --- Load config (env vars > config.json > defaults) ---

function loadConfig(): Config {
  const defaults: Config = {
    port: 8789,
    host: "127.0.0.1",
    repos: [],
    events: ["push", "pull_request", "issues", "issue_comment", "pull_request_review"],
    trusted_actors: [],
    channel_tip: "",
    muted: false,
  };

  // Base config: try config.json, then defaults
  let base = { ...defaults };

  if (existsSync(configFile)) {
    try {
      const raw = JSON.parse(readFileSync(configFile, "utf8"));
      base = {
        port: raw.port ?? defaults.port,
        host: raw.host ?? defaults.host,
        repos: raw.repos ?? defaults.repos,
        events: raw.events ?? defaults.events,
        trusted_actors: raw.trusted_actors ?? defaults.trusted_actors,
        channel_tip: raw.channel_tip ?? defaults.channel_tip,
        muted: raw.muted ?? defaults.muted,
      };
    } catch (err) {
      process.stderr.write(`github-channels: failed to parse ${configFile}: ${err}\n`);
    }
  } else {
    // No config found — create template on first run
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, JSON.stringify(defaults, null, 2) + "\n");
    process.stderr.write(
      `github-channels: created config template at ${configFile}\n` +
      `  edit it to add your repos and trusted actors\n`
    );
  }

  // Environment variables override everything (for CI/testing/deployment)
  return {
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : base.port,
    host: process.env.HOST || base.host,
    repos: process.env.GITHUB_REPOS ? parseList(process.env.GITHUB_REPOS) : base.repos,
    events: process.env.GITHUB_EVENTS ? parseList(process.env.GITHUB_EVENTS) : base.events,
    trusted_actors: process.env.TRUSTED_ACTORS ? parseList(process.env.TRUSTED_ACTORS) : base.trusted_actors,
    channel_tip: process.env.CHANNEL_TIP ?? base.channel_tip,
    muted: process.env.MUTED !== undefined ? process.env.MUTED === "true" : base.muted,
  };
}

// --- Webhook secret (auto-generated) ---

function loadOrCreateSecret(): string {
  // Check env first (for CI/testing)
  if (process.env.GITHUB_WEBHOOK_SECRET) {
    return process.env.GITHUB_WEBHOOK_SECRET;
  }

  // Read from secret file
  if (existsSync(secretFile)) {
    const secret = readFileSync(secretFile, "utf8").trim();
    if (secret) return secret;
  }

  // Auto-generate
  const secret = randomBytes(20).toString("hex");
  writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
  process.stderr.write(
    `github-channels: generated webhook secret at ${secretFile}\n` +
    `  use this value when configuring GitHub webhooks\n`
  );
  return secret;
}

// --- Exports ---

const config = loadConfig();

export const PORT = config.port;
export const HOST = config.host;
export const ALLOWED_REPOS = config.repos;
export const ALLOWED_EVENTS = config.events;
export const TRUSTED_ACTORS = new Set(config.trusted_actors.map(a => a.toLowerCase()));
export const CHANNEL_TIP = config.channel_tip;
export const INITIAL_MUTED = config.muted;
export const WEBHOOK_SECRET = loadOrCreateSecret();

if (!WEBHOOK_SECRET) {
  process.stderr.write(
    `github-channels: webhook secret is empty\n` +
    `  this should not happen — check ${secretFile}\n`
  );
  process.exit(1);
}
