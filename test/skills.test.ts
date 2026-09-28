import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";
import { isCrisis, robotsVerdict, skillFromBundle } from "../server/skills.js";

const ROBOTS = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /private/public-page\nDisallow: /*.pdf$\n";
const sent: { messages: string; tools: string[] }[] = [];
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") { res.setHeader("content-type", "text/plain"); return res.end(ROBOTS); }
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
      sent.push({ messages: JSON.stringify(body.messages), tools: (body.tools ?? []).map((t) => t.function.name) });
      const last = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const tool = body.messages.find((m) => m.role === "tool");
      const message = last.includes("can I scrape") && !tool
        ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "check_site_rules", arguments: JSON.stringify({ url: `${base}/private/data` }) } }] }
        : { role: "assistant", content: tool ? `Verdict: ${JSON.parse(tool.content).verdict}` : "ok" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.READER_ALLOW_PRIVATE_FOR_TESTS = "1";
});
afterAll(() => { delete process.env.READER_ALLOW_PRIVATE_FOR_TESTS; server.close(); });

test("robots.txt rules: general-bot group, longest match, Allow wins, wildcards", () => {
  expect(robotsVerdict(ROBOTS, "/about").verdict).toBe("ALLOWED");
  expect(robotsVerdict(ROBOTS, "/private/data")).toEqual({ verdict: "DISALLOWED", rule: "Disallow: /private/" });
  expect(robotsVerdict(ROBOTS, "/private/public-page").verdict).toBe("ALLOWED");
  expect(robotsVerdict(ROBOTS, "/files/report.pdf").verdict).toBe("DISALLOWED");
  expect(robotsVerdict("User-agent: Googlebot\nDisallow: /", "/x").verdict).toBe("CAUTION");
});

test("crisis check works in English and Arabic without false alarms", () => {
  expect(isCrisis("I want to die")).toBe(true);
  expect(isCrisis("sometimes I think about suicide")).toBe(true);
  expect(isCrisis("عايز اموت")).toBe(true);
  expect(isCrisis("I'm stressed about exams")).toBe(false);
  expect(isCrisis("kill the process on port 3000")).toBe(false);
});

test("a real Skillware bundle imports as instructions and rules", () => {
  const s = skillFromBundle(readFileSync("test/fixtures/skillware-pii/manifest.yaml", "utf8"), readFileSync("test/fixtures/skillware-pii/instructions.md", "utf8"), "https://github.com/ARPAHLS/skillware/tree/main/skills/compliance/pii_masker");
  expect(s.title).toBe("compliance/pii_masker");
  expect(s.directive.length).toBeGreaterThan(100);
  expect(s.constitution).toMatch(/^1\./);
});

test("skills add instructions, tools and the crisis gate to an agent", async () => {
  const app = await createApp({ db: await openDatabase(":memory:"), adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: `${base}/v1` } });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown) => { const r = await app.request(p, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, json: (await r.json()) as any }; };
  const run = async (id: string, input: string) => {
    const { runId } = (await call(`/api/agents/${id}/runs`, "POST", { input })).json;
    for (let i = 0; i < 300; i++) { const r = (await call(`/api/runs/${runId}`)).json; if (r.status && !["CREATED", "RUNNING"].includes(r.status)) return r; await new Promise((ok) => setTimeout(ok, 10)); }
    throw new Error("timeout");
  };
  expect((await call("/api/builder/skills")).json.map((s: { id: string }) => s.id)).toEqual(["cite-sources", "user-language", "site-rules", "scam-check", "supportive-coach", "concise"]);
  const a = (await call("/api/builder/agents", "POST")).json;
  expect((await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, skills: ["nope"] } })).json.issues[0].path).toBe("skills.0");
  await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, model: { providerId: "ollama", modelId: "m" }, skills: ["site-rules", "supportive-coach"], importedSkills: [{ title: "PII masker", directive: "Mask personal data.", constitution: "1. Never reveal emails.", source: "https://github.com/ARPAHLS/skillware/tree/main/skills/compliance/pii_masker" }] } });
  await call(`/api/builder/agents/${a.id}/publish`, "POST", {});

  sent.length = 0;
  expect((await run(a.id, "can I scrape this site?")).output).toBe("Verdict: DISALLOWED");
  expect(sent[0]?.tools).toEqual(expect.arrayContaining(["check_site_rules", "read_web_page"]));
  expect(sent[0]?.messages).toContain("Skill: Website permission check");
  expect(sent[0]?.messages).toContain("Skill: PII masker (imported)");
  expect(sent[0]?.messages).not.toContain("SAFETY:");

  sent.length = 0;
  await run(a.id, "I want to die");
  expect(sent[0]?.messages).toContain("SAFETY:");
});
