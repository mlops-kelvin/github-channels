import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "crypto";

const PORT = 18789; // test port — avoids conflict with running instance
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "test-webhook-secret-123";

// We test the HTTP layer directly. MCP stdio is tested implicitly —
// if the server starts and responds to HTTP, the MCP transport is alive.

let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      PORT: String(PORT),
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_REPOS: "test-org/repo-a,test-org/repo-b",
      GITHUB_EVENTS: "push,pull_request,issues,issue_comment",
      MUTED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/status`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start within 3s");
});

afterAll(() => {
  proc?.kill();
});

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

function webhook(
  eventType: string,
  payload: Record<string, any>,
  opts?: { noSign?: boolean; badSign?: boolean }
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": eventType,
  };
  if (!opts?.noSign) {
    headers["x-hub-signature-256"] = opts?.badSign ? "sha256=invalid" : sign(body);
  }
  return fetch(`${BASE}/webhook`, { method: "POST", headers, body });
}

// ---------------------------------------------------------------------------
// Status endpoint
// ---------------------------------------------------------------------------

describe("GET /status", () => {
  it("returns server config", async () => {
    const res = await fetch(`${BASE}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.muted).toBe(false);
    expect(data.repos).toEqual(["test-org/repo-a", "test-org/repo-b"]);
    expect(data.events).toEqual(["push", "pull_request", "issues", "issue_comment"]);
    expect(data.port).toBe(PORT);
  });
});

// ---------------------------------------------------------------------------
// Global mute
// ---------------------------------------------------------------------------

describe("global mute", () => {
  it("mutes and unmutes", async () => {
    let res = await fetch(`${BASE}/mute`, { method: "POST" });
    expect(res.status).toBe(200);
    let data = await res.json();
    expect(data.muted).toBe(true);

    res = await fetch(`${BASE}/status`);
    data = await res.json();
    expect(data.muted).toBe(true);

    res = await fetch(`${BASE}/unmute`, { method: "POST" });
    expect(res.status).toBe(200);
    data = await res.json();
    expect(data.muted).toBe(false);
  });

  it("drops events when muted", async () => {
    await fetch(`${BASE}/mute`, { method: "POST" });
    const res = await webhook("push", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "test" }],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("muted");
    await fetch(`${BASE}/unmute`, { method: "POST" });
  });
});

// ---------------------------------------------------------------------------
// Per-repo mute
// ---------------------------------------------------------------------------

describe("per-repo mute", () => {
  it("mutes a repo indefinitely", async () => {
    let res = await fetch(`${BASE}/mute/test-org/repo-a`, { method: "POST" });
    expect(res.status).toBe(200);
    let data = await res.json();
    expect(data.repo).toBe("test-org/repo-a");
    expect(data.muted).toBe(true);

    // Events from muted repo should be dropped
    res = await webhook("push", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "test" }],
    });
    expect(await res.text()).toBe("repo muted");

    // Events from other repo should pass
    res = await webhook("push", {
      repository: { full_name: "test-org/repo-b" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "test" }],
    });
    expect(await res.text()).toBe("ok");

    // Unmute
    res = await fetch(`${BASE}/unmute/test-org/repo-a`, { method: "POST" });
    data = await res.json();
    expect(data.was_muted).toBe(true);
  });

  it("mutes with timed expiry", async () => {
    // Mute for 0.001 hours (~3.6 seconds)
    await fetch(`${BASE}/mute/test-org/repo-a?hours=0.001`, { method: "POST" });

    let res = await fetch(`${BASE}/status`);
    let data = await res.json();
    expect(data.mutedRepos["test-org/repo-a"]).toBeDefined();

    // Wait for expiry
    await Bun.sleep(4000);

    res = await webhook("push", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "test" }],
    });
    expect(await res.text()).toBe("ok"); // should pass — mute expired
  });

  it("shows muted repos in status", async () => {
    await fetch(`${BASE}/mute/test-org/repo-a?hours=5`, { method: "POST" });
    const res = await fetch(`${BASE}/status`);
    const data = await res.json();
    expect(data.mutedRepos["test-org/repo-a"]).toContain("remaining");
    await fetch(`${BASE}/unmute/test-org/repo-a`, { method: "POST" });
  });

  it("rejects bad repo format", async () => {
    const res = await fetch(`${BASE}/mute/noslash`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("webhook signature", () => {
  it("accepts valid signature", async () => {
    const res = await webhook("push", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "valid sig" }],
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects missing signature", async () => {
    const res = await webhook(
      "push",
      {
        repository: { full_name: "test-org/repo-a" },
        sender: { login: "dev" },
        ref: "refs/heads/main",
        commits: [],
      },
      { noSign: true }
    );
    expect(res.status).toBe(401);
  });

  it("rejects bad signature", async () => {
    const res = await webhook(
      "push",
      {
        repository: { full_name: "test-org/repo-a" },
        sender: { login: "dev" },
        ref: "refs/heads/main",
        commits: [],
      },
      { badSign: true }
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Repo allowlist
// ---------------------------------------------------------------------------

describe("repo filtering", () => {
  it("rejects repos not in allowlist", async () => {
    const res = await webhook("push", {
      repository: { full_name: "evil-org/not-allowed" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [],
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

describe("event filtering", () => {
  it("filters unsubscribed event types", async () => {
    const res = await webhook("release", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      release: { tag_name: "v1.0" },
      action: "published",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("event type filtered");
  });
});

// ---------------------------------------------------------------------------
// Ping event
// ---------------------------------------------------------------------------

describe("ping", () => {
  it("responds to GitHub ping", async () => {
    const res = await webhook("ping", {
      zen: "Keep it logically awesome.",
      hook_id: 123,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.zen).toBe("Keep it logically awesome.");
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mute-all / Unmute-all
// ---------------------------------------------------------------------------

describe("mute-all / unmute-all", () => {
  it("mutes all configured repos", async () => {
    let res = await fetch(`${BASE}/mute-all?hours=2`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.muted_repos).toEqual(["test-org/repo-a", "test-org/repo-b"]);
    expect(data.hours).toBe("2");

    // Events from any configured repo should be muted
    res = await webhook("push", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "test" }],
    });
    expect(await res.text()).toBe("repo muted");

    // Clean up
    await fetch(`${BASE}/unmute-all`, { method: "POST" });
  });

  it("unmute-all clears everything", async () => {
    await fetch(`${BASE}/mute`, { method: "POST" });
    await fetch(`${BASE}/mute/test-org/repo-a`, { method: "POST" });

    const res = await fetch(`${BASE}/unmute-all`, { method: "POST" });
    const data = await res.json();
    expect(data.cleared).toBe(true);
    expect(data.global_mute).toBe(false);

    // Verify status is clean
    const status = await (await fetch(`${BASE}/status`)).json();
    expect(status.muted).toBe(false);
    expect(Object.keys(status.mutedRepos)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event counters
// ---------------------------------------------------------------------------

describe("event counters", () => {
  it("tracks counts in /status", async () => {
    const before = await (await fetch(`${BASE}/status`)).json();
    const prevDelivered = before.counts.delivered;

    await webhook("push", {
      repository: { full_name: "test-org/repo-a" },
      sender: { login: "dev" },
      ref: "refs/heads/main",
      commits: [{ message: "counter test" }],
    });

    const after = await (await fetch(`${BASE}/status`)).json();
    expect(after.counts.delivered).toBeGreaterThan(prevDelivered);
    expect(after.counts.received).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${BASE}/nonexistent`);
    expect(res.status).toBe(404);
  });
});
