import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentEvent, AgentState } from "@agent-farmework/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Agent } from "@agent-farmework/core";
import { createAgents, operator } from "./agents.js";
import { customAgentInfo, registerBuilder } from "./builder.js";
import type { Database } from "./db.js";
import { AgentFactory } from "./factory.js";
import { loadProviders, type ProviderInfo } from "./providers.js";
import { ProviderSecrets, loadMasterKey } from "./secrets.js";
import { registerProviderSettings } from "./settings.js";
import { IssueLog, errorDetail, type Level, type Source } from "./logger.js";

export interface AppOptions {
  db: Database;
  adminPassword: string;
  secureCookies: boolean;
  /** Where provider keys are read from (defaults to process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Encrypts provider keys saved from the browser (see loadMasterKey). A random key is used when omitted. */
  masterKey?: Buffer;
  /** Where problems are recorded (file + memory). An in-memory log is used when omitted. */
  log?: IssueLog;
}

/** Providers and the factory built from them; replaced whenever provider settings change. */
export interface LiveProviders {
  factory: AgentFactory;
  providerInfo: ProviderInfo[];
}

const SESSION_COOKIE = "ac_session";
const SESSION_TTL_MS = 12 * 3_600_000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "APPROVAL_EXPIRED", "WAITING_FOR_APPROVAL"]);

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** What the UI needs about a run, without internal message history. */
export function summarize(state: AgentState) {
  const firstUser = state.messages.find((m) => m.role === "user")?.content;
  return {
    runId: state.runId,
    agentId: state.agentId,
    status: state.status,
    input: typeof firstUser === "string" ? firstUser : typeof state.input === "string" ? state.input : JSON.stringify(state.input),
    output: state.output ?? null,
    error: state.error === undefined ? null : { code: state.error.code, message: state.error.message },
    usage: state.usage,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    sources: state.contextItems.map((i) => ({ title: i.source?.title ?? i.id, score: i.score ?? null })),
    pendingApprovals: state.pendingApprovals.map((p) => ({
      approvalId: p.approval.approvalId,
      toolName: p.approval.toolName,
      reason: p.approval.reason ?? null,
      requestedAt: p.approval.requestedAt,
      expiresAt: p.approval.expiresAt ?? null,
      arguments: parseArgs(p.toolCall.arguments),
    })),
  };
}

