import type { ContextProvider } from "@agent-farmework/core";
import { parse as parseYaml } from "yaml";
import type { ToolSpec } from "./spec.js";

/**
 * Skills: reusable know-how you attach to any agent. Each adds a directive (how to do the job),
 * a constitution (hard rules), and the tools it needs. The idea and several skills are adapted
 * from Skillware (github.com/ARPAHLS/skillware, MIT): "don't prompt your agents, equip them".
 */
export interface Skill {
  id: string;
  title: string;
  summary: string;
  directive: string;
  constitution: string[];
  tools?: ToolSpec["type"][];
  /** Deterministic checks that run before the model (e.g. crisis triage). */
  context?: () => ContextProvider;
  credit?: string;
}

// Deterministic crisis triage (English and Arabic), adapted from Skillware's mental_coach
// "CRISIS FIRST" rule: it runs on every message, without the model, and biases to escalate.
const CRISIS = [
  /\b(kill|hurt|harm)\s+(myself|me)\b/i, /\bsuicid/i, /\bend (my|it all|my life)\b/i, /\bwant to die\b/i, /\bno reason to live\b/i, /\bself[- ]?harm/i, /\boverdose\b/i,
  /انتحار|أنتحر|انتحر|اقتل نفسي|أقتل نفسي|أؤذي نفسي|اذي نفسي|أريد أن أموت|عايز اموت|عاوز اموت|نفسي اموت|مش عايز اعيش/,
];
export const isCrisis = (text: string) => CRISIS.some((re) => re.test(text));

function crisisGate(): ContextProvider {
  return {
    name: "crisis-gate",
    async provide(request) {
      if (!isCrisis(request.query)) return [];
      return [{
        id: "crisis-gate",
        kind: "instruction",
        priority: 1,
        content: "SAFETY: the user's message shows possible crisis or self-harm signals (detected by a deterministic check). Respond with warmth first, do not coach or analyse. Encourage them to contact local emergency services right now (in Egypt, ambulance: 123) or a person they trust, and to reach a local crisis line or mental-health professional. Ask if they are safe right now.",
      }];
    },
  };
}

export const SKILLS: Skill[] = [
  {
    id: "cite-sources",
    title: "Cite sources",
    summary: "Every factual claim is backed by a source; says so plainly when it doesn't know.",
    directive: "Back every factual claim with its source: [n] for documents, the URL for web pages, the tool name for tool results. If no source supports an answer, say you don't know instead of guessing.",
    constitution: ["Never invent sources, quotes, numbers or URLs.", "Keep what a source says separate from your own reasoning."],
  },
  {
    id: "user-language",
    title: "Arabic & English",
    summary: "Replies in the user's language, understands Egyptian Arabic, keeps names and numbers exact.",
    directive: "Reply in the language the user writes in. Understand Egyptian and Modern Standard Arabic; reply in clear Modern Standard Arabic unless the user writes in dialect. Keep names, numbers, dates and code exactly as given.",
    constitution: ["Do not switch language unless asked.", "When translating, preserve meaning and tone; never add content."],
  },
  {
    id: "site-rules",
    title: "Website permission check",
    summary: "Before any scraping or bulk reading, checks the site's robots.txt and terms, and gives a conservative verdict.",
    directive: "Before reading many pages of a site, scraping, monitoring or bulk downloading, call check_site_rules for the URL. Report the verdict (ALLOWED, CAUTION, DISALLOWED or INSUFFICIENT_EVIDENCE) and why. If the verdict is not ALLOWED, do not proceed with automated access; suggest the site's official API or asking the owner. You may read the terms page with read_web_page to explain the verdict.",
    constitution: ["This is not legal advice; say so when giving a verdict.", "Prefer CAUTION or INSUFFICIENT_EVIDENCE over approving ambiguous access.", "Only evaluate permission; do not perform the scraping task itself."],
    tools: ["check_site_rules", "read_web_page"],
    credit: "Adapted from Skillware compliance/tos_evaluator",
  },
  {
    id: "scam-check",
    title: "Scam & dark-pattern check",
    summary: "Reviews a page or message for scams and manipulative design (fake urgency, hidden costs, pre-ticked boxes).",
    directive: "When asked whether a page, offer or message is trustworthy, read it (read_web_page for links) and look for: fake urgency or countdowns, 'only N left', hidden fees or subscriptions, pre-selected options, confirm-shaming, impersonation of brands or officials, requests for passwords, codes or payment outside normal channels, and mismatched or look-alike domains. List each finding with the exact quote, then give an overall risk: LOW, MEDIUM or HIGH.",
    constitution: ["Warn only: never click, submit, pay or sign up on the user's behalf.", "Every finding must quote the text it is based on.", "Be honest about limits: absence of findings is not proof of safety."],
    tools: ["read_web_page"],
    credit: "Adapted from Skillware security/deceptive_ui_guard",
  },
  {
    id: "supportive-coach",
    title: "Supportive coach (with crisis check)",
    summary: "Kind, practical stress and wellbeing support. A built-in check spots crisis messages (English & Arabic) and escalates first.",
    directive: "Offer supportive, practical, everyday coping ideas (breathing, sleep routines, breaking tasks down, talking to someone trusted). Keep answers short and warm, and ask one gentle question at a time.",
    constitution: ["Non-clinical: never diagnose, prescribe, or claim to be a therapist.", "Crisis first: if there is any sign of danger, prioritise safety resources over coaching.", "Encourage professional help for anything persistent or severe."],
    context: crisisGate,
    credit: "Adapted from Skillware wellness/mental_coach",
  },
  {
    id: "concise",
    title: "Concise answers",
    summary: "Short answers first, details only on request. Saves tokens and reading time.",
    directive: "Answer in at most 5 short sentences or bullet points. Lead with the answer. Offer more detail instead of giving it unasked.",
    constitution: ["Never drop information needed for correctness or safety to be brief."],
  },
];

