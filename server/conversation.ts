import type { AgentState, ContextProvider } from "@agent-farmework/core";

export interface Turn { user: string; assistant: string }

/** Remove <thought>/<think>/<thinking> reasoning so it is never fed back to the model. */
export const stripThoughts = (text: string) => text.replace(/<(thought|think|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, "").trim();

const MAX_TURNS = 8;
const MAX_CHARS_PER_MESSAGE = 2_000;
const clip = (s: string) => (s.length > MAX_CHARS_PER_MESSAGE ? `${s.slice(0, MAX_CHARS_PER_MESSAGE)}…` : s);

/**
 * Rebuild the earlier turns of a chat from its finished runs. Only runs of the same agent
 * (published or its draft) are used, oldest first, at most 8 turns.
 */
export function turnsFromRuns(states: readonly (AgentState | undefined)[], agentId: string): Turn[] {
  const base = agentId.replace(/\.draft$/, "");
  return states
    .filter((s): s is AgentState => s !== undefined && s.status === "COMPLETED" && s.agentId.replace(/\.draft$/, "") === base)
    .map((s) => {
      const user = s.messages.find((m) => m.role === "user")?.content;
      const output = typeof s.output === "string" ? s.output : s.output === undefined ? "" : JSON.stringify(s.output);
      return { user: typeof user === "string" ? user : String(s.input ?? ""), assistant: stripThoughts(output) };
    })
    .filter((t) => t.user.trim() !== "")
    .slice(-MAX_TURNS)
    .map((t) => ({ user: clip(t.user), assistant: clip(t.assistant) }));
}

/** Gives the model the earlier turns of this chat (passed in run metadata as `history`). */
export function conversationProvider(): ContextProvider {
  return {
    name: "conversation",
    async provide(request) {
      const history = request.metadata["history"];
      if (!Array.isArray(history) || history.length === 0) return [];
      const lines = (history as Turn[]).map((t) => `User: ${t.user}\nAssistant: ${t.assistant || "(no answer)"}`).join("\n\n");
      return [{
        id: "conversation",
        kind: "conversation",
        priority: 0.9,
        content: `Earlier in this conversation (oldest first). Use it to understand follow-up messages:\n\n${lines}`,
      }];
    },
  };
}
