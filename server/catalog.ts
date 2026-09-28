import type { KnowledgeBase } from "@agent-farmework/knowledge";
import { createEgressPolicy, defineHttpTool } from "@agent-farmework/security";
import { defineTool, type AnyTool, type ToolApproval } from "@agent-farmework/tools";
import { z } from "zod";
import type { ApprovalSpec, ToolSpec } from "./spec.js";

/** What the builder UI offers. Every tool the model can use comes from here. */
export const CATALOG = [
  { type: "http", label: "Web API call", description: "Call one HTTPS API you allow (only that host is reachable; private addresses are blocked).", configurable: true },
  { type: "apify_actor", label: "Apify actor", description: "Run a ready-made Apify tool (scrapers, search, data extraction). Needs an Apify token in Settings; asks for approval by default.", configurable: true },
  { type: "knowledge_search", label: "Search knowledge", description: "Search this agent's uploaded documents and cite them.", configurable: false },
  { type: "calculator", label: "Calculator", description: "Exact arithmetic: + − × ÷ % ^ and parentheses.", configurable: false },
  { type: "current_time", label: "Current date & time", description: "Today's date and time (UTC and Cairo).", configurable: false },
  { type: "demo_lookup_order", label: "Demo: look up order", description: "Sample orders ord-17, ord-42, ord-77, ord-90 (for trying the builder).", configurable: false },
  { type: "demo_refund", label: "Demo: issue refund", description: "Sample refund tool; pair it with an approval rule on amount.", configurable: false },
] as const;

export const demoOrders: Record<string, { customer: string; amount: number; status: string; daysSinceDelivery: number }> = {
  "ord-17": { customer: "Mona Hassan", amount: 80, status: "delivered", daysSinceDelivery: 12 },
  "ord-42": { customer: "Omar Adel", amount: 640, status: "delivered", daysSinceDelivery: 3 },
  "ord-77": { customer: "Sara Nabil", amount: 250, status: "delivered", daysSinceDelivery: 9 },
  "ord-90": { customer: "Youssef Ali", amount: 45, status: "in transit", daysSinceDelivery: 0 },
};

function approvalOf<T>(a: ApprovalSpec): ToolApproval<T> | undefined {
  if (a.mode === "never") return undefined;
  if (a.mode === "always") return { required: true, reason: "Always requires approval", expiresInMs: 24 * 3_600_000 };
  const { field, over } = a;
  return {
    required: (input) => Number((input as Record<string, unknown>)[field]) > over,
    reason: `${field} over ${over}`,
    expiresInMs: 24 * 3_600_000,
  };
}

/** Safe arithmetic: numbers, + - * / % ^ and parentheses. No names, no code. */
export function calculate(expression: string): number {
  const tokens = expression.replace(/\s+/g, "").match(/\d+(?:\.\d+)?|[-+*/%^()]/g);
  if (tokens === null || tokens.join("") !== expression.replace(/\s+/g, "")) throw new Error("Only numbers and + - * / % ^ ( ) are allowed");
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === "(") { const v = sum(); if (next() !== ")") throw new Error("Missing )"); return v; }
    if (t === "-") return -primary();
    if (t === "+") return primary();
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    throw new Error("Unexpected end of expression");
  };
  const power = (): number => { const b = primary(); if (peek() === "^") { next(); return b ** power(); } return b; };
  const product = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") { const op = next(); const r = power(); v = op === "*" ? v * r : op === "/" ? v / r : v % r; }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") { const op = next(); const r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  const result = sum();
  if (i !== tokens.length) throw new Error("Unexpected token");
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number");
  return result;
}

function httpTool(t: Extract<ToolSpec, { type: "http" }>): AnyTool {
  const host = new URL(t.url).hostname;
  const input = z.object(Object.fromEntries(t.params.map((p) => [p, z.string().max(200)])));
  const approval = approvalOf<Record<string, string>>(t.approval);
  return defineHttpTool<Record<string, string>>({
    name: t.name,
    description: `${t.description} (calls ${host})`,
    input,
    timeoutMs: 15_000,
    maxBytes: 200_000,
    egress: createEgressPolicy({ allowHosts: [host] }),
    ...(approval === undefined ? {} : { approval }),
    request: (args): { url: string; method: string; headers: Record<string, string>; body?: string } => {
      const url = t.url.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_m, p: string) => encodeURIComponent(args[p] ?? ""));
      return t.method === "POST"
        ? { url, method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(args) }
        : { url, method: "GET", headers: { accept: "application/json" } };
    },
    mapResponse: (r) => ({ status: r.status, body: r.body.slice(0, 4_000) }),
  }) as AnyTool;
}

/** Where Apify actors are run, and with which token (from Settings or APIFY_TOKEN). */
export interface ApifyAccess { token?: string; baseURL: string }

