import { Bug, ChevronDown, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type LogIssue } from "../api";
import { Button, Card, Empty, ago, cx } from "../ui";

const LEVEL = {
  error: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  warn: "bg-amber-500/14 text-amber-800 dark:text-amber-300",
  info: "bg-slate-500/12 text-slate-600 dark:text-slate-300",
};
const SOURCES = ["", "server", "run", "provider", "browser", "settings", "startup"];

function Row({ issue }: { issue: LogIssue }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-4 py-3">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-3 text-left" disabled={!issue.detail}>
        <span className={cx("mt-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase", LEVEL[issue.level])}>{issue.level}</span>
        <span className="mt-0.5 rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">{issue.source}</span>
        <span className="min-w-0 flex-1 text-sm break-words">{issue.message}</span>
        <span className="shrink-0 text-xs text-muted tabular-nums" title={issue.time}>{ago(issue.time)}</span>
        {issue.detail && <ChevronDown size={15} className={cx("mt-0.5 shrink-0 text-muted transition", !open && "-rotate-90")} />}
      </button>
      {open && issue.detail && <pre className="mt-2 ml-2 max-h-72 overflow-auto rounded-xl bg-panel-2 p-3 text-xs whitespace-pre-wrap break-words">{JSON.stringify(issue.detail, null, 2)}</pre>}
    </li>
  );
}

export function LogsPage() {
  const [data, setData] = useState<{ counts: Record<string, number>; file: string | null; issues: LogIssue[] } | null>(null);
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [auto, setAuto] = useState(true);
  const load = useCallback(() => {
    const q = new URLSearchParams({ limit: "300", ...(level ? { level } : {}), ...(source ? { source } : {}) });
    api<{ counts: Record<string, number>; file: string | null; issues: LogIssue[] }>(`/api/logs?${q}`).then(setData).catch(() => {});
  }, [level, source]);
  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, 4_000);
    return () => clearInterval(t);
  }, [load, auto]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <header className="mb-5 flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="mt-1 text-sm text-muted">Every problem in one place: server errors, failed runs, provider errors, and crashes in your browser. Secrets are removed before anything is written.</p>
        </div>
        <a href="/api/logs/download" className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 ring-inset ring-line hover:bg-panel-2"><Download size={15} />Download</a>
        <Button variant="ghost" onClick={load}><RefreshCw size={15} />Refresh</Button>
      </header>
      {data && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          {(["error", "warn", "info"] as const).map((l) => (
            <button key={l} onClick={() => setLevel(level === l ? "" : l)} aria-pressed={level === l}
              className={cx("rounded-full px-3 py-1 font-medium ring-1 ring-inset", level === l ? "ring-brand" : "ring-transparent", LEVEL[l])}>
              {data.counts[l] ?? 0} {l === "warn" ? "warnings" : l === "error" ? "errors" : "info"}
            </button>
          ))}
          <label className="sr-only" htmlFor="log-source">Source</label>
          <select id="log-source" value={source} onChange={(e) => setSource(e.target.value)} className="rounded-xl border border-line bg-panel px-3 py-1.5 text-sm">
            {SOURCES.map((s) => <option key={s} value={s}>{s || "All sources"}</option>)}
          </select>
          <label className="ml-auto flex items-center gap-2 text-muted"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Live</label>
        </div>
      )}
      {data === null ? null : data.issues.length === 0 ? (
        <Empty icon={<Bug size={22} />} title="No issues recorded">Problems will show up here as they happen.</Empty>
      ) : (
        <Card><ul className="divide-y divide-line">{data.issues.map((i, n) => <Row key={`${i.time}-${n}`} issue={i} />)}</ul></Card>
      )}
      {data?.file && <p className="mt-3 text-xs text-muted">Also written to <code>{data.file}</code> on the server.</p>}
    </div>
  );
}
