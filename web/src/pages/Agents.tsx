import { ArrowRight, Hand, Loader2, Pencil, Plus, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { api, post, type AgentInfo, type BuilderAgent, type BuilderListItem } from "../api";
import { Button, Card, ago } from "../ui";

export function AgentsPage({ agents }: { agents: AgentInfo[] }) {
  const [mine, setMine] = useState<BuilderListItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<BuilderListItem[]>("/api/builder/agents").then(setMine).catch(() => {}); }, []);

  const create = async () => {
    setCreating(true);
    try {
      const a = await post<BuilderAgent>("/api/builder/agents", {});
      window.location.hash = `#/build/${a.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the agent.");
      setCreating(false);
    }
  };
  const drafts = mine.filter((m) => m.currentVersion === null);
  const editable = new Set(mine.map((m) => m.id));
  const pending = new Set(mine.filter((m) => m.currentVersion !== null && m.unpublishedChanges).map((m) => m.id));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted">Each agent can only use its listed tools, within hard limits. Risky actions wait for you.</p>
        </div>
        <Button onClick={() => void create()} disabled={creating}>{creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}New agent</Button>
      </header>
      {error && <p role="alert" className="mb-4 text-sm text-rose-600">{error}</p>}

      {drafts.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Drafts (not in Chat yet)</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {drafts.map((d) => (
              <a key={d.id} href={`#/build/${d.id}`} className="flex items-center gap-3 rounded-xl border border-dashed border-line bg-panel px-4 py-3 hover:border-brand">
                <Pencil size={16} className="text-muted" />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{d.name}</span><span className="block text-xs text-muted">{d.model} · edited {ago(d.updatedAt)}</span></span>
                <ArrowRight size={15} className="text-muted" />
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((a) => (
          <Card key={a.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{a.name}</h2>
                <p className="mt-1 text-sm text-muted">{a.description}</p>
              </div>
              {a.kind === "custom"
                ? <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand/10 px-2 py-1 text-[11px] font-medium text-brand"><Sparkles size={12} />v{a.version}{pending.has(a.id) ? " · draft changes" : ""}</span>
                : <span className="rounded-lg bg-panel-2 px-2 py-1 font-mono text-[11px] text-muted">built-in</span>}
            </div>
            {a.model && <p className="mt-2 font-mono text-xs text-muted">{a.model}</p>}

            <div className="mt-5 space-y-4 text-sm">
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><Wrench size={13} /> Tools</h3>
                {a.tools.length === 0 ? <p className="text-muted">None, answers from its instructions and documents only.</p> : (
                  <ul className="space-y-1.5">
                    {a.tools.map((t) => (
                      <li key={t.name} className="flex flex-wrap items-center gap-2">
                        <code className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[12px]">{t.name}</code>
                        <span className="text-muted">{t.description}</span>
                        {t.approval && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/14 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300"><Hand size={12} />{t.approval}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><ShieldCheck size={13} /> Protections</h3>
                <div className="flex flex-wrap gap-1.5">
                  {a.guardrails.map((g) => <span key={g} className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-800 dark:text-emerald-300">{g}</span>)}
                  <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-muted">≤ {a.limits.maxSteps} steps · ≤ {a.limits.maxToolCalls} tool calls</span>
                </div>
              </section>
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <a href={`#/chat/${a.id}`} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3.5 py-2 text-sm font-medium text-brand-ink hover:opacity-90">
                Open chat <ArrowRight size={15} />
              </a>
              {editable.has(a.id) && (
                <a href={`#/build/${a.id}`} className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 ring-inset ring-line hover:bg-panel-2">
                  <Pencil size={15} /> Edit
                </a>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
