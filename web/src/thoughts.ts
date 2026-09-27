export type Part = { kind: "answer" | "thought"; text: string };

/**
 * Split a model answer into visible text and reasoning blocks. Handles <thought>, <think>
 * and <thinking> (Gemma, DeepSeek, Qwen, …), case-insensitively, and a block that was never
 * closed (the rest of the text is reasoning). Empty parts are dropped.
 */
export function splitThoughts(text: string): Part[] {
  const parts: Part[] = [];
  const re = /<(thought|think|thinking)>([\s\S]*?)(?:<\/\1>|$)/gi;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) parts.push({ kind: "answer", text: text.slice(last, m.index) });
    parts.push({ kind: "thought", text: m[2] ?? "" });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push({ kind: "answer", text: text.slice(last) });
  return parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text !== "");
}