/** A skill imported from a Skillware bundle (instructions and rules only; its Python code is not run). */
export interface ImportedSkill { title: string; directive: string; constitution: string; source: string }

/** Turn a Skillware bundle (manifest.yaml + instructions.md) into an instructions-only skill. */
export function skillFromBundle(manifestYaml: string, instructions: string, source: string): ImportedSkill {
  const manifest = (parseYaml(manifestYaml) ?? {}) as { name?: unknown; description?: unknown; short_description?: unknown; constitution?: unknown };
  const summary = String(manifest.short_description ?? manifest.description ?? "");
  return {
    title: String(manifest.name ?? source.split("/").pop() ?? "Imported skill").slice(0, 80),
    directive: [summary, instructions.trim()].filter(Boolean).join("\n\n").slice(0, 6_000),
    constitution: typeof manifest.constitution === "string" ? manifest.constitution.trim().slice(0, 3_000) : "",
    source,
  };
}

/** Instructions text for the selected skills, appended to the agent's own instructions. */
export function skillInstructions(ids: readonly string[], imported: readonly ImportedSkill[]): string {
  const parts = [
    ...SKILLS.filter((s) => ids.includes(s.id)).map((s) => `## Skill: ${s.title}\n${s.directive}\nRules you must follow:\n${s.constitution.map((c, i) => `${i + 1}. ${c}`).join("\n")}`),
    ...imported.map((s) => `## Skill: ${s.title} (imported)\n${s.directive}${s.constitution ? `\nRules you must follow:\n${s.constitution}` : ""}`),
  ];
  return parts.length ? `\n\n# Skills\n\n${parts.join("\n\n")}` : "";
}

export const skillTools = (ids: readonly string[]) => [...new Set(SKILLS.filter((s) => ids.includes(s.id)).flatMap((s) => s.tools ?? []))];
export const skillContext = (ids: readonly string[]) => SKILLS.filter((s) => ids.includes(s.id) && s.context).map((s) => (s.context as () => ContextProvider)());

// ------------------------------------------------------------------ robots.txt check (deterministic)

export type SiteVerdict = "ALLOWED" | "CAUTION" | "DISALLOWED" | "INSUFFICIENT_EVIDENCE";

/** Evaluate robots.txt rules for a path, for user-agent "*" (longest match wins, Allow wins ties). */
export function robotsVerdict(robots: string, path: string): { verdict: SiteVerdict; rule: string | null } {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!lastWasAgent || current === undefined) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === "allow" || key === "disallow") && value !== "") current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const group = groups.find((g) => g.agents.includes("*"));
  if (group === undefined) return { verdict: "CAUTION", rule: null };
  const toRe = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
  const matches = group.rules.filter((r) => toRe(r.path).test(path)).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  const best = matches[0];
  if (best === undefined) return { verdict: "ALLOWED", rule: null };
  return { verdict: best.allow ? "ALLOWED" : "DISALLOWED", rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}
