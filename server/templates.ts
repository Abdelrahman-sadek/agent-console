import { AgentSpec } from "./spec.js";

/** Ready-made starting points for "New agent" (ideas from ai-agents-for-beginners, firecrawl, claude-mem…). */
export interface Template {
  id: string;
  title: string;
  summary: string;
  /** What must be set up first, shown on the card. */
  needs?: string;
  spec: (model: { providerId: string; modelId: string }) => AgentSpec;
}

const make = (s: Record<string, unknown>) => (model: { providerId: string; modelId: string }) => AgentSpec.parse({ ...s, model });

export const TEMPLATES: Template[] = [
  {
    id: "web-reader",
    title: "Web page reader",
    summary: "Reads links you give it and answers, summarizes or compares pages, citing each URL.",
    spec: make({
      name: "Web reader",
      description: "Reads the web pages you give it and answers from them.",
      instructions: "You read web pages for the user. When they give a link or ask about a page, use read_web_page, then answer from what the page says. Quote key facts, cite the URL, and say clearly when the page does not contain the answer. Summaries: short bullet points first, details after.",
      tools: [{ type: "read_web_page" }],
      skills: ["cite-sources"],
      examples: ["Summarize https://en.wikipedia.org/wiki/Cairo_University", "What are the main points of this page? https://example.com"],
    }),
  },
  {
    id: "doc-qa",
    title: "Document Q&A",
    summary: "Upload PDFs or notes (or add a web page) and ask questions. Answers cite the document.",
    spec: make({
      name: "Document Q&A",
      description: "Answers questions from your uploaded documents, with citations.",
      instructions: "Answer only from the provided documents. Cite sources as [n]. If the documents do not contain the answer, say so plainly and suggest what document would help. Answer in the user's language.",
      knowledge: { enabled: true, k: 4 },
      tools: [{ type: "knowledge_search" }],
      skills: ["cite-sources"],
      examples: ["What does the policy say about travel?", "Summarize the main rules in the documents"],
    }),
  },
  {
    id: "assistant-memory",
    title: "Personal assistant with memory",
    summary: "Remembers your name, role and preferences across chats. Knows the date and does exact maths.",
    spec: make({
      name: "My assistant",
      description: "A helpful assistant that remembers you across conversations.",
      instructions: "You are a friendly, concise personal assistant. Adapt to the user's saved preferences (language, tone, format). Use current_time for dates and calculator for any arithmetic.",
      memory: { enabled: true },
      skills: ["user-language"],
      tools: [{ type: "current_time" }, { type: "calculator" }],
      examples: ["My name is Abdelrahman and I prefer answers in Arabic", "What day is it today?", "What do you remember about me?"],
    }),
  },
  {
    id: "support-approvals",
    title: "Customer support with approvals",
    summary: "Looks up orders and issues refunds; refunds over $100 wait for your approval. Uses demo data.",
    spec: make({
      name: "Support desk",
      description: "Handles order questions and refunds; big refunds need approval.",
      instructions: "Help customers with orders. Always look up the order before acting. Refund only delivered orders, for the order amount, and explain what you did. Never promise anything a tool did not confirm.",
      tools: [{ type: "demo_lookup_order" }, { type: "demo_refund", approval: { mode: "threshold", field: "amount", over: 100 } }],
      examples: ["Where is order ord-90?", "Refund ord-17, it arrived broken", "Refund ord-42 please"],
    }),
  },
  {
    id: "web-search",
    title: "Web search (Apify)",
    summary: "Searches the web and reads the top results to answer with sources.",
    needs: "An Apify token in Settings → Integrations",
    spec: make({
      name: "Web search",
      description: "Searches the web and answers with sources.",
      instructions: "Search the web with web_search for current information, then answer briefly with the most relevant sources as links. If results disagree, say so.",
      tools: [{ type: "apify_actor", name: "web_search", description: "Search the web and get the content of the top pages", actorId: "apify/rag-web-browser", input: '{"query": "{{query}}", "maxResults": 3}', params: ["query"], maxItems: 3, timeoutSecs: 60 }],
      examples: ["Latest news about AI agents", "Best universities in Egypt for computer science"],
    }),
  },
  {
    id: "writer",
    title: "Writing & translation",
    summary: "Drafts emails and posts, fixes grammar, and translates between Arabic and English.",
    spec: make({
      name: "Writer",
      description: "Drafts, edits and translates text.",
      instructions: "You are a careful writing assistant. For drafts: ask at most one clarifying question, then write. For edits: return the improved text, then a short list of what changed. For translation between Arabic and English: keep meaning and tone, and keep names and numbers exact.",
      guardrails: { pii: false, injection: true },
      examples: ["Translate to Arabic: Our office opens at 9 am on Sunday.", "Write a short, polite email asking for a meeting next week"],
    }),
  },
];
