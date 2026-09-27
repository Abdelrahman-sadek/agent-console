import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";

// ---------------------------------------------------------------- mock OpenAI-compatible model
// Scripted per test: `plan` decides the next tool call from the conversation, or answers.
type Msg = { role: string; content: string | null; tool_calls?: unknown[] };
let plan: (messages: Msg[]) => { tool?: { name: string; args: Record<string, unknown> }; text?: string } = () => ({ text: "ok" });
const seenRequests: { tools?: { function: { name: string } }[] }[] = [];
let server: Server;
let baseURL = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Msg[]; tools?: { function: { name: string } }[] };
      seenRequests.push(body);
      const step = plan(body.messages);
      const message = step.tool
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${seenRequests.length}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }
        : { role: "assistant", content: step.text ?? "" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: "mock", choices: [{ index: 0, message, finish_reason: step.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

const lastTool = (m: Msg[]) => [...m].reverse().find((x) => x.role === "tool")?.content ?? undefined;

async function setup(env: Record<string, string> = {}) {
  const db = await openDatabase(":memory:");
  const app = await createApp({ db, adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: baseURL, ...env } });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const waitRun = async (runId: string) => {
    for (let i = 0; i < 200; i++) {
      const r = await call(`/api/runs/${runId}`);
      if (r.status === 200 && !["CREATED", "RUNNING"].includes(r.json.status)) return r.json;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error("run did not finish");
  };
  const run = async (agentId: string, input: string, draft = false) => waitRun((await call(`/api/agents/${agentId}/runs`, "POST", { input, draft })).json.runId);
  const newAgent = async (spec: Record<string, unknown>) => {
    const created = await call("/api/builder/agents", "POST");
    const base = created.json.draft;
    const saved = await call(`/api/builder/agents/${created.json.id}`, "PUT", { spec: { ...base, ...spec } });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    return created.json.id as string;
  };
  return { app, call, run, waitRun, newAgent, cookie };
}

describe("stage 1: model providers", () => {
  test("lists every provider and whether it is configured (no keys ever returned)", async () => {
    const { call } = await setup({ ANTHROPIC_API_KEY: "sk-ant-test" });
    const models = (await call("/api/builder/models")).json as { id: string; configured: boolean }[];
    expect(models.map((m) => `${m.id}:${m.configured}`)).toEqual(["demo:true", "anthropic:true", "openai:false", "openrouter:false", "gemini:false", "groq:false", "mistral:false", "deepseek:false", "xai:false", "together:false", "ollama:true"]);
    expect(JSON.stringify(models)).not.toContain("sk-ant-test");
  });

  test("an OpenAI-compatible model calls a catalog tool and answers (real HTTP round trip)", async () => {
    const { run, newAgent, call } = await setup();
    plan = (m) => (lastTool(m) ? { text: `The answer is ${JSON.parse(lastTool(m) as string).result}.` } : { tool: { name: "calculator", args: { expression: "(640 - 80) * 0.075" } } });
    const id = await newAgent({ name: "Math helper", model: { providerId: "ollama", modelId: "mock" }, tools: [{ type: "calculator" }] });
    expect((await call(`/api/builder/agents/${id}/publish`, "POST", { note: "first" })).status).toBe(200);
    const done = await run(id, "What is 7.5% of 560?");
    expect(done.status).toBe("COMPLETED");
    expect(done.output).toBe("The answer is 42.");
    expect(seenRequests.at(-1)?.tools?.map((t) => t.function.name)).toEqual(["calculator"]);
  });
});

describe("stage 2 + 6: agent lifecycle and versions", () => {
  test("create → publish v1 → edit → publish v2 → rollback to v1", async () => {
    const { call, run, newAgent } = await setup();
    const id = await newAgent({ name: "Greeter", instructions: "Greet the user politely and briefly." });
    expect((await call("/api/agents")).json.some((a: { id: string }) => a.id === id)).toBe(false); // unpublished: not in Chat
    expect((await call(`/api/agents/${id}/runs`, "POST", { input: "hi" })).status).toBe(404);
    expect((await run(id, "hi from the test chat", true)).status).toBe("COMPLETED"); // draft test run works

    await call(`/api/builder/agents/${id}/publish`, "POST", { note: "v1" });
    const v1 = (await call(`/api/builder/agents/${id}`)).json;
    await call(`/api/builder/agents/${id}`, "PUT", { spec: { ...v1.draft, name: "Greeter 2" } });
    const after = (await call(`/api/builder/agents/${id}/publish`, "POST", { note: "renamed" })).json;
    expect(after.currentVersion).toBe(2);
    expect(after.versions.map((v: { version: number; note: string }) => `${v.version}:${v.note}`)).toEqual(["2:renamed", "1:v1"]);
    expect((await call("/api/agents")).json.find((a: { id: string }) => a.id === id).name).toBe("Greeter 2");

    const back = (await call(`/api/builder/agents/${id}/rollback`, "POST", { version: 1 })).json;
    expect(back.currentVersion).toBe(1);
    expect(back.draft.name).toBe("Greeter");
    expect((await call("/api/agents")).json.find((a: { id: string }) => a.id === id).name).toBe("Greeter");
  });

  test("invalid specs are rejected with field paths", async () => {
    const { call } = await setup();
    const id = (await call("/api/builder/agents", "POST")).json.id;
    const bad = await call(`/api/builder/agents/${id}`, "PUT", { spec: { name: "x", instructions: "short", model: { providerId: "demo", modelId: "demo" }, tools: [{ type: "http", name: "Bad Name", description: "d", url: "http://insecure.example/{id}" }] } });
    expect(bad.status).toBe(400);
    const paths = bad.json.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["name", "instructions", "tools.0.name", "tools.0.description", "tools.0.url"]));
  });

  test("publishing is refused when the model provider is not configured", async () => {
    const { call, newAgent } = await setup();
    const id = await newAgent({ model: { providerId: "anthropic", modelId: "claude-sonnet-5" } });
    const res = await call(`/api/builder/agents/${id}/publish`, "POST", {});
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/not configured/);
  });
});

