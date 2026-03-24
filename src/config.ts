import { readFileSync } from "fs";
import { join } from "path";

const ENV_FILE = join(import.meta.dir, "..", ".env");

function loadEnv(): void {
  try {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        const val = m[2].replace(/^(['"])(.*)\1$/, "$2");
        process.env[m[1]] = val;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`github-channels: failed to read .env: ${err}\n`);
    }
  }
}

loadEnv();

export const PORT = parseInt(process.env.PORT || "8789", 10);
export const HOST = process.env.HOST || "127.0.0.1";
export const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
export const ALLOWED_REPOS = (process.env.GITHUB_REPOS || "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
export const ALLOWED_EVENTS = (process.env.GITHUB_EVENTS || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
export const TRUSTED_ACTORS = new Set(
  (process.env.TRUSTED_ACTORS || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
);
export const CHANNEL_TIP = process.env.CHANNEL_TIP || "";
export const INITIAL_MUTED = process.env.MUTED === "true";

if (!WEBHOOK_SECRET) {
  process.stderr.write(
    `github-channels: GITHUB_WEBHOOK_SECRET required\n` +
    `  set in ${ENV_FILE}\n` +
    `  generate: openssl rand -hex 20\n`
  );
  process.exit(1);
}
