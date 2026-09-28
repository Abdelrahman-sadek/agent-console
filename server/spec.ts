import { z } from "zod";
import { SKILLS } from "./skills.js";
import { skillwareToolName } from "./skillware.js";

/** When a tool call must wait for a human. */
export const ApprovalSpec = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("never") }),
  z.object({ mode: z.literal("always") }),
  z.object({ mode: z.literal("threshold"), field: z.string().min(1).max(64), over: z.number() }),
]);
export type ApprovalSpec = z.infer<typeof ApprovalSpec>;

const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "lowercase letters, digits and _ (start with a letter)");
const approval = ApprovalSpec.default({ mode: "never" });

/** Tools come only from this catalog; the model can never run arbitrary code. */
export const ToolSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    name: toolName,
    description: z.string().min(3).max(300),
    method: z.enum(["GET", "POST"]).default("GET"),
    /** https URL; {param} placeholders are filled from the model's input (URL-encoded). */
    url: z.string().url().max(500).refine((u) => u.startsWith("https://"), "must start with https://"),
    params: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/)).max(8).default([]),
    approval,
  }),
  z.object({
    type: z.literal("apify_actor"),
    name: toolName,
    description: z.string().min(3).max(300),
    /** Apify Store actor, e.g. "apify/rag-web-browser" (or "apify~rag-web-browser"). */
    actorId: z.string().trim().regex(/^[\w.-]+[/~][\w.-]+$/, "use the form username/actor-name"),
    /** Actor input as JSON; {{param}} inside a string is replaced by what the model provides. */
    input: z.string().max(4_000).default("{}"),
    params: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/)).max(8).default([]),
    maxItems: z.number().int().min(1).max(100).default(10),
    timeoutSecs: z.number().int().min(10).max(110).default(60),
    // Actor runs can cost money on the user's Apify account: ask by default.
    approval: ApprovalSpec.default({ mode: "always" }),
  }),
  z.object({ type: z.literal("knowledge_search"), approval }),
  z.object({ type: z.literal("read_web_page"), approval }),
  z.object({ type: z.literal("check_site_rules"), approval }),
  /** A real Skillware skill run by the skillware-runner service, e.g. "security/prompt_injection_firewall". */
  z.object({ type: z.literal("skillware"), skill: z.string().regex(/^[a-z_]+\/[a-z0-9_]+$/, "a Skillware skill id like category/name"), approval }),
  z.object({ type: z.literal("calculator"), approval }),
  z.object({ type: z.literal("current_time"), approval }),
  z.object({ type: z.literal("demo_lookup_order"), approval }),
  z.object({ type: z.literal("demo_refund"), approval }),
]);
export type ToolSpec = z.infer<typeof ToolSpec>;

export const AgentSpec = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(""),
    instructions: z.string().trim().min(10).max(8000),
    model: z.object({ providerId: z.string().min(1).max(40), modelId: z.string().trim().min(1).max(120) }),
    tools: z.array(ToolSpec).max(12).default([]),
    knowledge: z.object({ enabled: z.boolean().default(false), k: z.number().int().min(1).max(8).default(3) }).default({ enabled: false, k: 3 }),
    /** Long-term memory: the agent saves stable facts about the user and recalls them in later chats. */
    memory: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    /** Built-in skills (see server/skills.ts) and skills imported from Skillware bundles. */
    skills: z.array(z.string().max(40)).max(10).default([]),
    importedSkills: z
      .array(z.object({ title: z.string().trim().min(2).max(80), directive: z.string().max(6_000), constitution: z.string().max(3_000).default(""), source: z.string().url().max(500) }))
      .max(5)
      .default([]),
    guardrails: z.object({ pii: z.boolean().default(true), injection: z.boolean().default(true) }).default({ pii: true, injection: true }),
    limits: z
      .object({
        maxSteps: z.number().int().min(1).max(30).default(8),
        maxToolCalls: z.number().int().min(1).max(30).default(6),
        maxCost: z.number().min(0.01).max(10).default(0.25),
      })
      .default({ maxSteps: 8, maxToolCalls: 6, maxCost: 0.25 }),
    examples: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  })
  .superRefine((spec, ctx) => {
    const names = spec.tools.map(toolNameOf);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["tools"], message: `two tools are named "${dup}"` });
    for (const [i, t] of spec.tools.entries()) {
      if (t.type === "apify_actor") {
        const used = [...t.input.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map((m) => m[1] as string);
        const missing = used.filter((p) => !t.params.includes(p));
        if (missing.length) ctx.addIssue({ code: "custom", path: ["tools", i, "params"], message: `add parameter(s): ${missing.join(", ")}` });
        try {
          const parsed = JSON.parse(t.input.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, "x")) as unknown;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        } catch {
          ctx.addIssue({ code: "custom", path: ["tools", i, "input"], message: 'must be a JSON object, e.g. {"query": "{{query}}"}' });
        }
      }
      if (t.type === "http") {
        const placeholders = [...t.url.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]);
        const missing = placeholders.filter((p) => !t.params.includes(p as string));
        if (missing.length) ctx.addIssue({ code: "custom", path: ["tools", i, "params"], message: `add parameter(s): ${missing.join(", ")}` });
      }
      if (t.approval.mode === "threshold" && !thresholdFields(t).includes(t.approval.field)) {
        ctx.addIssue({ code: "custom", path: ["tools", i, "approval", "field"], message: `"${t.approval.field}" is not an input of this tool` });
      }
    }
    for (const [i, id] of spec.skills.entries()) {
      if (!SKILLS.some((s) => s.id === id)) ctx.addIssue({ code: "custom", path: ["skills", i], message: `unknown skill "${id}"` });
    }
    if (spec.tools.some((t) => t.type === "knowledge_search") && !spec.knowledge.enabled) {
      ctx.addIssue({ code: "custom", path: ["knowledge"], message: "knowledge search needs knowledge enabled" });
    }
  });
export type AgentSpec = z.infer<typeof AgentSpec>;

export function toolNameOf(t: ToolSpec): string {
  switch (t.type) {
    case "http":
    case "apify_actor": return t.name;
    case "skillware": return skillwareToolName(t.skill);
    case "demo_lookup_order": return "lookup_order";
    case "demo_refund": return "issue_refund";
    default: return t.type;
  }
}

/** Inputs a threshold approval rule can look at. */
export function thresholdFields(t: ToolSpec): string[] {
  if (t.type === "http" || t.type === "apify_actor") return t.params;
  if (t.type === "demo_refund") return ["amount"];
  return [];
}

/** A starting point for "New agent". */
export function blankSpec(providerId: string, modelId: string): AgentSpec {
  return AgentSpec.parse({
    name: "New agent",
    instructions: "You are a helpful assistant. Answer briefly and use tools for facts.",
    model: { providerId, modelId },
  });
}
