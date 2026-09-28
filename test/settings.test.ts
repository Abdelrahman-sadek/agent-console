import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { loadMasterKey } from "../server/secrets.js";

// A mock OpenAI-compatible provider that records which key each request used.
const GOOD = "sk-test-good-key-1234";
const auths: string[] = [];
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    auths.push(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${GOOD}`) { res.statusCode = 401; res.end("{}"); return; }
    if (req.url?.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "mock-small" }, { id: "mock-large" }] })); return; }
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => res.end(JSON.stringify({ id: "x", model: "mock-small", choices: [{ index: 0, message: { role: "assistant", content: "hello from mock" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ac-settings-"));
  const path = join(dir, "console.db");
  const db = await openDatabase(path);
  const app = await createApp({ db, adminPassword: "test-password", secureCookies: false, env: {}, masterKey: loadMasterKey(path, {}) });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown) => {
    const res = await app.request(p, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json()) as any, text: "" };
  };
  const waitRun = async (runId: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await call(`/api/runs/${runId}`);
      if (r.status === 200 && !["CREATED", "RUNNING"].includes(r.json.status)) return r.json;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error("run did not finish");
  };
  return { call, waitRun, path, dir, db };
}

describe("provider settings from the browser", () => {
  test("a saved key is encrypted at rest, never returned, and used for real calls without a restart", async () => {
    const { call, waitRun, path, db } = await setup();
    const find = async (id: string) => ((await call("/api/settings/providers")).json.providers as any[]).find((p) => p.id === id);
    expect((await find("openai")).configured).toBe(false);

    expect((await call("/api/settings/providers/openai", "PUT", { apiKey: GOOD, baseURL: base })).status).toBe(200);
    const openai = await find("openai");
    expect(openai).toMatchObject({ configured: true, source: "console", keyHint: "…1234", baseURL: base });
    for (const route of ["/api/settings/providers", "/api/builder/models", "/api/settings"]) expect(JSON.stringify((await call(route)).json)).not.toContain(GOOD);
    db.db.exec("PRAGMA wal_checkpoint(FULL)");
    expect(readFileSync(path).includes(Buffer.from(GOOD))).toBe(false);

    const test = await call("/api/settings/providers/openai/test", "POST");
    expect(test.json).toMatchObject({ ok: true, models: ["mock-small", "mock-large"] });
    expect((await find("openai")).models.map((m: { id: string }) => m.id)).toEqual(["mock-small", "mock-large"]);

    const created = (await call("/api/builder/agents", "POST")).json;
    await call(`/api/builder/agents/${created.id}`, "PUT", { spec: { ...created.draft, model: { providerId: "openai", modelId: "mock-small" } } });
    expect((await call(`/api/builder/agents/${created.id}/publish`, "POST", {})).status).toBe(200);
    const run = await waitRun((await call(`/api/agents/${created.id}/runs`, "POST", { input: "hi" })).json.runId);
    expect(run.output).toBe("hello from mock");
    expect(auths.at(-1)).toBe(`Bearer ${GOOD}`);

    expect((await call("/api/settings/providers/openai", "DELETE")).status).toBe(200);
    expect((await find("openai")).configured).toBe(false);
  });

  test("a wrong key is reported by Test", async () => {
    const { call } = await setup();
    await call("/api/settings/providers/openrouter", "PUT", { apiKey: "sk-wrong-key-0000", baseURL: base });
    expect((await call("/api/settings/providers/openrouter/test", "POST")).json).toMatchObject({ ok: false, message: "The provider rejected this key." });
  });

  test("any OpenAI-compatible server can be added as a custom provider", async () => {
    const { call } = await setup();
    expect((await call("/api/settings/providers", "POST", { label: "My vLLM", baseURL: "not a url" })).status).toBe(400);
    const added = await call("/api/settings/providers", "POST", { label: "My vLLM", baseURL: base, apiKey: GOOD });
    expect(added.status).toBe(201);
    expect(added.json.id).toBe("custom-my-vllm");
    expect((await call("/api/settings/providers", "POST", { label: "My vLLM", baseURL: base })).status).toBe(409);
    const models = (await call("/api/builder/models")).json as any[];
    expect(models.find((m) => m.id === "custom-my-vllm")).toMatchObject({ label: "My vLLM", configured: true, custom: true, customModel: true });
    expect((await call("/api/settings/providers/custom-my-vllm", "DELETE")).status).toBe(200);
    expect(((await call("/api/builder/models")).json as any[]).some((m) => m.id === "custom-my-vllm")).toBe(false);
  });

  test("keys survive a restart only with the same master key", async () => {
    const { call, path, db } = await setup();
    await call("/api/settings/providers/openai", "PUT", { apiKey: GOOD, baseURL: base });
    const again = await createApp({ db, adminPassword: "test-password", secureCookies: false, env: {}, masterKey: loadMasterKey(path, {}) });
    const login = await again.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const list = (await (await again.request("/api/settings/providers", { headers: { cookie } })).json()) as { providers: { id: string; configured: boolean }[] };
    expect(list.providers.find((p) => p.id === "openai")?.configured).toBe(true);
  });
});
