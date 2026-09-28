import { htmlToText } from "@agent-farmework/knowledge";
import { createEgressPolicy } from "@agent-farmework/security";

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

export interface Page { url: string; title: string; text: string; truncated: boolean }

/**
 * Fetch a public web page as clean text (the idea behind firecrawl / crawl4ai), safely:
 * https only, every hop (including redirects) checked against private/reserved addresses,
 * HTML or plain text only, size-capped, 15 s timeout.
 */
export async function fetchPageText(input: string, opts: { maxChars?: number; allowHttpForTests?: boolean; raw?: boolean } = {}): Promise<Page> {
  let url = input.trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const host = new URL(url).hostname;
    await createEgressPolicy({ allowHosts: [host], ...(opts.allowHttpForTests ? { allowedProtocols: ["https:", "http:"], allowPrivateNetworks: true } : {}) }).check(url);
    const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "AgentConsole/1.0 (+reader)", accept: "text/html,text/plain;q=0.9,*/*;q=0.1" }, signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location") as string, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`The page answered HTTP ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error(`Not a web page (${type.split(";")[0] || "unknown type"}).`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    const isHtml = /html/i.test(type);
    const title = (isHtml ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] : undefined)?.replace(/\s+/g, " ").trim() || new URL(url).hostname;
    const body = isHtml ? htmlToText(raw.replace(/<(nav|header|footer|aside|noscript|svg|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")) : raw;
    // raw: keep plain text exactly (YAML/Markdown files where indentation matters).
    const text = opts.raw && !isHtml ? body : body.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
    const max = opts.maxChars ?? 12_000;
    return { url, title: title.slice(0, 120), text: text.slice(0, max), truncated: text.length > max };
  }
  throw new Error("Too many redirects.");
}
