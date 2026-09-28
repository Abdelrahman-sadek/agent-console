import { randomBytes } from "node:crypto";
import { htmlToText } from "@agent-farmework/knowledge";
import type { Hono } from "hono";
import { z } from "zod";
import { CATALOG } from "./catalog.js";
import { TEMPLATES } from "./templates.js";
import { SKILLS, skillFromBundle } from "./skills.js";
import { fetchPageText } from "./webpage.js";
import type { AgentRow, Database } from "./db.js";
import type { LiveProviders } from "./app.js";
import { AgentSpec, blankSpec, toolNameOf, type ApprovalSpec } from "./spec.js";

const MAX_UPLOAD_BYTES = 5_000_000;
const MAX_DOC_CHARS = 400_000;

const approvalText = (a: ApprovalSpec): string | undefined =>
  a.mode === "never" ? undefined : a.mode === "always" ? "Always" : `${a.field} over ${a.over}`;

/** The shape the Agents and Chat pages already use, for an agent built in the browser. */
export function customAgentInfo(row: AgentRow, spec: AgentSpec) {
  return {
    id: row.id,
    kind: "custom" as const,
    version: row.currentVersion,
    name: spec.name,
    description: spec.description || "Built in the console.",
    model: `${spec.model.providerId} · ${spec.model.modelId}`,
    examples: spec.examples,
    tools: spec.tools.map((t) => ({ name: toolNameOf(t), description: t.type === "http" ? t.description : (CATALOG.find((c) => c.type === t.type)?.label ?? t.type), approval: approvalText(t.approval) })),
    guardrails: [spec.guardrails.pii && "Personal data redaction", spec.guardrails.injection && "Prompt-injection blocking", spec.knowledge.enabled && "Answers from uploaded documents"].filter(Boolean) as string[],
    limits: { maxSteps: spec.limits.maxSteps, maxToolCalls: spec.limits.maxToolCalls },
  };
}

function issues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

async function extractText(name: string, bytes: Uint8Array): Promise<string> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await pdfText(pdf, { mergePages: true });
    return String(text);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return htmlToText(text);
  if (/\.(txt|md|markdown|csv|json)$/.test(lower)) return text;
  throw new Error("Supported files: .pdf, .txt, .md, .html, .csv, .json");
}

