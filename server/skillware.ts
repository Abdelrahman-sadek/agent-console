import { createEgressPolicy } from "@agent-farmework/security";
import { z } from "zod";

/** A Skillware skill as described by the runner (real Python code from github.com/ARPAHLS/skillware). */
export interface SkillwareSkill {
  id: string;
  title: string;
  summary: string;
  description: string;
  parameters: JsonSchema;
  constitution: string;
  instructions: string;
  env: Record<string, boolean>;
  version?: string;
}
type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; items?: JsonSchema; description?: string };

/** Tool name for a skill: "security/prompt_injection_firewall" -> "prompt_injection_firewall". */
export const skillwareToolName = (id: string) => (id.split("/").pop() ?? id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** Convert a skill's JSON-schema parameters into a zod schema the framework can hand to the model. */
export function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (schema === undefined) return z.unknown();
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  let out: z.ZodTypeAny;
  if (schema.enum && schema.enum.every((v) => typeof v === "string") && schema.enum.length > 0) out = z.enum(schema.enum as [string, ...string[]]);
  else if (type === "string") out = z.string().max(200_000);
  else if (type === "integer") out = z.number().int();
  else if (type === "number") out = z.number();
  else if (type === "boolean") out = z.boolean();
  else if (type === "array") out = z.array(jsonSchemaToZod(schema.items)).max(1_000);
  else if (type === "object" || schema.properties) {
    const req = new Set(schema.required ?? []);
    const shape = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, req.has(k) ? jsonSchemaToZod(v) : jsonSchemaToZod(v).optional()]));
    out = z.object(shape).passthrough();
  } else out = z.unknown();
  return schema.description ? out.describe(schema.description.slice(0, 500)) : out;
}

/** Every string parameter that looks like a URL must be a public https address (SSRF guard). */
export async function checkUrlParams(params: Record<string, unknown>, allowPrivateForTests = false): Promise<void> {
  for (const [key, value] of Object.entries(params)) {
    if (!/url$/i.test(key) || typeof value !== "string" || value === "") continue;
    let host: string;
    try { host = new URL(value).hostname; } catch { throw new Error(`${key} is not a valid URL`); }
    await createEgressPolicy({ allowHosts: [host], ...(allowPrivateForTests ? { allowedProtocols: ["https:", "http:"], allowPrivateNetworks: true } : {}) }).check(value);
  }
}

/** Client for the private skillware-runner service. */
export class SkillwareClient {
  private cache: { at: number; skills: SkillwareSkill[] } | undefined;
  constructor(readonly baseURL: string, private readonly token: string) {}

  async skills(force = false): Promise<SkillwareSkill[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.skills;
    const res = await fetch(`${this.baseURL.replace(/\/$/, "")}/skills`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Skillware runner answered HTTP ${res.status}`);
    const skills = ((await res.json()) as { skills: SkillwareSkill[] }).skills;
    this.cache = { at: Date.now(), skills };
    return skills;
  }

  async run(id: string, params: Record<string, unknown>, env: Record<string, string>): Promise<unknown> {
    const res = await fetch(`${this.baseURL.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ skill: id, params, env }),
      signal: AbortSignal.timeout(100_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
    if (!body.ok) throw new Error(`Skillware ${id}: ${body.error ?? `HTTP ${res.status}`}`);
    const text = JSON.stringify(body.result);
    return text.length > 8_000 ? { truncated: true, result: `${text.slice(0, 8_000)}…` } : body.result;
  }
}
