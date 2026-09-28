import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { fetchPageText } from "../server/webpage.js";

// One local server plays a web site (/page, /redirect, /file.zip) and the model (/v1/...).
const sent: string[] = [];
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/page") { res.setHeader("content-type", "text/html"); return res.end("<html><head><title>Cairo Guide</title><style>.x{}</style></head><body><nav>menu</nav><h1>Cairo</h1><p>Cairo University was founded in 1908.</p><script>evil()</script></body></html>"); }
    if (url === "/redirect") { res.statusCode = 302; res.setHeader("location", "/page"); return res.end(); }
    if (url === "/file.zip") { res.setHeader("content-type", "application/zip"); return res.end("PK"); }
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const all = JSON.stringify(body.messages);
      sent.push(all);
      const last = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const toolDone = body.messages.some((m) => m.role === "tool");
      let message: Record<string, unknown>;
      if (last.includes("my name is") && !toolDone) message = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "remember", arguments: JSON.stringify({ content: "The user's name is Abdelrahman", kind: "user", confidence: 0.9 }) } }] };
      else if (last.includes("read") && !toolDone) message = { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read_web_page", arguments: JSON.stringify({ url: `${base}/redirect` }) } }] };
      else if (last.includes("who am i")) message = { role: "assistant", content: all.includes("Abdelrahman") ? "You are Abdelrahman." : "I don't know you yet." };
      else message = { role: "assistant", content: toolDone ? `Done: ${body.messages.find((m) => m.role === "tool")?.content.slice(0, 200)}` : "ok" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.READER_ALLOW_PRIVATE_FOR_TESTS = "1";
});
afterAll(() => { delete process.env.READER_ALLOW_PRIVATE_FOR_TESTS; server.close(); });

async function setup(db?: Awaited<ReturnType<typeof openDatabase>>) {
  const database = db ?? (await openDatabase(":memory:"));
  const app = await createApp({ db: database, adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: `${base}/v1` } });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown) => { const r = await app.request(p, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, json: (await r.json()) as any }; };
  const agent = async (patch: Record<string, unknown>) => {
    const a = (await call("/api/builder/agents", "POST")).json;
    expect((await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, model: { providerId: "ollama", modelId: "m" }, ...patch } })).status).toBe(200);
    await call(`/api/builder/agents/${a.id}/publish`, "POST", {});
    return a.id as string;
  };
  const run = async (id: string, input: string) => {
    const { runId } = (await call(`/api/agents/${id}/runs`, "POST", { input })).json;
    for (let i = 0; i < 300; i++) { const r = (await call(`/api/runs/${runId}`)).json; if (r.status && !["CREATED", "RUNNING"].includes(r.status)) return r; await new Promise((ok) => setTimeout(ok, 10)); }
    throw new Error("timeout");
  };
  return { call, agent, run, db: database };
}

test("every template creates a valid agent", async () => {
  const { call } = await setup();
  const templates = (await call("/api/builder/templates")).json as { id: string; title: string }[];
  expect(templates.map((t) => t.id)).toEqual(["web-reader", "doc-qa", "assistant-memory", "support-approvals", "web-search", "writer"]);
  for (const t of templates) {
    const created = await call("/api/builder/agents", "POST", { template: t.id });
    expect(created.status, t.id).toBe(201);
    expect((await call(`/api/builder/agents/${created.json.id}`, "PUT", { spec: created.json.draft })).status, t.id).toBe(200);
  }
  expect((await call("/api/builder/agents", "POST", { template: "nope" })).status).toBe(400);
});

test("the page reader blocks private addresses in production and cleans HTML", async () => {
  await expect(fetchPageText(`${base}/page`)).rejects.toThrow(/private|reserved|https|protocol/i);
  const page = await fetchPageText(`${base}/redirect`, { allowHttpForTests: true });
  expect(page).toMatchObject({ title: "Cairo Guide", url: `${base}/page` });
  expect(page.text).toContain("Cairo University was founded in 1908.");
  expect(page.text).not.toMatch(/evil|menu/);
  await expect(fetchPageText(`${base}/file.zip`, { allowHttpForTests: true })).rejects.toThrow(/Not a web page/);
});

test("Read web page tool and knowledge from a URL", async () => {
  const { call, agent, run } = await setup();
  const id = await agent({ tools: [{ type: "read_web_page" }] });
  const r = await run(id, "please read that page");
  expect(r.status).toBe("COMPLETED");
  expect(r.output).toContain("founded in 1908");
  const added = await call(`/api/builder/agents/${id}/knowledge`, "POST", { url: `${base}/page` });
  expect(added.status).toBe(201);
  expect(added.json.docs.map((d: { title: string }) => d.title)).toEqual(["Cairo Guide"]);
});

test("long-term memory: saved in one chat, recalled in a new one, listed, deletable, private to the agent", async () => {
  const { call, agent, run, db } = await setup();
  const id = await agent({ memory: { enabled: true } });
  expect((await run(id, "hi, my name is Abdelrahman")).status).toBe("COMPLETED");
  expect((await run(id, "who am i?")).output).toBe("You are Abdelrahman."); // new chat, no history passed
  const other = await agent({ memory: { enabled: true } });
  expect((await run(other, "who am i?")).output).toBe("I don't know you yet.");
  // survives a restart (same database, new app)
  const again = await setup(db);
  expect((await again.run(id, "who am i?")).output).toBe("You are Abdelrahman.");
  const list = (await call(`/api/builder/agents/${id}/memories`)).json as { id: string; content: string }[];
  expect(list.map((m) => m.content)).toEqual(["The user's name is Abdelrahman"]);
  expect((await call(`/api/builder/agents/${id}/memories/${list[0]!.id}`, "DELETE")).status).toBe(200);
  expect((await run(id, "who am i?")).output).toBe("I don't know you yet.");
});

test("agents saved before newer fields existed still load and run", async () => {
  const { call, run, db } = await setup();
  const a = (await call("/api/builder/agents", "POST")).json;
  await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, model: { providerId: "ollama", modelId: "m" } } });
  await call(`/api/builder/agents/${a.id}/publish`, "POST", {});
  // Simulate an old row: drop the "memory" field from the stored draft and version.
  for (const [table, col] of [["agents", "draft"], ["agent_versions", "spec"]] as const) {
    const rows = db.db.prepare(`SELECT rowid, ${col} AS v FROM ${table}`).all() as { rowid: number; v: string }[];
    for (const r of rows) { const o = JSON.parse(r.v); delete o.memory; db.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(JSON.stringify(o), r.rowid); }
  }
  expect((await call(`/api/builder/agents/${a.id}`)).json.draft.memory).toEqual({ enabled: false });
  expect((await run(a.id, "hello")).status).toBe("COMPLETED");
});
