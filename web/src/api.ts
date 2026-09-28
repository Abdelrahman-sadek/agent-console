export interface AgentInfo {
  id: string;
  kind?: "builtin" | "custom";
  version?: number | null;
  model?: string;
  name: string;
  description: string;
  examples: string[];
  tools: { name: string; description: string; approval?: string }[];
  guardrails: string[];
  limits: { maxSteps: number; maxToolCalls: number };
}

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  reason: string | null;
  requestedAt: string;
  expiresAt: string | null;
  arguments: Record<string, unknown>;
}

export interface RunSummary {
  runId: string;
  agentId: string;
  status: string;
  input: string;
  output: unknown;
  error: { code: string; message: string } | null;
  usage: { totalTokens: number; estimatedCostUsd: number; llmCalls: number; toolCalls: number };
  createdAt: string;
  updatedAt: string;
  sources: { title: string; score: number | null }[];
  pendingApprovals: PendingApproval[];
}

export interface AgentEvent {
  eventId: string;
  sequence: number;
  runId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, any>;
}

export interface AuditRecord {
  auditId: string;
  recordedAt: string;
  toolName: string;
  outcome: string;
  input?: unknown;
  durationMs: number;
  authorization?: { allowed: boolean; policy: string; reason: string };
  approval?: { decision: string; decidedBy?: string };
}

export interface RunDetail extends RunSummary {
  events: AgentEvent[];
  audit: AuditRecord[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly issues: Issue[] = []) {
    super(message);
    this.name = "ApiError";
  }
}

/** Send a browser-side problem to the server's issue log (never throws). */
export function report(level: "error" | "warn", message: string, extra: { stack?: string; context?: Record<string, unknown> } = {}): void {
  try {
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify({ level, message: String(message).slice(0, 1_000), page: window.location.hash || "/", ...(extra.stack ? { stack: extra.stack.slice(0, 4_000) } : {}), ...(extra.context ? { context: extra.context } : {}) }),
    }).catch(() => {});
  } catch { /* reporting must never break the page */ }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, credentials: "same-origin" });
  } catch (error) {
    report("warn", `Network error calling ${init.method ?? "GET"} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: Issue[] };
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new Event("signed-out"));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.issues ?? []);
  }
  return body as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Multipart upload (the browser sets the boundary, so no JSON content-type). */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Upload failed (${res.status})`);
  return body as T;
}

// ------------------------------------------------------------------ builder

export type Approval = { mode: "never" } | { mode: "always" } | { mode: "threshold"; field: string; over: number };
export type ToolSpec =
  | { type: "http"; name: string; description: string; method: "GET" | "POST"; url: string; params: string[]; approval: Approval }
  | { type: "apify_actor"; name: string; description: string; actorId: string; input: string; params: string[]; maxItems: number; timeoutSecs: number; approval: Approval }
  | { type: "knowledge_search" | "read_web_page" | "calculator" | "current_time" | "demo_lookup_order" | "demo_refund"; approval: Approval };

export interface AgentSpec {
  name: string;
  description: string;
  instructions: string;
  model: { providerId: string; modelId: string };
  tools: ToolSpec[];
  knowledge: { enabled: boolean; k: number };
  memory: { enabled: boolean };
  guardrails: { pii: boolean; injection: boolean };
  limits: { maxSteps: number; maxToolCalls: number; maxCost: number };
  examples: string[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  kind: "anthropic" | "openai-compatible" | "demo";
  configured: boolean;
  source: "console" | "server" | null;
  keyHint: string | null;
  baseURL: string | null;
  custom: boolean;
  needsKey: boolean;
  needsBaseURL: boolean;
  defaultBaseURL: string | null;
  keyUrl: string | null;
  setup: string;
  models: { id: string; label: string }[];
  customModel: boolean;
  modelPlaceholder?: string;
}

export interface CatalogItem { type: ToolSpec["type"]; label: string; description: string; configurable: boolean }

export interface BuilderAgent {
  id: string;
  draft: AgentSpec;
  currentVersion: number | null;
  updatedAt: string;
  versions: { version: number; note: string; createdAt: string; name: string; model: string }[];
  docs: { id: string; title: string; bytes: number; createdAt: string }[];
}

export interface BuilderListItem { id: string; name: string; description: string; model: string; currentVersion: number | null; unpublishedChanges: boolean; updatedAt: string }

export interface Issue { path: string; message: string }

/**
 * Follow a run live. Calls `onEvent` for each step and `onState` when the run settles.
 * If the live stream drops (proxy, network), it reports the problem and falls back to
 * checking the run every 1.5 s, so the chat never hangs on "Working…".
 */
export function followRun(runId: string, onEvent: (e: AgentEvent) => void, onState: (s: RunSummary) => void): () => void {
  let stopped = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  const source = new EventSource(`/api/runs/${runId}/stream`);
  const settle = (s: RunSummary) => {
    if (stopped) return;
    stopped = true;
    source.close();
    clearTimeout(poll);
    clearInterval(backstop);
    onState(s);
  };
  const pollRun = async () => {
    if (stopped) return;
    try {
      const detail = await api<RunDetail>(`/api/runs/${runId}`);
      detail.events.forEach(onEvent);
      if (!["CREATED", "RUNNING"].includes(detail.status)) return settle(detail);
    } catch { /* try again */ }
    poll = setTimeout(() => void pollRun(), 1_500);
  };
  // Backstop: even if the stream stays open but silent, check the run every 5 s.
  const backstop = setInterval(() => {
    if (stopped) return;
    api<RunDetail>(`/api/runs/${runId}`).then((d) => { if (!["CREATED", "RUNNING"].includes(d.status)) { d.events.forEach(onEvent); settle(d); } }).catch(() => {});
  }, 5_000);
  source.addEventListener("agent-event", (m) => onEvent(JSON.parse((m as MessageEvent<string>).data) as AgentEvent));
  source.addEventListener("run-state", (m) => settle(JSON.parse((m as MessageEvent<string>).data) as RunSummary));
  source.onerror = () => {
    if (stopped || poll !== undefined) return;
    source.close();
    report("warn", "Live updates stream failed; switched to polling", { context: { runId } });
    void pollRun();
  };
  return () => {
    stopped = true;
    source.close();
    clearTimeout(poll);
    clearInterval(backstop);
  };
}

export interface LogIssue { time: string; level: "error" | "warn" | "info"; source: string; message: string; detail?: Record<string, unknown> }

export interface Integrations { apify: { configured: boolean; source: "console" | "server" | null; keyHint: string | null; keyUrl: string } }
export interface StoreActor { id: string; title: string; description: string; users: number | null; pricing: string | null; url: string }
export interface Template { id: string; title: string; summary: string; needs?: string }
export interface MemoryItem { id: string; content: string; kind: string; createdAt: string }
