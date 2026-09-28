import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { IssueLog } from "../server/logger.js";

async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "ac-logs-")), "logs", "console.log");
  const log = new IssueLog(file);
  // Ollama pointed at a closed port: every model call fails, which must be logged.
  const app = await createApp({ db: await openDatabase(":memory:"), adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: "http://127.0.0.1:9/v1" }, log });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown, auth = true) => {
    const res = await app.request(p, { method, headers: { "content-type": "application/json", ...(auth ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  return { call, file };
}

describe("issue log (debugger)", () => {
  test("browser errors are recorded with secrets removed, and the log needs sign-in", async () => {
    const { call, file } = await setup();
    expect((await call("/api/client-errors", "POST", { message: "Page crashed: boom with key sk-proj-abcdefghijklmnop", page: "#/chat/x", stack: "Error: boom\n at x" }, false)).status).toBe(200);
    expect((await call("/api/logs", "GET", undefined, false)).status).toBe(401);
    const logs = (await call("/api/logs")).json;
    const issue = logs.issues.find((i: { source: string }) => i.source === "browser");
    expect(issue).toMatchObject({ level: "error", message: "Page crashed: boom with key sk-proj-***" });
    expect(issue.detail.page).toBe("#/chat/x");
    expect(readFileSync(file, "utf8")).toContain("Page crashed: boom");
    expect(readFileSync(file, "utf8")).not.toContain("abcdefghijklmnop");
  });

  test("a run that fails is recorded with the agent and the reason", async () => {
    const { call } = await setup();
    const created = (await call("/api/builder/agents", "POST")).json;
    await call(`/api/builder/agents/${created.id}`, "PUT", { spec: { ...created.draft, model: { providerId: "ollama", modelId: "llama3.1" } } });
    await call(`/api/builder/agents/${created.id}/publish`, "POST", {});
    const { runId } = (await call(`/api/agents/${created.id}/runs`, "POST", { input: "hello" })).json;
    let run: any;
    for (let i = 0; i < 300; i++) {
      const r = await call(`/api/runs/${runId}`);
      run = r.json;
      if (r.status === 200 && !["CREATED", "RUNNING"].includes(run.status)) break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    expect(run.status).toBe("FAILED");
    await new Promise((ok) => setTimeout(ok, 50));
    const issues = (await call("/api/logs?source=run")).json.issues;
    expect(issues[0]).toMatchObject({ level: "warn", source: "run" });
    expect(issues[0].message).toContain(created.id);
    expect(issues[0].detail.runId).toBe(runId);
  });
});

import { friendlyError } from "../server/app.js";
test("provider errors are shown as one readable line with a hint", () => {
  const raw = `gemini: HTTP 404 [{\n  "error": {\n    "code": 404,\n    "message": "This model models/gemini-2.5-flash is no longer available to new users.",\n    "status": "NOT_FOUND"\n  }\n}\n]`;
  expect(friendlyError(raw)).toBe("gemini (HTTP 404): This model models/gemini-2.5-flash is no longer available to new users. Pick another model in the builder (Settings → Test lists the models your key can use).");
  expect(friendlyError('openai: HTTP 401 {"error":{"message":"Incorrect API key provided"}}')).toContain("Check the API key in Settings.");
  expect(friendlyError("ollama: network error")).toBe("ollama: network error");
});
