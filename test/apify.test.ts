import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { fillApifyInput } from "../server/catalog.js";
import { openDatabase } from "../server/db.js";

const TOKEN = "apify_api_testtoken1234";
const actorCalls: { url: string; auth: string; body: unknown }[] = [];
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "";
      if (url.startsWith("/v2/users/me")) { res.statusCode = req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401; return res.end(JSON.stringify({ data: { username: "abdo", plan: { id: "FREE" } } })); }
      if (url.startsWith("/v2/store")) return res.end(JSON.stringify({ data: { items: [{ username: "apify", name: "rag-web-browser", title: "RAG Web Browser", description: "Search and read pages", stats: { totalUsers: 9000 } }] } }));
      if (url.startsWith("/v2/acts/")) {
        actorCalls.push({ url, auth: req.headers.authorization ?? "", body: JSON.parse(raw) });
        return res.end(JSON.stringify([{ title: "Cairo University", url: "https://cu.edu.eg" }, { title: "Ain Shams", url: "https://asu.edu.eg" }]));
      }
      // Mock model: call the actor once, then summarize the tool result.
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const tool = body.messages.find((m) => m.role === "tool");
      const message = tool
        ? { role: "assistant", content: `Found: ${tool.content.includes("Cairo University") ? "Cairo University" : "nothing"}` }
        : { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: 'universities "egypt"' }) } }] };
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, message, finish_reason: tool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

test("model input is JSON-escaped into the actor input template", () => {
  expect(fillApifyInput('{"query": "{{q}}", "maxResults": 3}', { q: 'a" , "evil": "1' })).toEqual({ query: 'a" , "evil": "1', maxResults: 3 });
});

test("Apify actors: token in Settings, store search, approval by default, actor run", async () => {
  const app = await createApp({ db: await openDatabase(":memory:"), adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: `${base}/v1`, APIFY_BASE_URL: base } });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown) => { const r = await app.request(p, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, json: (await r.json()) as any }; };

  const search = await call("/api/builder/apify/search?q=web");
  expect(search.json.actors[0]).toMatchObject({ id: "apify/rag-web-browser", title: "RAG Web Browser" });

  const a = (await call("/api/builder/agents", "POST")).json;
  const tool = { type: "apify_actor", name: "web_search", description: "Search the web", actorId: "apify/rag-web-browser", input: '{"query": "{{query}}", "maxResults": 2}', params: ["query"] };
  expect((await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, model: { providerId: "ollama", modelId: "m" }, tools: [{ ...tool, input: "{not json" }] } })).json.issues[0].path).toBe("tools.0.input");
  expect((await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, model: { providerId: "ollama", modelId: "m" }, tools: [tool] } })).status).toBe(200);
  const refused = await call(`/api/builder/agents/${a.id}/publish`, "POST", {});
  expect(refused.status).toBe(400);
  expect(refused.json.error).toMatch(/Apify token/);

  await call("/api/settings/integrations/apify", "PUT", { apiKey: TOKEN });
  const integ = await call("/api/settings/integrations");
  expect(integ.json.apify).toMatchObject({ configured: true, source: "console", keyHint: "…1234" });
  expect(JSON.stringify(integ.json)).not.toContain(TOKEN);
  expect((await call("/api/settings/integrations/apify/test", "POST")).json).toMatchObject({ ok: true, message: "Connected as abdo (FREE plan)." });

  expect((await call(`/api/builder/agents/${a.id}/publish`, "POST", {})).status).toBe(200);
  const { runId } = (await call(`/api/agents/${a.id}/runs`, "POST", { input: "universities in egypt" })).json;
  const wait = async () => { for (let i = 0; i < 200; i++) { const r = (await call(`/api/runs/${runId}`)).json; if (r.status && !["CREATED", "RUNNING"].includes(r.status)) return r; await new Promise((ok) => setTimeout(ok, 10)); } throw new Error("timeout"); };
  const paused = await wait();
  expect(paused.status).toBe("WAITING_FOR_APPROVAL"); // actor runs can cost money
  expect(actorCalls).toHaveLength(0);
  const done = (await call(`/api/runs/${runId}/approvals`, "POST", { approvalId: paused.pendingApprovals[0].approvalId, decision: "approved" })).json;
  expect(done.status).toBe("COMPLETED");
  expect(done.output).toBe("Found: Cairo University");
  expect(actorCalls[0]?.url).toMatch(/^\/v2\/acts\/apify~rag-web-browser\/run-sync-get-dataset-items\?timeout=60&limit=10/);
  expect(actorCalls[0]?.auth).toBe(`Bearer ${TOKEN}`);
  expect(actorCalls[0]?.body).toEqual({ query: 'universities "egypt"', maxResults: 2 });
});
