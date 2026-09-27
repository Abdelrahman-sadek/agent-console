import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider } from "@agent-farmework/core";
import { createRuleProvider } from "@agent-farmework/core/testing";
import { openAICompatibleProvider } from "@agent-farmework/llm";
import { anthropicProvider } from "@agent-farmework/provider-anthropic";

export type ProviderKind = "anthropic" | "openai-compatible";

/** A provider saved from the Settings page (secrets are decrypted only on the server). */
export interface SavedProvider {
  kind?: ProviderKind;
  /** Display name, for custom providers. */
  label?: string;
  apiKey?: string;
  baseURL?: string;
  /** Model ids found by the last successful "Test". Not secret. */
  models?: string[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind | "demo";
  configured: boolean;
  /** Where the settings come from: saved in the console, server environment, or nowhere. */
  source: "console" | "server" | null;
  /** Last 4 characters of the key in use, never more. */
  keyHint: string | null;
  /** Base URL in use (not secret). */
  baseURL: string | null;
  /** Custom providers can be deleted entirely; presets only cleared. */
  custom: boolean;
  needsKey: boolean;
  needsBaseURL: boolean;
  defaultBaseURL: string | null;
  keyUrl: string | null;
  /** How to enable it (shown when not configured). Never contains a key. */
  setup: string;
  models: { id: string; label: string }[];
  /** The model id can be typed freely (OpenAI-compatible providers). */
  customModel: boolean;
  modelPlaceholder?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  defaultBaseURL?: string;
  needsKey: boolean;
  keyVar: string;
  baseVar: string;
  keyUrl?: string;
  placeholder: string;
  models?: { id: string; label: string }[];
}

/** Known providers. Anything else OpenAI-compatible can be added as a custom provider. */
export const PRESETS: readonly Preset[] = [
  {
    id: "anthropic", label: "Claude (Anthropic)", kind: "anthropic", needsKey: true, keyVar: "ANTHROPIC_API_KEY", baseVar: "ANTHROPIC_BASE_URL",
    keyUrl: "https://console.anthropic.com/settings/keys", placeholder: "claude-sonnet-5",
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest, cheapest)" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
  },
  { id: "openai", label: "OpenAI", kind: "openai-compatible", defaultBaseURL: "https://api.openai.com/v1", needsKey: true, keyVar: "OPENAI_API_KEY", baseVar: "OPENAI_BASE_URL", keyUrl: "https://platform.openai.com/api-keys", placeholder: "e.g. gpt-4.1-mini" },
  { id: "openrouter", label: "OpenRouter (many models, one key)", kind: "openai-compatible", defaultBaseURL: "https://openrouter.ai/api/v1", needsKey: true, keyVar: "OPENROUTER_API_KEY", baseVar: "OPENROUTER_BASE_URL", keyUrl: "https://openrouter.ai/keys", placeholder: "e.g. anthropic/claude-sonnet-5" },
  { id: "gemini", label: "Google Gemini", kind: "openai-compatible", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, keyVar: "GEMINI_API_KEY", baseVar: "GEMINI_BASE_URL", keyUrl: "https://aistudio.google.com/apikey", placeholder: "press Test in Settings to list models" },
  { id: "groq", label: "Groq", kind: "openai-compatible", defaultBaseURL: "https://api.groq.com/openai/v1", needsKey: true, keyVar: "GROQ_API_KEY", baseVar: "GROQ_BASE_URL", keyUrl: "https://console.groq.com/keys", placeholder: "e.g. llama-3.3-70b-versatile" },
  { id: "mistral", label: "Mistral", kind: "openai-compatible", defaultBaseURL: "https://api.mistral.ai/v1", needsKey: true, keyVar: "MISTRAL_API_KEY", baseVar: "MISTRAL_BASE_URL", keyUrl: "https://console.mistral.ai/api-keys", placeholder: "e.g. mistral-small-latest" },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compatible", defaultBaseURL: "https://api.deepseek.com/v1", needsKey: true, keyVar: "DEEPSEEK_API_KEY", baseVar: "DEEPSEEK_BASE_URL", keyUrl: "https://platform.deepseek.com/api_keys", placeholder: "e.g. deepseek-chat" },
  { id: "xai", label: "xAI (Grok)", kind: "openai-compatible", defaultBaseURL: "https://api.x.ai/v1", needsKey: true, keyVar: "XAI_API_KEY", baseVar: "XAI_BASE_URL", keyUrl: "https://console.x.ai", placeholder: "e.g. grok-3-mini" },
  { id: "together", label: "Together AI", kind: "openai-compatible", defaultBaseURL: "https://api.together.xyz/v1", needsKey: true, keyVar: "TOGETHER_API_KEY", baseVar: "TOGETHER_BASE_URL", keyUrl: "https://api.together.ai/settings/api-keys", placeholder: "e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "ollama", label: "Ollama / local server", kind: "openai-compatible", needsKey: false, keyVar: "OLLAMA_API_KEY", baseVar: "OLLAMA_BASE_URL", placeholder: "e.g. llama3.1" },
];

export const isPreset = (id: string) => PRESETS.some((p) => p.id === id);
export const CUSTOM_ID = /^custom-[a-z0-9][a-z0-9-]{0,30}$/;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** The context sentence sharing the most words with the question, with its citation number. */
function bestSentence(context: string, question: string): { sentence: string; ref: string } | undefined {
  const q = words(question);
  let best: { sentence: string; ref: string; score: number } | undefined;
  for (const block of context.split(/(?=^\[\d+\] \(knowledge: )/m)) {
    const head = /^\[(\d+)\] \(knowledge: [^)]+\)\n/.exec(block);
    if (head === null) continue;
    for (const sentence of block.slice(head[0].length).split(/(?<=[.!?])\s+|\n+/)) {
      const s = sentence.trim();
      if (s.length === 0) continue;
      const score = [...words(s)].filter((w) => q.has(w)).length;
      if (best === undefined || score > best.score) best = { sentence: s, ref: head[1] as string, score };
    }
  }
  return best;
}

/**
 * Offline stand-in used when no API key is configured, so the builder can be tried
 * end to end: answers from the agent's knowledge (with a citation), reports tool
 * results, and otherwise says plainly that it is the demo model.
 */
function demoProvider(): LLMProvider {
  return createRuleProvider(
    [
      (_r, h) => {
        const tool = Object.entries(h.toolResults).at(-1);
        if (tool !== undefined) return { text: `(demo model) The ${tool[0]} tool returned: ${tool[1].slice(0, 400)}` };
        const best = bestSentence(h.context, h.lastUser);
        if (best !== undefined) return { text: `${best.sentence} [${best.ref}]` };
        return { text: `(demo model) I received: “${h.lastUser.slice(0, 200)}”. Add an API key in Settings to get real answers.` };
      },
    ],
    { id: "demo" },
  );
}

const hint = (key: string | undefined) => (key ? `…${key.slice(-4)}` : null);

/** The effective settings for one provider: saved in the console first, then server environment. */
export function effective(id: string, env: Env, saved: Record<string, SavedProvider>): { kind: ProviderKind; label: string; apiKey?: string; baseURL?: string; source: "console" | "server" | null } | undefined {
  const preset = PRESETS.find((p) => p.id === id);
  const s = saved[id];
  if (preset === undefined) {
    if (s === undefined || !CUSTOM_ID.test(id)) return undefined;
    return { kind: "openai-compatible", label: s.label ?? id, ...(s.apiKey ? { apiKey: s.apiKey } : {}), ...(s.baseURL ? { baseURL: s.baseURL } : {}), source: "console" };
  }
  const fromConsole = s !== undefined && (Boolean(s.apiKey) || Boolean(s.baseURL));
  const apiKey = s?.apiKey || env[preset.keyVar] || undefined;
  const baseURL = s?.baseURL || env[preset.baseVar] || preset.defaultBaseURL;
  const fromServer = Boolean(env[preset.keyVar]) || Boolean(env[preset.baseVar]);
  return { kind: preset.kind, label: preset.label, ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}), source: fromConsole ? "console" : fromServer ? "server" : null };
}

