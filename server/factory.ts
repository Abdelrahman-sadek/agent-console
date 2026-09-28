import { createRuntime, defineAgent, type Agent, type AgentRuntime, type Guardrail, type LLMProvider } from "@agent-farmework/core";
import { createKnowledgeBase, hashingEmbedder, type KnowledgeBase } from "@agent-farmework/knowledge";
import { piiGuardrail, promptInjectionGuardrail } from "@agent-farmework/security";
import { ToolRuntime } from "@agent-farmework/tools";
import { buildTools, type ApifyAccess } from "./catalog.js";
import { conversationProvider } from "./conversation.js";
import { createMemory, type Memory } from "@agent-farmework/memory";
import type { Database } from "./db.js";
import type { AgentSpec } from "./spec.js";

/** "draft" runs the unpublished draft (test chat); a number runs that published version. */
export type AgentVersionRef = number | "draft";

/**
 * Turns stored specs into framework agents. Agents are cached per (id, version,
 * knowledge revision); a published version never changes, so a run that paused for
 * approval resumes with exactly the agent it started with.
 */
export class AgentFactory {
  private readonly runtime: AgentRuntime;
  private readonly cache = new Map<string, Agent<unknown>>();
  private readonly kbs = new Map<string, { rev: string; kb: KnowledgeBase }>();
  private readonly refunds = new Map<string, string>();
  private readonly memories = new Map<string, Memory>();

  /** One long-term memory per agent, persisted in SQLite. */
  memoryFor(agentId: string): Memory {
    let m = this.memories.get(agentId);
    if (m === undefined) {
      m = createMemory({ name: `agent-${agentId}`, store: this.db.memories(agentId), policy: { minConfidence: 0.5, maxContentLength: 500 } });
      this.memories.set(agentId, m);
    }
    return m;
  }

  /** `timeoutMs` stops a run that hangs (e.g. a provider that never answers). */
  constructor(private readonly db: Database, readonly providerIds: ReadonlySet<string>, providers: LLMProvider[], private readonly timeoutMs = 120_000, private readonly apify: ApifyAccess = { baseURL: "https://api.apify.com" }) {
    this.runtime = createRuntime({ providers, tools: new ToolRuntime({ audit: db.audit }), stateStore: db.runs, events: db.events });
  }

  /** Framework agent id for a stored agent (drafts get their own id so test runs never mix with live runs). */
  static runtimeId(agentId: string, ref: AgentVersionRef): string {
    return ref === "draft" ? `${agentId}.draft` : agentId;
  }

  static parseRuntimeId(runtimeId: string): { agentId: string; draft: boolean } {
    return runtimeId.endsWith(".draft") ? { agentId: runtimeId.slice(0, -6), draft: true } : { agentId: runtimeId, draft: false };
  }

  private async knowledge(agentId: string): Promise<KnowledgeBase> {
    const rev = this.db.agents.docsRevision(agentId);
    const cached = this.kbs.get(agentId);
    if (cached !== undefined && cached.rev === rev) return cached.kb;
    const kb = createKnowledgeBase({ name: `kb-${agentId}`, embedder: hashingEmbedder() });
    const docs = this.db.agents.docs(agentId);
    if (docs.length > 0) await kb.ingest(docs.map((d) => ({ id: d.id, title: d.title, text: d.text })));
    this.kbs.set(agentId, { rev, kb });
    return kb;
  }

  specFor(agentId: string, ref: AgentVersionRef): AgentSpec | undefined {
    const row = this.db.agents.get(agentId);
    if (row === undefined) return undefined;
    return ref === "draft" ? row.draft : this.db.agents.version(agentId, ref)?.spec;
  }

  async build(agentId: string, ref: AgentVersionRef): Promise<Agent<unknown>> {
    const spec = this.specFor(agentId, ref);
    if (spec === undefined) throw new Error(`agent ${agentId} version ${ref} not found`);
    if (!this.providerIds.has(spec.model.providerId)) throw new Error(`model provider "${spec.model.providerId}" is not configured on the server`);
    const rev = spec.knowledge.enabled ? this.db.agents.docsRevision(agentId) : "-";
    // Drafts change often; their cache key includes the draft content.
    const key = `${agentId}@${ref}@${rev}@${ref === "draft" ? JSON.stringify(spec) : ""}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const kb = spec.knowledge.enabled ? await this.knowledge(agentId) : undefined;
    const guardrails: Guardrail[] = [];
    if (spec.guardrails.pii) guardrails.push(piiGuardrail());
    if (spec.guardrails.injection) guardrails.push(promptInjectionGuardrail());
    const tools = buildTools(spec.tools, kb, this.refunds, this.apify);
    const memory = spec.memory.enabled ? this.memoryFor(agentId) : undefined;
    if (memory !== undefined) tools.push(...memory.asTools());

    const agent = defineAgent({
      name: AgentFactory.runtimeId(agentId, ref),
      version: String(ref),
      description: spec.description,
      model: { providerId: spec.model.providerId, modelId: spec.model.modelId },
      instructions: memory === undefined ? spec.instructions : `${spec.instructions}\n\nYou have long-term memory. When the user tells you a stable fact about themselves (name, role, preferences, ongoing projects), save it with the remember tool. Relevant memories appear in your context; use them naturally. Never save secrets or passwords.`,
      tools,
      permissions: ["*"],
      guardrails,
      context: [conversationProvider(), ...(memory === undefined ? [] : [memory.asContextProvider({ k: 20, minScore: -1 })] /* all saved facts (small per agent), most relevant first */), ...(kb === undefined ? [] : [kb.asContextProvider({ k: spec.knowledge.k, minScore: 0.1 })])],
      limits: { maxSteps: spec.limits.maxSteps, maxToolCalls: spec.limits.maxToolCalls, maxCost: spec.limits.maxCost, timeoutMs: this.timeoutMs },
      runtime: this.runtime,
    });
    // Keep only the newest draft per agent in the cache.
    if (ref === "draft") for (const k of this.cache.keys()) if (k.startsWith(`${agentId}@draft@`)) this.cache.delete(k);
    this.cache.set(key, agent as Agent<unknown>);
    return agent as Agent<unknown>;
  }

  /** Resolve the agent a stored run belongs to (the version it started with). */
  async forRun(runtimeAgentId: string, agentVersion: string | undefined): Promise<Agent<unknown> | undefined> {
    const { agentId, draft } = AgentFactory.parseRuntimeId(runtimeAgentId);
    if (this.db.agents.get(agentId) === undefined) return undefined;
    const ref: AgentVersionRef = draft ? "draft" : Number(agentVersion);
    if (ref !== "draft" && !Number.isInteger(ref)) return undefined;
    return this.build(agentId, ref);
  }

  /** Forget cached knowledge for an agent (after uploads or deletions). */
  invalidateKnowledge(agentId: string): void {
    this.kbs.delete(agentId);
  }
}
