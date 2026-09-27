import type { LLMProvider } from "@agent-farmework/core";
import { createRuleProvider } from "@agent-farmework/core/testing";
import { openAICompatibleProvider } from "@agent-farmework/llm";
import { anthropicProvider } from "@agent-farmework/provider-anthropic";

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  /** How to enable it (shown when not configured). Never contains a key. */
  setup: string;
  models: { id: string; label: string }[];
  /** The model id can be typed freely (OpenAI, OpenRouter, Ollama, …). */
  customModel: boolean;
  modelPlaceholder?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

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
        return { text: `(demo model) I received: “${h.lastUser.slice(0, 200)}”. Add an API key on the server to get real answers.` };
      },
    ],
    { id: "demo" },
  );
}

/** Build every provider that is configured in the environment; the demo model is always available. */
export function loadProviders(env: Env = process.env): { providers: LLMProvider[]; info: ProviderInfo[] } {
  const providers: LLMProvider[] = [demoProvider()];
  const info: ProviderInfo[] = [
    { id: "demo", label: "Demo (offline, no key)", configured: true, setup: "", models: [{ id: "demo", label: "Demo model" }], customModel: false },
  ];

  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) providers.push(anthropicProvider());
  info.push({
    id: "anthropic",
    label: "Claude (Anthropic)",
    configured: Boolean(anthropicKey),
    setup: "Set ANTHROPIC_API_KEY on the server.",
    models: [
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 (recommended)" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest, cheapest)" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
    customModel: false,
  });

  const compatible: { id: string; label: string; keyVar: string; baseVar: string; defaultBase?: string; placeholder: string; needsKey: boolean }[] = [
    { id: "openai", label: "OpenAI", keyVar: "OPENAI_API_KEY", baseVar: "OPENAI_BASE_URL", defaultBase: "https://api.openai.com/v1", placeholder: "e.g. gpt-4.1-mini", needsKey: true },
    { id: "openrouter", label: "OpenRouter", keyVar: "OPENROUTER_API_KEY", baseVar: "OPENROUTER_BASE_URL", defaultBase: "https://openrouter.ai/api/v1", placeholder: "e.g. anthropic/claude-sonnet-5", needsKey: true },
    { id: "ollama", label: "Ollama / local (OpenAI-compatible)", keyVar: "OLLAMA_API_KEY", baseVar: "OLLAMA_BASE_URL", placeholder: "e.g. llama3.1", needsKey: false },
  ];
  for (const p of compatible) {
    const apiKey = env[p.keyVar];
    const baseURL = env[p.baseVar] ?? p.defaultBase;
    const configured = baseURL !== undefined && (!p.needsKey || Boolean(apiKey));
    if (configured) providers.push(openAICompatibleProvider({ id: p.id, baseURL, ...(apiKey ? { apiKey } : {}) }));
    info.push({
      id: p.id,
      label: p.label,
      configured,
      setup: p.needsKey ? `Set ${p.keyVar} on the server.` : `Set ${p.baseVar} on the server (e.g. http://host.docker.internal:11434/v1).`,
      models: [],
      customModel: true,
      modelPlaceholder: p.placeholder,
    });
  }
  return { providers, info };
}