/** Fill {{param}} placeholders with JSON-escaped values, so the model can never break the JSON. */
export function fillApifyInput(template: string, args: Record<string, string>): unknown {
  return JSON.parse(template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_m, p: string) => JSON.stringify(args[p] ?? "").slice(1, -1)));
}

function apifyTool(t: Extract<ToolSpec, { type: "apify_actor" }>, apify: ApifyAccess): AnyTool {
  const approval = approvalOf<Record<string, string>>(t.approval);
  const actor = t.actorId.replace("/", "~");
  return defineTool<Record<string, string>, unknown>({
    name: t.name,
    description: `${t.description} (Apify actor ${t.actorId})`,
    input: z.object(Object.fromEntries(t.params.map((p) => [p, z.string().max(500)]))) as unknown as z.ZodType<Record<string, string>>,
    ...(approval === undefined ? {} : { approval }),
    execute: async (args) => {
      if (!apify.token) throw new Error("No Apify token. Add one in Settings → Integrations.");
      const url = `${apify.baseURL.replace(/\/$/, "")}/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?timeout=${t.timeoutSecs}&limit=${t.maxItems}&clean=true`;
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apify.token}`, "content-type": "application/json" },
        body: JSON.stringify(fillApifyInput(t.input, args)),
        signal: AbortSignal.timeout((t.timeoutSecs + 15) * 1_000),
      });
      if (res.status === 401 || res.status === 403) throw new Error("Apify rejected the token. Check it in Settings → Integrations.");
      if (res.status === 402) throw new Error("Your Apify account has no credit left for this actor.");
      if (res.status === 404) throw new Error(`Apify actor ${t.actorId} was not found.`);
      if (res.status === 408) throw new Error(`The actor did not finish within ${t.timeoutSecs} s.`);
      if (!res.ok) throw new Error(`Apify answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const items = (await res.json().catch(() => [])) as unknown[];
      const list = Array.isArray(items) ? items.slice(0, t.maxItems) : [];
      const text = JSON.stringify(list);
      return { actor: t.actorId, count: list.length, items: text.length > 6_000 ? `${text.slice(0, 6_000)}… (truncated)` : list };
    },
  }) as AnyTool;
}

export function buildTools(specs: readonly ToolSpec[], kb: KnowledgeBase | undefined, refunds: Map<string, string>, apify: ApifyAccess = { baseURL: "https://api.apify.com" }): AnyTool[] {
  return specs.map((t): AnyTool => {
    switch (t.type) {
      case "http":
        return httpTool(t);
      case "apify_actor":
        return apifyTool(t, apify);
      case "knowledge_search":
        if (kb === undefined) throw new Error("knowledge_search needs knowledge enabled");
        return kb.asTool({ name: "knowledge_search", description: "Search this agent's documents. Cite results as [n].", k: 4 }) as AnyTool;
      case "calculator":
        return defineTool({
          name: "calculator",
          description: "Evaluate an arithmetic expression exactly, e.g. (640 - 80) * 0.15",
          input: z.object({ expression: z.string().min(1).max(200) }),
          execute: async ({ expression }) => ({ expression, result: calculate(expression) }),
        }) as AnyTool;
      case "current_time":
        return defineTool({
          name: "current_time",
          description: "Current date and time",
          input: z.object({}),
          execute: async () => {
            const now = new Date();
            return { utc: now.toISOString(), cairo: now.toLocaleString("en-GB", { timeZone: "Africa/Cairo" }) };
          },
        }) as AnyTool;
      case "demo_lookup_order": {
        const approval = approvalOf<{ orderId: string }>(t.approval);
        return defineTool({
          name: "lookup_order",
          description: "Look up a (demo) order by id, e.g. ord-42",
          input: z.object({ orderId: z.string().regex(/^ord-\d+$/) }),
          ...(approval === undefined ? {} : { approval }),
          execute: async ({ orderId }) => (demoOrders[orderId] ? { orderId, found: true, ...demoOrders[orderId] } : { orderId, found: false }),
        }) as AnyTool;
      }
      case "demo_refund": {
        const approval = approvalOf<{ orderId: string; amount: number }>(t.approval);
        return defineTool({
          name: "issue_refund",
          description: "Refund a (demo) order",
          input: z.object({ orderId: z.string(), amount: z.number().positive() }),
          ...(approval === undefined ? {} : { approval }),
          idempotency: { key: ({ orderId }) => `refund:${orderId}` },
          execute: async ({ orderId, amount }) => {
            const refundId = refunds.get(orderId) ?? `rf-${orderId.slice(4)}-${Date.now().toString(36)}`;
            refunds.set(orderId, refundId);
            return { refundId, orderId, amount, status: "issued" };
          },
        }) as AnyTool;
      }
    }
  });
}