describe("stage 3: tools and approval rules", () => {
  test("threshold approval pauses only above the limit, and the run resumes on the version it started with", async () => {
    const { call, run, newAgent } = await setup();
    plan = (m) => {
      if (lastTool(m)) return { text: `Done: ${lastTool(m)}` };
      const user = [...m].reverse().find((x) => x.role === "user")?.content ?? "";
      const orderId = /ord-\d+/.exec(user)?.[0] ?? "ord-17";
      const amount = { "ord-17": 80, "ord-42": 640 }[orderId] ?? 1;
      return { tool: { name: "issue_refund", args: { orderId, amount } } };
    };
    const id = await newAgent({ name: "Refunds", model: { providerId: "ollama", modelId: "mock" }, tools: [{ type: "demo_refund", approval: { mode: "threshold", field: "amount", over: 100 } }] });
    await call(`/api/builder/agents/${id}/publish`, "POST", {});

    expect((await run(id, "refund ord-17")).status).toBe("COMPLETED"); // 80: no approval
    const paused = await run(id, "refund ord-42"); // 640: approval
    expect(paused.status).toBe("WAITING_FOR_APPROVAL");
    expect(paused.pendingApprovals[0].arguments).toEqual({ orderId: "ord-42", amount: 640 });

    // Publish v2 (no approval rule) while v1's run is waiting; approving must resume v1.
    const d = (await call(`/api/builder/agents/${id}`)).json.draft;
    await call(`/api/builder/agents/${id}`, "PUT", { spec: { ...d, tools: [{ type: "demo_refund", approval: { mode: "never" } }] } });
    await call(`/api/builder/agents/${id}/publish`, "POST", {});
    const approved = await call(`/api/runs/${paused.runId}/approvals`, "POST", { approvalId: paused.pendingApprovals[0].approvalId, decision: "approved" });
    expect(approved.status).toBe(200);
    expect(approved.json.status).toBe("COMPLETED");
    expect(approved.json.output).toMatch(/rf-42/);
  });

  test("HTTP tools can only reach their own host, and never private addresses", async () => {
    const { call, run, newAgent } = await setup();
    plan = (m) => (lastTool(m) ? { text: `Tool said: ${lastTool(m)}` } : { tool: { name: "get_status", args: { id: "7" } } });
    const id = await newAgent({ name: "Status", model: { providerId: "ollama", modelId: "mock" }, tools: [{ type: "http", name: "get_status", description: "Get a status", url: "https://127.0.0.1/status/{id}", params: ["id"] }] });
    await call(`/api/builder/agents/${id}/publish`, "POST", {});
    const done = await run(id, "status of 7");
    expect(done.status).toBe("COMPLETED");
    expect(done.output).toMatch(/private|reserved/i);
    expect(done.audit[0]).toMatchObject({ toolName: "get_status", outcome: "error" });
  });
});

describe("stage 5: knowledge", () => {
  test("pasted text and an uploaded PDF are searchable and cited", async () => {
    const { app, call, run, newAgent, cookie } = await setup();
    const id = await newAgent({ name: "Policies", knowledge: { enabled: true, k: 3 } });
    expect((await call(`/api/builder/agents/${id}/knowledge`, "POST", { title: "Leave policy", text: "Employees receive 21 days of paid vacation per year." })).status).toBe(201);
    const form = new FormData();
    form.append("file", new File([readFileSync("test/fixtures/travel-policy.pdf")], "travel-policy.pdf", { type: "application/pdf" }));
    const up = await app.request(`/api/builder/agents/${id}/knowledge`, { method: "POST", body: form, headers: { cookie } });
    expect(up.status).toBe(201);
    const docs = ((await up.json()) as { docs: { title: string }[] }).docs.map((d) => d.title);
    expect(docs).toEqual(["Leave policy", "travel-policy.pdf"]);
    await call(`/api/builder/agents/${id}/publish`, "POST", {});

    const travel = await run(id, "Can I fly business class on a flight longer than six hours?");
    expect(travel.status).toBe("COMPLETED");
    expect(travel.output).toMatch(/business class only for flights longer than six hours.*\[\d\]/);
    expect(travel.sources.map((s: { title: string }) => s.title)).toContain("travel-policy.pdf");
  });
});
