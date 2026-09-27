import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type Level = "error" | "warn" | "info";
export type Source = "server" | "run" | "provider" | "browser" | "settings" | "startup";

export interface Issue {
  time: string;
  level: Level;
  source: Source;
  message: string;
  detail?: Record<string, unknown>;
}

/** Remove anything that looks like a secret before it is written anywhere. */
export function redact(text: string): string {
  return text
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***")
    .replace(/\b(sk-[a-z]*-?|AIza|gsk_|xai-)[A-Za-z0-9_-]{8,}/g, "$1***")
    .replace(/("?(api[_-]?key|password|secret|token|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***");
}

const clip = (v: unknown, n: number) => (typeof v === "string" && v.length > n ? `${v.slice(0, n)}…` : v);

/**
 * The console's issue log: one JSON object per line in a file (rotated at 5 MB, one old
 * file kept) plus the latest 1 000 entries in memory for the Logs page.
 */
export class IssueLog {
  private readonly recentIssues: Issue[] = [];

  constructor(readonly file?: string, private readonly maxBytes = 5_000_000) {
    if (file !== undefined) mkdirSync(dirname(file), { recursive: true });
  }

  write(level: Level, source: Source, message: string, detail?: Record<string, unknown>): Issue {
    const clean = detail === undefined ? undefined : (JSON.parse(redact(JSON.stringify(detail, (_k, v) => clip(v, 4_000)))) as Record<string, unknown>);
    const issue: Issue = { time: new Date().toISOString(), level, source, message: redact(String(message)).slice(0, 1_000), ...(clean === undefined ? {} : { detail: clean }) };
    this.recentIssues.push(issue);
    if (this.recentIssues.length > 1_000) this.recentIssues.shift();
    if (this.file !== undefined) {
      try {
        if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
        appendFileSync(this.file, `${JSON.stringify(issue)}\n`, { mode: 0o600 });
      } catch (error) {
        console.error("could not write the issue log", error);
      }
    }
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(`[${level}] ${source}: ${issue.message}`);
    return issue;
  }

  error(source: Source, message: string, detail?: Record<string, unknown>) { return this.write("error", source, message, detail); }
  warn(source: Source, message: string, detail?: Record<string, unknown>) { return this.write("warn", source, message, detail); }
  info(source: Source, message: string, detail?: Record<string, unknown>) { return this.write("info", source, message, detail); }

  recent(opts: { level?: Level; source?: Source; limit?: number } = {}): Issue[] {
    return this.recentIssues
      .filter((i) => (opts.level === undefined || i.level === opts.level) && (opts.source === undefined || i.source === opts.source))
      .slice(-(opts.limit ?? 200))
      .reverse();
  }

  counts(): Record<Level, number> {
    const c: Record<Level, number> = { error: 0, warn: 0, info: 0 };
    for (const i of this.recentIssues) c[i.level] += 1;
    return c;
  }
}

export const errorDetail = (error: unknown): Record<string, unknown> =>
  error instanceof Error ? { name: error.name, stack: error.stack?.split("\n").slice(0, 8).join("\n") } : { value: String(error) };
