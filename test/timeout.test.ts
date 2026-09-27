import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createApp } from "../server/app.js";
import { openDatabase } from "../server/db.js";

test("a provider that never answers ends the run as timed out instead of hanging", async () => {
  const hang = createServer(() => { /* accept, never respond */ });
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(hang.address() as AddressInfo).port}/v1`;
  const app = await createApp({ db: await openDatabase(":memory:"), adminPassword: "test-password", secureCookies: false, env: { OLLAMA_BASE_URL: base, RUN_TIMEOUT_MS: "400" } });
  const login = await app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "test-password" }), headers: { "content-type": "application/json" } });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (p: string, method = "GET", body?: unknown) => (await (await app.request(p, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json()) as any;
  const a = await call("/api/builder/agents", "POST");
  await call(`/api/builder/agents/${a.id}`, "PUT", { spec: { ...a.draft, model: { providerId: "ollama", modelId: "slow" } } });
  await call(`/api/builder/agents/${a.id}/publish`, "POST", {});
  const { runId } = await call(`/api/agents/${a.id}/runs`, "POST", { input: "hello" });
  let run: any = {};
  for (let i = 0; i < 100 && !["TIMED_OUT", "FAILED", "COMPLETED"].includes(run.status); i++) {
    await new Promise((ok) => setTimeout(ok, 50));
    run = await call(`/api/runs/${runId}`);
  }
  hang.closeAllConnections(); hang.close();
  expect(["TIMED_OUT", "FAILED"]).toContain(run.status);
  expect(run.error.message).toMatch(/timeout|timed out/i);
}, 15_000);
