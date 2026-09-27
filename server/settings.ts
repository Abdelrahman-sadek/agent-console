import type { Hono } from "hono";
import { z } from "zod";
import type { LiveProviders } from "./app.js";
import { CUSTOM_ID, PRESETS, effective, isPreset, testProvider, type ProviderKind, type SavedProvider } from "./providers.js";
import type { IssueLog } from "./logger.js";
import type { ProviderSecrets } from "./secrets.js";

const url = z.string().trim().max(300).url().refine((u) => /^https?:\/\//.test(u), "must start with http:// or https://");
const Body = z.object({
  /** Omit to keep the saved key; "" removes it. */
  apiKey: z.string().trim().max(500).regex(/^\S*$/, "no spaces").optional(),
  baseURL: z.union([url, z.literal("")]).optional(),
  label: z.string().trim().min(2).max(40).optional(),
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

/** Provider keys and custom providers, managed from the browser. Keys are write-only. */
export function registerProviderSettings(app: Hono, deps: { secrets: ProviderSecrets; env: Readonly<Record<string, string | undefined>>; live: LiveProviders; reload: () => void; log: IssueLog }) {
  const { secrets, env, live, reload, log } = deps;
  const known = (id: string) => isPreset(id) || (CUSTOM_ID.test(id) && secrets.all()[id] !== undefined);
  const presets = () => PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind, defaultBaseURL: p.defaultBaseURL ?? null, keyUrl: p.keyUrl ?? null, needsKey: p.needsKey }));

  app.get("/api/settings/providers", (c) => c.json({ providers: live.providerInfo.filter((p) => p.id !== "demo"), presets: presets() }));

  // Add a custom OpenAI-compatible provider.
  app.post("/api/settings/providers", async (c) => {
    const body = Body.required({ label: true }).extend({ baseURL: url }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Give the provider a name and a base URL.", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    const id = `custom-${slug(body.data.label) || "provider"}`;
    if (!CUSTOM_ID.test(id) || isPreset(id) || secrets.all()[id] !== undefined) return c.json({ error: "A provider with that name already exists." }, 409);
    secrets.set(id, { kind: "openai-compatible", label: body.data.label, baseURL: body.data.baseURL, ...(body.data.apiKey ? { apiKey: body.data.apiKey } : {}) });
    reload();
    log.info("settings", `Custom provider added: ${body.data.label}`, { id, baseURL: body.data.baseURL });
    return c.json({ id, providers: live.providerInfo.filter((p) => p.id !== "demo") }, 201);
  });

  // Save a key and/or base URL for a preset or custom provider.
  app.put("/api/settings/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (!known(id)) return c.json({ error: "Unknown provider." }, 404);
    const body = Body.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "Invalid settings.", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    const prev = secrets.all()[id];
    const next: SavedProvider & { updatedAt?: string } = { ...prev };
    if (body.data.apiKey !== undefined) { if (body.data.apiKey) next.apiKey = body.data.apiKey; else delete next.apiKey; }
    if (body.data.baseURL !== undefined) { if (body.data.baseURL) next.baseURL = body.data.baseURL; else delete next.baseURL; }
    if (body.data.label !== undefined && !isPreset(id)) next.label = body.data.label;
    if (!isPreset(id) && !next.baseURL) return c.json({ error: "A custom provider needs a base URL." }, 400);
    delete next.updatedAt;
    if (body.data.apiKey !== undefined || body.data.baseURL !== undefined) delete next.models; // the next Test refreshes them
    secrets.set(id, next);
    reload();
    log.info("settings", `Provider settings saved: ${id}`, { key: body.data.apiKey === undefined ? "unchanged" : body.data.apiKey ? "replaced" : "removed", baseURL: next.baseURL ?? null });
    return c.json({ providers: live.providerInfo.filter((p) => p.id !== "demo") });
  });

  // Forget what was saved (a preset falls back to the server environment, a custom provider is removed).
  app.delete("/api/settings/providers/:id", (c) => {
    const id = c.req.param("id");
    if (!known(id)) return c.json({ error: "Unknown provider." }, 404);
    secrets.remove(id);
    reload();
    log.info("settings", `Provider settings removed: ${id}`);
    return c.json({ providers: live.providerInfo.filter((p) => p.id !== "demo") });
  });

  // Check the saved settings by listing models (free), and remember the model ids for the builder.
  app.post("/api/settings/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    const saved = secrets.all();
    const e = known(id) ? effective(id, env, saved) : undefined;
    if (e === undefined) return c.json({ error: "Unknown provider." }, 404);
    const preset = PRESETS.find((p) => p.id === id);
    if ((preset?.needsKey ?? false) && !e.apiKey) return c.json({ ok: false, message: "Add an API key first.", models: [] });
    if (e.kind !== "anthropic" && !e.baseURL) return c.json({ ok: false, message: "Add the server URL first.", models: [] });
    const result = await testProvider(e.kind as ProviderKind, e.apiKey, e.baseURL);
    if (!result.ok) log.warn("provider", `Test failed for ${id}: ${result.message}`, { baseURL: e.baseURL ?? null });
    if (result.ok && result.models.length > 0 && saved[id] !== undefined) {
      const { updatedAt: _u, ...value } = saved[id];
      secrets.set(id, { ...value, models: result.models });
      reload();
    }
    return c.json({ ...result, models: result.models.slice(0, 50) });
  });
}
