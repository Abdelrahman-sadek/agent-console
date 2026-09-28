import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { IssueLog } from "../server/logger.js";

// Mock model: remembers what it was sent; answers per the last user message.
const seen: string[] = [];
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      seen.push(JSON.stringify(body.messages));
      const last = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const content = last.includes("blank") ? "" : last.includes("hello") ? "<thought>greet them</thought>Hi! Which country?" : last.includes("silent") ? "<thought>only thinking</thought>" : `You said ${last}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => server.close());

async function setup() {
  const log = new IssueLog();
  const app = await createApp({ db: await openDatabase(":memory:"), adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: base }, log });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown) => (await (await app.request(p, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()) as any;
  const agent = async (name: string) => {
    const a = await call("/api/builder/agents", "POST");
    await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, name, model: { providerId: "ollama", modelId: "m" } } });
    await call(`/api/builder/agents/${a.id}/publish`, "POST", {});
    return a.id as string;
  };
  const run = async (id: string, input: string, conversation?: string[]) => {
    const { runId } = await call(`/api/agents/${id}/runs`, "POST", { input, ...(conversation ? { conversation } : {}) });
    for (let i = 0; i < 200; i++) {
      const r = await call(`/api/runs/${runId}`);
      if (r.status && !["CREATED", "RUNNING"].includes(r.status)) return r;
      await new Promise((ok) => setTimeout(ok, 10));
    }
    throw new Error("timeout");
  };
  return { call, agent, run, log };
}

test("follow-up messages carry the earlier turns (without reasoning) as context", async () => {
  const { agent, run } = await setup();
  const id = await agent("Asker");
  const first = await run(id, "hello");
  expect(first.output).toContain("Which country?");
  seen.length = 0;
  const second = await run(id, "egypt", [first.runId]);
  expect(second.status).toBe("COMPLETED");
  expect(second.input).toBe("egypt"); // the run's own input stays clean
  expect(second.sources).toEqual([]); // history is not a "source"
  const sent = seen.join("\n");
  expect(sent).toContain("User: hello");
  expect(sent).toContain("Assistant: Hi! Which country?");
  expect(sent).not.toContain("greet them");
});

test("history from another agent's runs is ignored", async () => {
  const { agent, run } = await setup();
  const a = await agent("A");
  const b = await agent("B");
  const fromA = await run(a, "hello");
  seen.length = 0;
  await run(b, "egypt", [fromA.runId]);
  expect(seen.join("\n")).not.toContain("User: hello");
});

test("an answer with only reasoning is recorded as an empty answer", async () => {
  const { agent, run, log } = await setup();
  const id = await agent("Silent");
  const r = await run(id, "silent please");
  expect(r.status).toBe("COMPLETED");
  await new Promise((ok) => setTimeout(ok, 30));
  expect(log.recent({ source: "run" })[0]?.message).toContain("finished without any answer text");
});

test("an empty reply is retried once, then fails with a clear reason instead of a blank answer", async () => {
  const { agent, run } = await setup();
  const id = await agent("Blank");
  seen.length = 0;
  const r = await run(id, "blank please");
  expect(seen).toHaveLength(2); // asked twice
  expect(r.status).toBe("FAILED");
  expect(r.error.message).toMatch(/empty answer twice.*finish reason "stop"/);
});