export async function createApp(options: AppOptions) {
  const { db } = options;
  const { agents, info } = await createAgents(db);
  const env = options.env ?? process.env;
  const log = options.log ?? new IssueLog();
  const secrets = new ProviderSecrets(db.db, options.masterKey ?? loadMasterKey(":memory:", {}));
  const build = (): LiveProviders => {
    const { providers, info } = loadProviders(env, secrets.all());
    return { factory: new AgentFactory(db, new Set(providers.map((p) => p.id)), providers), providerInfo: info };
  };
  const live: LiveProviders = build();
  const reload = () => Object.assign(live, build());
  /** Built-in demo agents, then agents built in the browser (published version, or the draft for test chat). */
  const resolveAgent = async (agentId: string, draft = false): Promise<Agent<unknown> | undefined> => {
    const builtin = agents.get(agentId);
    if (builtin !== undefined) return builtin;
    const row = db.agents.get(agentId);
    if (row === undefined) return undefined;
    if (draft) return live.factory.build(agentId, "draft");
    return row.currentVersion === null ? undefined : live.factory.build(agentId, row.currentVersion);
  };
  const sessions = new Map<string, number>();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const expected = sha256(options.adminPassword);

  const app = new Hono();
  app.use("*", secureHeaders());

  // Anything a route throws is logged with its path, and the browser gets a plain message.
  app.onError((error, c) => {
    log.error("server", error.message, { method: c.req.method, path: c.req.path, ...errorDetail(error) });
    return c.json({ error: "Something went wrong on the server. It was recorded in Logs." }, 500);
  });

  /** Log runs that end badly, with the agent and the reason. */
  const watchRun = (agentId: string, runId: string, started: Promise<unknown>) =>
    started
      .then(async () => {
        const state = await db.runs.load(runId);
        if (state !== undefined && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(state.status)) {
          log.warn("run", `${agentId}: ${state.error?.message ?? state.status}`, { runId, status: state.status, code: state.error?.code, agentVersion: state.agentVersion });
        }
      })
      .catch((error: unknown) => log.error("run", `${agentId}: the run crashed: ${error instanceof Error ? error.message : String(error)}`, { runId, ...errorDetail(error) }));

  // Browser errors (page crashes, lost live streams) are sent here so they land in the same log.
  const clientReports = new Map<string, { count: number; resetAt: number }>();
  app.post("/api/client-errors", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const now = Date.now();
    const seen = clientReports.get(ip);
    if (seen !== undefined && seen.resetAt > now && seen.count >= 30) return c.json({ ok: false }, 429);
    clientReports.set(ip, seen !== undefined && seen.resetAt > now ? { ...seen, count: seen.count + 1 } : { count: 1, resetAt: now + 60_000 });
    const body = z
      .object({ level: z.enum(["error", "warn"]).default("error"), message: z.string().max(1_000), page: z.string().max(300).optional(), stack: z.string().max(4_000).optional(), context: z.record(z.string(), z.unknown()).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ ok: false }, 400);
    log.write(body.data.level, "browser", body.data.message, { page: body.data.page, stack: body.data.stack, userAgent: c.req.header("user-agent")?.slice(0, 200), ...body.data.context });
    return c.json({ ok: true });
  });

  app.get("/api/health", (c) => c.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));

  // ------------------------------------------------------------ auth
  app.post("/api/login", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const now = Date.now();
    const attempts = loginAttempts.get(ip);
    if (attempts !== undefined && attempts.resetAt > now && attempts.count >= 5) return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
    const body = z.object({ password: z.string().max(200) }).safeParse(await c.req.json().catch(() => ({})));
    const ok = body.success && timingSafeEqual(sha256(body.data.password), expected);
    if (!ok) {
      loginAttempts.set(ip, attempts !== undefined && attempts.resetAt > now ? { ...attempts, count: attempts.count + 1 } : { count: 1, resetAt: now + 60_000 });
      return c.json({ error: "Wrong password." }, 401);
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, now + SESSION_TTL_MS);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Strict", secure: options.secureCookies, path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) sessions.delete(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login" || c.req.path === "/api/health") return next();
    const token = getCookie(c, SESSION_COOKIE);
    const expires = token === undefined ? undefined : sessions.get(token);
    if (expires === undefined || expires < Date.now()) return c.json({ error: "Not signed in." }, 401);
    return next();
  });

  app.get("/api/me", (c) => c.json({ userId: operator.userId, tenantId: operator.tenantId }));

  // ------------------------------------------------------------ agents & runs
  app.get("/api/agents", (c) => {
    const custom = db.agents.list().filter((r) => r.currentVersion !== null).map((r) => customAgentInfo(r, db.agents.version(r.id, r.currentVersion as number)?.spec ?? r.draft));
    return c.json([...info.map((a) => ({ ...a, kind: "builtin" })), ...custom]);
  });
  app.get("/api/settings", (c) => c.json({ providers: live.providerInfo, database: "SQLite", operator }));

  registerBuilder(app, { db, live });

  // ------------------------------------------------------------ logs (debugger)
  app.get("/api/logs", (c) => {
    const level = c.req.query("level") as Level | undefined;
    const source = c.req.query("source") as Source | undefined;
    const limit = Math.min(1_000, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    return c.json({ counts: log.counts(), file: log.file ?? null, issues: log.recent({ ...(level ? { level } : {}), ...(source ? { source } : {}), limit }) });
  });
  app.get("/api/logs/download", (c) => {
    const lines = log.recent({ limit: 1_000 }).reverse().map((i) => JSON.stringify(i)).join("\n");
    c.header("content-disposition", `attachment; filename="agent-console-log-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    return c.body(`${lines}\n`, 200, { "content-type": "application/x-ndjson; charset=utf-8" });
  });
  registerProviderSettings(app, { secrets, env, live, reload, log });

  app.post("/api/agents/:agentId/runs", async (c) => {
    const body = z.object({ input: z.string().trim().min(1).max(2_000), draft: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Message must be 1–2000 characters." }, 400);
    let agent: Agent<unknown> | undefined;
    try {
      agent = await resolveAgent(c.req.param("agentId"), body.data.draft === true);
    } catch (error) {
      log.warn("run", `Could not start ${c.req.param("agentId")}: ${error instanceof Error ? error.message : String(error)}`, errorDetail(error));
      return c.json({ error: error instanceof Error ? error.message : "Could not load the agent." }, 400);
    }
    if (agent === undefined) return c.json({ error: "Unknown or unpublished agent." }, 404);
    const runId = `run_${randomUUID()}`;
    // Runs continue in the background; the UI follows them over the event stream.
    void watchRun(c.req.param("agentId"), runId, agent.run({ input: body.data.input, user: operator, runId }));
    return c.json({ runId }, 202);
  });

  app.get("/api/runs", (c) => c.json(db.queries.list().map(summarize)));
  app.get("/api/approvals", (c) => c.json(db.queries.waiting().map(summarize)));

  app.get("/api/runs/:runId", async (c) => {
    const state = await db.runs.load(c.req.param("runId"));
    if (state === undefined) return c.json({ error: "Run not found." }, 404);
    return c.json({ ...summarize(state), events: db.events.forRun(state.runId), audit: db.audit.forRun(state.runId) });
  });

  app.get("/api/runs/:runId/stream", (c) => {
    const runId = c.req.param("runId");
    const after = Number(c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      let last = Number.isFinite(after) ? after : 0;
      let done = false;
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = db.events.subscribe(runId, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        done = true;
        wake?.();
      });
      queue.unshift(...db.events.forRun(runId, last)); // replay what happened before we subscribed
      const keepAlive = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
      try {
        while (!done) {
          const event = queue.shift();
          if (event === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            continue;
          }
          if (event.sequence <= last) continue;
          last = event.sequence;
          await stream.writeSSE({ event: "agent-event", id: String(event.sequence), data: JSON.stringify(event) });
          if (event.type.startsWith("AGENT_") && TERMINAL.has(event.type.replace("AGENT_", ""))) {
            const state = await db.runs.load(runId);
            if (state !== undefined && TERMINAL.has(state.status)) await stream.writeSSE({ event: "run-state", data: JSON.stringify(summarize(state)) });
          }
        }
      } finally {
        clearInterval(keepAlive);
        unsubscribe();
      }
    });
  });

  // ------------------------------------------------------------ approvals
  app.post("/api/runs/:runId/approvals", async (c) => {
    const runId = c.req.param("runId");
    const body = z
      .object({
        approvalId: z.string().min(1),
        decision: z.enum(["approved", "rejected", "modified"]),
        modifiedArguments: z.record(z.string(), z.unknown()).optional(),
        reason: z.string().max(500).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Invalid decision." }, 400);
    const state = await db.runs.load(runId);
    // Resume on exactly the agent version the run started with.
    const agent = state === undefined ? undefined : (agents.get(state.agentId) ?? (await live.factory.forRun(state.agentId, state.agentVersion).catch(() => undefined)));
    if (state === undefined || agent === undefined) return c.json({ error: "Run not found." }, 404);
    try {
      const result = await agent.resume({
        runId,
        approvals: [
          {
            approvalId: body.data.approvalId,
            decision: body.data.decision,
            decidedBy: operator.userId,
            ...(body.data.modifiedArguments === undefined ? {} : { modifiedArguments: body.data.modifiedArguments }),
            ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
          },
        ],
      });
      const after = await db.runs.load(result.runId);
      if (after !== undefined && ["FAILED", "TIMED_OUT", "CANCELLED"].includes(after.status)) log.warn("run", `${after.agentId}: ${after.error?.message ?? after.status} (after approval)`, { runId, status: after.status, code: after.error?.code });
      return c.json(after === undefined ? { status: result.status } : summarize(after));
    } catch (error) {
      log.warn("run", `Approval on ${runId} failed: ${error instanceof Error ? error.message : String(error)}`, errorDetail(error));
      return c.json({ error: error instanceof Error ? error.message : "Could not apply the decision." }, 409);
    }
  });

  return app;
}