export function registerBuilder(app: Hono, deps: { db: Database; live: LiveProviders }) {
  const { db, live } = deps;
  const isConfigured = (id: string) => live.providerInfo.some((p) => p.id === id && p.configured);
  const defaultModel = (): { providerId: string; modelId: string } => {
    const real = live.providerInfo.find((p) => p.configured && p.id !== "demo" && p.models.length > 0);
    return real ? { providerId: real.id, modelId: real.models[0]?.id ?? "" } : { providerId: "demo", modelId: "demo" };
  };
  const detail = (row: AgentRow) => ({
    id: row.id,
    draft: row.draft,
    currentVersion: row.currentVersion,
    updatedAt: row.updatedAt,
    versions: db.agents.versions(row.id).map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt, name: v.spec.name, model: `${v.spec.model.providerId} · ${v.spec.model.modelId}` })),
    docs: db.agents.docs(row.id).map((d) => ({ id: d.id, title: d.title, bytes: d.bytes, createdAt: d.createdAt })),
  });
  const load = (id: string) => db.agents.get(id);

  app.get("/api/builder/models", (c) => c.json(live.providerInfo));
  app.get("/api/builder/catalog", (c) => c.json(CATALOG));
  app.get("/api/builder/skills", (c) => c.json(SKILLS.map((s) => ({ id: s.id, title: s.title, summary: s.summary, tools: s.tools ?? [], rules: s.constitution, credit: s.credit ?? null }))));

  // Preview a Skillware skill from its GitHub folder: instructions + constitution only (its Python is not run).
  app.post("/api/builder/skills/import", async (c) => {
    const url = z.object({ url: z.string().trim().url().max(500) }).safeParse(await c.req.json().catch(() => ({})));
    const m = url.success ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:tree|blob)\/([\w.\/-]+?)\/(skills\/[\w\/-]+?)\/?(?:manifest\.yaml|instructions\.md)?$/.exec(url.data.url) : null;
    if (m === null) return c.json({ error: "Paste a GitHub link to a skill folder, e.g. https://github.com/ARPAHLS/skillware/tree/main/skills/compliance/pii_masker" }, 400);
    const [, owner, repo, ref, path] = m as unknown as [string, string, string, string, string];
    const raw = (file: string) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}/${file}`;
    try {
      const manifestYaml = (await fetchPageText(raw("manifest.yaml"), { maxChars: 50_000, raw: true })).text;
      const instructions = await fetchPageText(raw("instructions.md"), { maxChars: 6_000, raw: true }).then((p) => p.text).catch(() => "");
      const skill = skillFromBundle(manifestYaml, instructions, `https://github.com/${owner}/${repo}/tree/${ref}/${path}`);
      if (!skill.directive) return c.json({ error: "That folder has no manifest description or instructions.md." }, 400);
      return c.json({ skill, note: "Imported as instructions and rules only. The skill's Python code is not run in the console." });
    } catch (error) {
      return c.json({ error: `Could not read that skill: ${error instanceof Error ? error.message : String(error)}` }, 400);
    }
  });

  // Real Skillware skills from the skillware-runner service.
  app.get("/api/builder/skillware", async (c) => {
    if (live.skillware === undefined) return c.json({ available: false, skills: [], error: "The Skillware runner is not set up on this server." });
    try {
      const skills = await live.skillware.skills(c.req.query("refresh") === "1");
      return c.json({ available: true, skills: skills.map((s) => ({ id: s.id, title: s.title, summary: s.summary, needsKeys: Object.keys(s.env), version: s.version ?? null })) });
    } catch (error) {
      return c.json({ available: false, skills: [], error: error instanceof Error ? error.message : "The Skillware runner is not reachable." });
    }
  });

  app.get("/api/builder/templates", (c) => c.json(TEMPLATES.map(({ spec: _s, ...t }) => t)));

  app.get("/api/builder/agents", (c) =>
    c.json(db.agents.list().map((r) => {
      const live = r.currentVersion === null ? undefined : db.agents.version(r.id, r.currentVersion)?.spec;
      return { id: r.id, name: r.draft.name, description: r.draft.description, model: `${r.draft.model.providerId} · ${r.draft.model.modelId}`, currentVersion: r.currentVersion, unpublishedChanges: live === undefined || JSON.stringify(live) !== JSON.stringify(r.draft), updatedAt: r.updatedAt };
    })),
  );

  app.post("/api/builder/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { spec?: unknown; template?: unknown };
    const { providerId, modelId } = defaultModel();
    const template = typeof body.template === "string" ? TEMPLATES.find((t) => t.id === body.template) : undefined;
    if (body.template !== undefined && template === undefined) return c.json({ error: "Unknown template." }, 400);
    const parsed =
      template !== undefined ? { success: true as const, data: template.spec({ providerId, modelId }) }
      : body.spec === undefined ? { success: true as const, data: blankSpec(providerId, modelId) }
      : AgentSpec.safeParse(body.spec);
    if (!parsed.success) return c.json({ error: "Invalid agent.", issues: issues(parsed.error) }, 400);
    const id = `ag-${randomBytes(4).toString("hex")}`;
    return c.json(detail(db.agents.create(id, parsed.data)), 201);
  });

  app.get("/api/builder/agents/:id", (c) => {
    const row = load(c.req.param("id"));
    return row === undefined ? c.json({ error: "Agent not found." }, 404) : c.json(detail(row));
  });

  app.put("/api/builder/agents/:id", async (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    const parsed = AgentSpec.safeParse(((await c.req.json().catch(() => ({}))) as { spec?: unknown }).spec);
    if (!parsed.success) return c.json({ error: "Please fix the highlighted fields.", issues: issues(parsed.error) }, 400);
    db.agents.saveDraft(row.id, parsed.data);
    return c.json(detail(load(row.id) as AgentRow));
  });

  app.post("/api/builder/agents/:id/publish", async (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    const note = z.object({ note: z.string().max(200).default("") }).parse(await c.req.json().catch(() => ({}))).note;
    if (row.draft.tools.some((t) => t.type === "skillware")) {
      const ids = row.draft.tools.flatMap((t) => (t.type === "skillware" ? [t.skill] : []));
      const available = live.skillware ? await live.skillware.skills().then((s) => s.map((x) => x.id)).catch(() => [] as string[]) : [];
      const missing = ids.filter((id) => !available.includes(id));
      if (missing.length) return c.json({ error: `Skillware skill not available on the server: ${missing.join(", ")}.` }, 400);
    }
    if (row.draft.tools.some((t) => t.type === "apify_actor") && !live.apifyConfigured) return c.json({ error: "This agent uses an Apify actor. Add your Apify token in Settings → Integrations first." }, 400);
    if (!isConfigured(row.draft.model.providerId)) return c.json({ error: `The model provider "${row.draft.model.providerId}" is not configured. Add it in Settings.` }, 400);
    try {
      await live.factory.build(row.id, "draft"); // catches anything that would fail at run time
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "The agent could not be built." }, 400);
    }
    const version = db.agents.publish(row.id, note);
    return c.json({ ...detail(load(row.id) as AgentRow), published: version });
  });

  app.post("/api/builder/agents/:id/rollback", async (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    const body = z.object({ version: z.number().int().positive() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success || db.agents.version(row.id, body.data.version) === undefined) return c.json({ error: "Version not found." }, 400);
    db.agents.rollback(row.id, body.data.version);
    return c.json(detail(load(row.id) as AgentRow));
  });

  app.delete("/api/builder/agents/:id", (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    db.agents.archive(row.id);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ knowledge
  app.post("/api/builder/agents/:id/knowledge", async (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    let title: string;
    let text: string;
    try {
      if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) return c.json({ error: "Choose a file." }, 400);
        if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "Files up to 5 MB." }, 400);
        title = (typeof form.title === "string" && form.title.trim()) || file.name;
        text = await extractText(file.name, new Uint8Array(await file.arrayBuffer()));
      } else {
        const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        if (typeof json.url === "string") {
          // Add a web page as a document (clean text, same safety checks as the Read web page tool).
          const page = await fetchPageText(json.url, { maxChars: MAX_DOC_CHARS, allowHttpForTests: process.env.READER_ALLOW_PRIVATE_FOR_TESTS === "1" });
          title = page.title;
          text = `Source: ${page.url}\n\n${page.text}`;
        } else {
          const body = z.object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1) }).safeParse(json);
          if (!body.success) return c.json({ error: "Give the document a title and some text." }, 400);
          ({ title, text } = body.data);
        }
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Could not read the file." }, 400);
    }
    text = text.replace(/\u0000/g, "").trim();
    if (text.length === 0) return c.json({ error: "No text found in that file (scanned PDFs are not supported yet)." }, 400);
    if (text.length > MAX_DOC_CHARS) return c.json({ error: `Documents up to ${MAX_DOC_CHARS.toLocaleString()} characters.` }, 400);
    db.agents.addDoc(row.id, { id: `doc-${randomBytes(5).toString("hex")}`, title: title.slice(0, 120), text });
    live.factory.invalidateKnowledge(row.id);
    return c.json(detail(load(row.id) as AgentRow), 201);
  });

  // ------------------------------------------------------------ long-term memory
  app.get("/api/builder/agents/:id/memories", async (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    const records = await db.memories(row.id).list({});
    return c.json(records.filter((r) => r.kind !== "conversation").reverse().map((r) => ({ id: r.id, content: r.content, kind: r.kind, createdAt: r.createdAt })));
  });
  app.delete("/api/builder/agents/:id/memories/:memoryId", async (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    return (await db.memories(row.id).delete(c.req.param("memoryId"))) ? c.json({ ok: true }) : c.json({ error: "Memory not found." }, 404);
  });

  app.delete("/api/builder/agents/:id/knowledge/:docId", (c) => {
    const row = load(c.req.param("id"));
    if (row === undefined) return c.json({ error: "Agent not found." }, 404);
    if (!db.agents.removeDoc(row.id, c.req.param("docId"))) return c.json({ error: "Document not found." }, 404);
    live.factory.invalidateKnowledge(row.id);
    return c.json(detail(load(row.id) as AgentRow));
  });
}