/** Build every configured provider; the demo model is always available. */
export function loadProviders(env: Env = process.env, saved: Record<string, SavedProvider> = {}): { providers: LLMProvider[]; info: ProviderInfo[] } {
  const providers: LLMProvider[] = [demoProvider()];
  const info: ProviderInfo[] = [{
    id: "demo", label: "Demo (offline, no key)", kind: "demo", configured: true, source: null, keyHint: null, baseURL: null, custom: false,
    needsKey: false, needsBaseURL: false, defaultBaseURL: null, keyUrl: null, setup: "", models: [{ id: "demo", label: "Demo model" }], customModel: false,
  }];

  const customIds = Object.keys(saved).filter((id) => !isPreset(id) && CUSTOM_ID.test(id)).sort();
  for (const id of [...PRESETS.map((p) => p.id), ...customIds]) {
    const preset = PRESETS.find((p) => p.id === id);
    const e = effective(id, env, saved);
    if (e === undefined) continue;
    const needsKey = preset?.needsKey ?? false;
    const configured = Boolean(e.baseURL || e.kind === "anthropic") && (!needsKey || Boolean(e.apiKey));
    if (configured) {
      if (e.kind === "anthropic") {
        const viaEnvOnly = e.source === "server" && !saved[id];
        providers.push(viaEnvOnly ? anthropicProvider({ id }) : anthropicProvider({ id, client: new Anthropic({ maxRetries: 0, ...(e.apiKey ? { apiKey: e.apiKey } : {}), ...(e.baseURL ? { baseURL: e.baseURL } : {}) }) }));
      } else {
        providers.push(openAICompatibleProvider({ id, baseURL: e.baseURL as string, ...(e.apiKey ? { apiKey: e.apiKey } : {}) }));
      }
    }
    const found = (saved[id]?.models ?? []).map((m) => ({ id: m, label: m }));
    info.push({
      id,
      label: e.label,
      kind: e.kind,
      configured,
      source: e.source,
      keyHint: hint(e.apiKey),
      baseURL: e.baseURL ?? null,
      custom: preset === undefined,
      needsKey,
      needsBaseURL: preset === undefined || preset.defaultBaseURL === undefined && preset.kind !== "anthropic",
      defaultBaseURL: preset?.defaultBaseURL ?? null,
      keyUrl: preset?.keyUrl ?? null,
      setup: needsKey ? "Add an API key in Settings." : "Add the server URL in Settings (e.g. http://host.docker.internal:11434/v1).",
      models: preset?.models ?? found,
      customModel: e.kind !== "anthropic",
      modelPlaceholder: preset?.placeholder ?? "model id",
    });
  }
  return { providers, info };
}

/** Check a key/URL without spending tokens: list the provider's models. */
export async function testProvider(kind: ProviderKind, apiKey: string | undefined, baseURL: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; message: string; models: string[] }> {
  const signal = AbortSignal.timeout(10_000);
  try {
    const res = kind === "anthropic"
      ? await fetchImpl(`${(baseURL ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/models?limit=100`, { headers: { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }, signal })
      : await fetchImpl(`${(baseURL ?? "").replace(/\/$/, "")}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "The provider rejected this key.", models: [] };
    if (!res.ok) return { ok: false, message: `The provider answered HTTP ${res.status}.`, models: [] };
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] };
    const models = [...(body.data ?? []).map((m) => m.id), ...(body.models ?? []).map((m) => m.name)]
      .filter((m): m is string => typeof m === "string").map((m) => m.replace(/^models\//, ""))
      .filter((m) => !/embed|imagen|veo|tts|aqa|whisper|dall-e|moderation|transcribe|audio|image-generation/i.test(m)) // chat models only
      .slice(0, 200);
    return { ok: true, message: models.length ? `Connected · ${models.length} models available.` : "Connected.", models };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out after 10 s" : "could not be reached";
    return { ok: false, message: `The provider ${reason}. Check the URL.`, models: [] };
  }
}
