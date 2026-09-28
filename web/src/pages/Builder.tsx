import { ArrowLeft, BookOpen, Brain, Check, FileUp, History, Loader2, Plus, Rocket, RotateCcw, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError, api, del, post, put, upload, type Integrations, type StoreActor, type AgentSpec, type Approval, type BuilderAgent, type CatalogItem, type Issue, type ProviderInfo, type ToolSpec } from "../api";
import { Button, Card, ago, cx } from "../ui";
import { Conversation } from "./Chat";

// ------------------------------------------------------------------ small form kit

const inputCls = "w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 aria-[invalid=true]:border-rose-500";

function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; id?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      {children}
      {error ? <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const hintId = useId();
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-describedby={hint ? hintId : undefined} onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition", checked ? "bg-brand" : "bg-line")}>
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      <span className="text-sm"><span className="font-medium">{label}</span>{hint && <span id={hintId} className="block text-xs text-muted">{hint}</span>}</span>
    </label>
  );
}

function Section({ icon, title, subtitle, children }: { icon: ReactNode; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold"><span className="text-brand">{icon}</span>{title}</h2>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </Card>
  );
}

const num = (v: string, fallback: number) => (v.trim() === "" || Number.isNaN(Number(v)) ? fallback : Number(v));

/** Models found by Settings → Test, plus "Other" for typing any id. */
function ModelPicker({ value, models, placeholder, onChange }: { value: string; models: { id: string; label: string }[]; placeholder?: string; onChange: (id: string) => void }) {
  const known = models.some((m) => m.id === value);
  const [other, setOther] = useState(!known && value !== "");
  return (
    <div className="space-y-2">
      <select id="f-model" className={inputCls} value={other ? "__other" : value}
        onChange={(e) => { if (e.target.value === "__other") { setOther(true); } else { setOther(false); onChange(e.target.value); } }}>
        {!known && !other && <option value={value}>{value ? `${value} (not in your list)` : "Choose a model"}</option>}
        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        <option value="__other">Other (type a model id)…</option>
      </select>
      {other && <input aria-label="Model id" className={cx(inputCls, "font-mono")} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
      {value && !known && <p className="text-xs text-amber-700 dark:text-amber-300">This model was not in the list your key returned; it may not work.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ tools

function toolTitle(t: ToolSpec, catalog: CatalogItem[]) {
  return t.type === "http" ? t.name || "Web API call" : t.type === "apify_actor" ? t.name || "Apify actor" : (catalog.find((c) => c.type === t.type)?.label ?? t.type);
}
const fieldsFor = (t: ToolSpec) => (t.type === "http" || t.type === "apify_actor" ? t.params : t.type === "demo_refund" ? ["amount"] : []);

function ApprovalEditor({ tool, onChange, err }: { tool: ToolSpec; onChange: (a: Approval) => void; err: (p: string) => string | undefined }) {
  const fields = fieldsFor(tool);
  const a = tool.approval;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">Needs approval:</span>
      <select aria-label="Approval rule" className={cx(inputCls, "w-auto")} value={a.mode}
        onChange={(e) => {
          const mode = e.target.value as Approval["mode"];
          onChange(mode === "threshold" ? { mode, field: fields[0] ?? "", over: 100 } : { mode });
        }}>
        <option value="never">Never</option>
        <option value="always">Always</option>
        {fields.length > 0 && <option value="threshold">When a value is over…</option>}
      </select>
      {a.mode === "threshold" && (
        <>
          <select aria-label="Field" className={cx(inputCls, "w-auto")} value={a.field} onChange={(e) => onChange({ ...a, field: e.target.value })}>
            {fields.map((f) => <option key={f}>{f}</option>)}
          </select>
          <span className="text-muted">over</span>
          <input aria-label="Threshold" type="number" className={cx(inputCls, "w-28")} value={a.over} onChange={(e) => onChange({ ...a, over: num(e.target.value, 0) })} />
        </>
      )}
      {err("approval.field") && <span className="w-full text-xs text-rose-600 dark:text-rose-300">{err("approval.field")}</span>}
    </div>
  );
}

function ToolCard({ tool, index, catalog, onChange, onRemove, err }: { tool: ToolSpec; index: number; catalog: CatalogItem[]; onChange: (t: ToolSpec) => void; onRemove: () => void; err: (p: string) => string | undefined }) {
  const e = (p: string) => err(`tools.${index}.${p}`);
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{toolTitle(tool, catalog)}</p>
          <p className="text-xs text-muted">{catalog.find((c) => c.type === tool.type)?.description}</p>
        </div>
        <button onClick={onRemove} aria-label="Remove tool" className="rounded-lg p-1.5 text-muted hover:bg-rose-500/10 hover:text-rose-600"><Trash2 size={16} /></button>
      </div>
      {tool.type === "http" && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Tool name" id={`t${index}-name`} error={e("name")} hint="What the model calls it, e.g. get_weather">
            <input id={`t${index}-name`} className={inputCls} value={tool.name} aria-invalid={Boolean(e("name"))} onChange={(ev) => onChange({ ...tool, name: ev.target.value })} />
          </Field>
          <Field label="Method" id={`t${index}-method`}>
            <select id={`t${index}-method`} className={inputCls} value={tool.method} onChange={(ev) => onChange({ ...tool, method: ev.target.value as "GET" | "POST" })}>
              <option>GET</option><option>POST</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="What it does" id={`t${index}-desc`} error={e("description")} hint="The model reads this to decide when to use the tool.">
              <input id={`t${index}-desc`} className={inputCls} value={tool.description} aria-invalid={Boolean(e("description"))} onChange={(ev) => onChange({ ...tool, description: ev.target.value })} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="URL" id={`t${index}-url`} error={e("url")} hint={<>HTTPS only. Put inputs in braces: <code>https://api.example.com/orders/{"{id}"}</code>. Only this host can be reached.</>}>
              <input id={`t${index}-url`} className={cx(inputCls, "font-mono")} value={tool.url} aria-invalid={Boolean(e("url"))} placeholder="https://" onChange={(ev) => onChange({ ...tool, url: ev.target.value })} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Inputs the model fills in" id={`t${index}-params`} error={e("params")} hint="Comma separated, e.g. id, city">
              <input id={`t${index}-params`} className={cx(inputCls, "font-mono")} value={tool.params.join(", ")}
                onChange={(ev) => onChange({ ...tool, params: ev.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </Field>
          </div>
        </div>
      )}
      {tool.type === "apify_actor" && <ApifyFields tool={tool} index={index} onChange={onChange} e={e} />}
      <div className="mt-3 border-t border-line pt-3"><ApprovalEditor tool={tool} err={e} onChange={(approval) => onChange({ ...tool, approval })} /></div>
    </div>
  );
}

function ApifyFields({ tool, index, onChange, e }: { tool: Extract<ToolSpec, { type: "apify_actor" }>; index: number; onChange: (t: ToolSpec) => void; e: (p: string) => string | undefined }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StoreActor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const search = async () => {
    setBusy(true); setError(null);
    try { setFound((await api<{ actors: StoreActor[] }>(`/api/builder/apify/search?q=${encodeURIComponent(q)}`)).actors); } catch (err) { setError(err instanceof Error ? err.message : "Search failed."); } finally { setBusy(false); }
  };
  const id = (f: string) => `t${index}-${f}`;
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2">
        <label htmlFor={id("find")} className="block text-sm font-medium">Find an actor in the Apify Store</label>
        <div className="flex gap-2">
          <input id={id("find")} className={inputCls} value={q} placeholder="e.g. google search, instagram, website content" onChange={(ev) => setQ(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); void search(); } }} />
          <Button variant="ghost" disabled={busy || q.trim().length < 2} onClick={() => void search()}>{busy ? <Loader2 size={15} className="animate-spin" /> : null}Search</Button>
        </div>
        {error && <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p>}
        {found && (
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line scroll-thin">
            {found.length === 0 && <li className="px-3 py-2 text-sm text-muted">No actors found.</li>}
            {found.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => { onChange({ ...tool, actorId: a.id, name: tool.name || a.id.split("/")[1]!.replace(/[^a-z0-9]+/gi, "_").toLowerCase().replace(/^[^a-z]+/, "").slice(0, 40) || "apify_actor", description: tool.description || a.title }); setFound(null); }}
                  className={cx("w-full px-3 py-2 text-left hover:bg-panel-2", tool.actorId === a.id && "bg-brand/5")}>
                  <span className="block text-sm font-medium">{a.title} <span className="font-mono text-xs font-normal text-muted">{a.id}</span></span>
                  <span className="line-clamp-2 block text-xs text-muted">{a.description}</span>
                  <span className="block text-[11px] text-muted">{a.users ? `${a.users.toLocaleString()} users` : ""}{a.pricing ? ` · ${a.pricing.toLowerCase().replace(/_/g, " ")}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label="Actor" id={id("actor")} error={e("actorId")} hint={tool.actorId ? <a href={`https://apify.com/${tool.actorId.replace("~", "/")}`} target="_blank" rel="noreferrer" className="text-brand hover:underline">Open its page (input fields & price) ↗</a> : "username/actor-name"}>
        <input id={id("actor")} className={cx(inputCls, "font-mono")} value={tool.actorId} placeholder="apify/rag-web-browser" onChange={(ev) => onChange({ ...tool, actorId: ev.target.value })} />
      </Field>
      <Field label="Tool name" id={id("name")} error={e("name")} hint="What the model calls it, e.g. web_search">
        <input id={id("name")} className={inputCls} value={tool.name} onChange={(ev) => onChange({ ...tool, name: ev.target.value })} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="What it does" id={id("desc")} error={e("description")} hint="The model reads this to decide when to use it.">
          <input id={id("desc")} className={inputCls} value={tool.description} onChange={(ev) => onChange({ ...tool, description: ev.target.value })} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Actor input (JSON)" id={id("input")} error={e("input")} hint={<>Put what the model fills in as <code>{"{{name}}"}</code> inside quotes, e.g. <code>{'{"query": "{{query}}", "maxResults": 3}'}</code>.</>}>
          <textarea id={id("input")} className={cx(inputCls, "min-h-24 font-mono text-xs")} value={tool.input} onChange={(ev) => onChange({ ...tool, input: ev.target.value })} />
        </Field>
      </div>
      <Field label="Inputs the model fills in" id={id("params")} error={e("params")} hint="Comma separated, e.g. query">
        <input id={id("params")} className={cx(inputCls, "font-mono")} value={tool.params.join(", ")} onChange={(ev) => onChange({ ...tool, params: ev.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Max results" id={id("max")}><input id={id("max")} type="number" min={1} max={100} className={inputCls} value={tool.maxItems} onChange={(ev) => onChange({ ...tool, maxItems: num(ev.target.value, 10) })} /></Field>
        <Field label="Timeout (s)" id={id("to")}><input id={id("to")} type="number" min={10} max={110} className={inputCls} value={tool.timeoutSecs} onChange={(ev) => onChange({ ...tool, timeoutSecs: num(ev.target.value, 60) })} /></Field>
      </div>
    </div>
  );
}

function newTool(type: ToolSpec["type"]): ToolSpec {
  if (type === "apify_actor") return { type, name: "", description: "", actorId: "", input: '{"query": "{{query}}"}', params: ["query"], maxItems: 10, timeoutSecs: 60, approval: { mode: "always" } };
  if (type === "http") return { type, name: "", description: "", method: "GET", url: "https://", params: [], approval: { mode: "never" } };
  if (type === "demo_refund") return { type, approval: { mode: "threshold", field: "amount", over: 100 } };
  return { type, approval: { mode: "never" } };
}

// ------------------------------------------------------------------ knowledge

function Knowledge({ agent, spec, set, onAgent }: { agent: BuilderAgent; spec: AgentSpec; set: (s: AgentSpec) => void; onAgent: (a: BuilderAgent) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<BuilderAgent>) => {
    setBusy(true); setError(null);
    try { onAgent(await fn()); return true; } catch (e) { setError(e instanceof Error ? e.message : "Failed"); return false; } finally { setBusy(false); }
  };
  const hasSearch = spec.tools.some((t) => t.type === "knowledge_search");
  return (
    <Section icon={<BookOpen size={18} />} title="Knowledge" subtitle="Documents the agent answers from, with citations. Changes apply to every version right away.">
      <Toggle checked={spec.knowledge.enabled} label="Answer from these documents"
        hint="The best passages are added to each question automatically."
        onChange={(enabled) => set({ ...spec, knowledge: { ...spec.knowledge, enabled }, tools: enabled ? spec.tools : spec.tools.filter((t) => t.type !== "knowledge_search") })} />
      {spec.knowledge.enabled && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <Field label="Passages per question" id="kb-k">
              <input id="kb-k" type="number" min={1} max={8} className={cx(inputCls, "w-24")} value={spec.knowledge.k} onChange={(e) => set({ ...spec, knowledge: { ...spec.knowledge, k: num(e.target.value, 3) } })} />
            </Field>
            <Toggle checked={hasSearch} label="Let the agent search more" hint="Adds the Search knowledge tool."
              onChange={(on) => set({ ...spec, tools: on ? [...spec.tools, newTool("knowledge_search")] : spec.tools.filter((t) => t.type !== "knowledge_search") })} />
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {agent.docs.length === 0 && <li className="px-4 py-3 text-sm text-muted">No documents yet.</li>}
            {agent.docs.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <BookOpen size={15} className="text-muted" />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <span className="text-xs text-muted tabular-nums">{(d.bytes / 1024).toFixed(1)} KB</span>
                <button aria-label={`Remove ${d.title}`} disabled={busy} onClick={() => void run(() => del(`/api/builder/agents/${agent.id}/knowledge/${d.id}`))} className="rounded-lg p-1 text-muted hover:text-rose-600"><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={file} type="file" accept=".pdf,.txt,.md,.markdown,.html,.htm,.csv,.json" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const form = new FormData();
                form.append("file", f);
                void run(() => upload(`/api/builder/agents/${agent.id}/knowledge`, form)).finally(() => { if (file.current) file.current.value = ""; });
              }} />
            <Button variant="ghost" disabled={busy} onClick={() => file.current?.click()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <FileUp size={15} />}Upload file</Button>
            <span className="text-xs text-muted">PDF, TXT, Markdown, HTML, CSV or JSON · up to 5 MB</span>
          </div>
          <details className="rounded-xl border border-line px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium">Paste text instead</summary>
            <div className="mt-3 space-y-2">
              <input aria-label="Document title" className={inputCls} placeholder="Title, e.g. Refund policy" value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea aria-label="Document text" className={cx(inputCls, "min-h-28")} placeholder="Paste the text here" value={text} onChange={(e) => setText(e.target.value)} />
              <Button variant="ghost" disabled={busy || !title.trim() || !text.trim()}
                onClick={() => void run(() => post(`/api/builder/agents/${agent.id}/knowledge`, { title, text })).then((ok) => { if (ok) { setTitle(""); setText(""); } })}>
                <Plus size={15} />Add document
              </Button>
            </div>
          </details>
          {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-300">{error}</p>}
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ page

export function BuilderPage({ id, onPublished }: { id: string; onPublished: () => void }) {
  const [agent, setAgent] = useState<BuilderAgent | null>(null);
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [models, setModels] = useState<ProviderInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [save, setSave] = useState<"saved" | "saving" | "dirty" | "invalid">("saved");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [testKey, setTestKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apifyReady, setApifyReady] = useState<boolean | null>(null);
  useEffect(() => { api<Integrations>("/api/settings/integrations").then((i) => setApifyReady(i.apify.configured)).catch(() => {}); }, []);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    Promise.all([api<BuilderAgent>(`/api/builder/agents/${id}`), api<ProviderInfo[]>("/api/builder/models"), api<CatalogItem[]>("/api/builder/catalog")])
      .then(([a, m, c]) => { setAgent(a); setSpec(a.draft); setModels(m); setCatalog(c); })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load the agent."));
  }, [id]);

  const persist = useCallback(async (s: AgentSpec) => {
    setSave("saving");
    try {
      const a = await put<BuilderAgent>(`/api/builder/agents/${id}`, { spec: { ...s, examples: s.examples.map((x) => x.trim()).filter(Boolean) } });
      setAgent(a); setIssues([]); setSave("saved");
      return true;
    } catch (e) {
      setIssues(e instanceof ApiError ? e.issues : []);
      setSave("invalid");
      return false;
    }
  }, [id]);

  const set = (s: AgentSpec) => {
    setSpec(s);
    setSave("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(s), 700);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const err = (path: string) => issues.find((i) => i.path === path)?.message;

  if (loadError) return <div className="p-8 text-sm text-rose-600">{loadError} <a className="text-brand underline" href="#/agents">Back to agents</a></div>;
  if (!agent || !spec) return <div className="grid h-full place-items-center text-muted"><Loader2 className="animate-spin" /></div>;

  const provider = models.find((m) => m.id === spec.model.providerId);
  const live = agent.versions.find((v) => v.version === agent.currentVersion);

  const publish = async () => {
    clearTimeout(timer.current);
    if (!(await persist(spec))) return setMessage({ ok: false, text: "Fix the highlighted fields first." });
    try {
      const a = await post<BuilderAgent & { published: number }>(`/api/builder/agents/${id}/publish`, { note });
      setAgent(a); setNote(""); onPublished();
      setMessage({ ok: true, text: `Published version ${a.published}. It is now in Chat.` });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Publish failed." });
    }
  };
  const rollback = async (version: number) => {
    if (!window.confirm(`Make version ${version} live again? Your current draft will be replaced by it.`)) return;
    clearTimeout(timer.current);
    const a = await post<BuilderAgent>(`/api/builder/agents/${id}/rollback`, { version });
    setAgent(a); setSpec(a.draft); setIssues([]); setSave("saved"); onPublished(); setTestKey((k) => k + 1);
    setMessage({ ok: true, text: `Version ${version} is live again.` });
  };
  const archive = async () => {
    if (!window.confirm(`Delete "${spec.name}"? It disappears from Chat. Past runs stay in history.`)) return;
    await del(`/api/builder/agents/${id}`);
    onPublished();
    window.location.hash = "#/agents";
  };

  const saveLabel = { saved: "Draft saved", saving: "Saving…", dirty: "Unsaved changes", invalid: "Fix the highlighted fields" }[save];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <a href="#/agents" className="rounded-lg p-1.5 text-muted hover:bg-panel-2 hover:text-ink" aria-label="Back to agents"><ArrowLeft size={18} /></a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{spec.name || "Untitled agent"}</h1>
          <p className="text-sm text-muted">
            {agent.currentVersion === null ? "Draft · not published yet" : `Live: version ${agent.currentVersion}`}
            <span className={cx("ml-3 inline-flex items-center gap-1", save === "invalid" ? "text-rose-600 dark:text-rose-300" : "")}>
              {save === "saving" ? <Loader2 size={13} className="animate-spin" /> : save === "saved" ? <Check size={13} /> : null}{saveLabel}
            </span>
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <Section icon={<Brain size={18} />} title="Basics" subtitle="Who the agent is and how it should behave.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" id="f-name" error={err("name")}>
                <input id="f-name" className={inputCls} value={spec.name} aria-invalid={Boolean(err("name"))} onChange={(e) => set({ ...spec, name: e.target.value })} />
              </Field>
              <Field label="Short description" id="f-desc" error={err("description")} hint="Shown on the agent card.">
                <input id="f-desc" className={inputCls} value={spec.description} onChange={(e) => set({ ...spec, description: e.target.value })} />
              </Field>
            </div>
            <Field label="Instructions" id="f-instr" error={err("instructions")} hint="Its job, tone, what to do and what never to do. The model follows these on every message.">
              <textarea id="f-instr" className={cx(inputCls, "min-h-40 leading-relaxed")} value={spec.instructions} aria-invalid={Boolean(err("instructions"))} onChange={(e) => set({ ...spec, instructions: e.target.value })} />
            </Field>
            <Field label="Example questions" id="f-ex" hint="One per line (up to 6). Shown as quick buttons in Chat." error={err("examples")}>
              <textarea id="f-ex" className={cx(inputCls, "min-h-20")} value={spec.examples.join("\n")}
                onChange={(e) => set({ ...spec, examples: e.target.value.split("\n").map((s) => s.trimStart()).filter((s, i, all) => s !== "" || i === all.length - 1).slice(0, 6) })} />
            </Field>
          </Section>

          <Section icon={<Brain size={18} />} title="Model" subtitle="Which AI model thinks for this agent. Connect providers and keys in Settings.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider" id="f-prov" hint={<a href="#/settings" className="text-brand hover:underline">Manage providers & keys →</a>}>
                <select id="f-prov" className={inputCls} value={spec.model.providerId}
                  onChange={(e) => {
                    const p = models.find((m) => m.id === e.target.value);
                    set({ ...spec, model: { providerId: e.target.value, modelId: p?.models[0]?.id ?? (e.target.value === spec.model.providerId ? spec.model.modelId : "") } });
                  }}>
                  <optgroup label="Connected">{models.filter((m) => m.configured).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
                  <optgroup label="Not connected yet">{models.filter((m) => !m.configured).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
                </select>
              </Field>
              <Field label="Model" id="f-model" error={err("model.modelId")}>
                {provider?.customModel && provider.models.length > 0 ? (
                  <ModelPicker value={spec.model.modelId} models={provider.models} placeholder={provider.modelPlaceholder} onChange={(modelId) => set({ ...spec, model: { ...spec.model, modelId } })} />
                ) : provider?.customModel ? (
                  <input id="f-model" className={cx(inputCls, "font-mono")} value={spec.model.modelId} placeholder={provider.modelPlaceholder} onChange={(e) => set({ ...spec, model: { ...spec.model, modelId: e.target.value } })} />                ) : (
                  <select id="f-model" className={inputCls} value={spec.model.modelId} onChange={(e) => set({ ...spec, model: { ...spec.model, modelId: e.target.value } })}>
                    {provider?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                )}
              </Field>
            </div>
            {provider && !provider.configured && <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">{provider.label} is not connected yet. You can keep editing; to test and publish, <a href="#/settings" className="font-medium underline">add its key in Settings</a>.</p>}
          </Section>

          <Section icon={<Wrench size={18} />} title="Tools" subtitle="What the agent can do. It can use nothing else. Add approval rules for anything risky.">
            {err("tools") && <p className="text-sm text-rose-600 dark:text-rose-300">{err("tools")}</p>}
            {apifyReady === false && spec.tools.some((t) => t.type === "apify_actor") && (
              <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">Apify actors need your Apify token. <a href="#/settings" className="font-medium underline">Add it in Settings → Integrations</a>.</p>
            )}
            {spec.tools.map((t, i) => t.type === "knowledge_search" ? null : (
              <ToolCard key={i} tool={t} index={i} catalog={catalog} err={err}
                onChange={(nt) => set({ ...spec, tools: spec.tools.map((x, j) => (j === i ? nt : x)) })}
                onRemove={() => set({ ...spec, tools: spec.tools.filter((_, j) => j !== i) })} />
            ))}
            <div className="flex flex-wrap gap-2">
              {catalog.filter((c) => c.type !== "knowledge_search" && (c.configurable || !spec.tools.some((t) => t.type === c.type))).map((c) => (
                <Button key={c.type} variant="ghost" disabled={spec.tools.length >= 12} onClick={() => set({ ...spec, tools: [...spec.tools, newTool(c.type)] })}><Plus size={15} />{c.label}</Button>
              ))}
            </div>
          </Section>

          <Knowledge agent={agent} spec={spec} set={set} onAgent={setAgent} />
          {err("knowledge") && <p className="-mt-3 text-sm text-rose-600 dark:text-rose-300">{err("knowledge")}</p>}

          <Section icon={<ShieldCheck size={18} />} title="Safety & limits" subtitle="Hard stops the agent cannot talk its way around.">
            <Toggle checked={spec.guardrails.pii} label="Redact personal data" hint="Emails, phone and card numbers are masked before reaching the model." onChange={(pii) => set({ ...spec, guardrails: { ...spec.guardrails, pii } })} />
            <Toggle checked={spec.guardrails.injection} label="Block prompt injection" hint={`Stops messages like "ignore your instructions".`} onChange={(injection) => set({ ...spec, guardrails: { ...spec.guardrails, injection } })} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Max steps" id="l-steps" error={err("limits.maxSteps")}><input id="l-steps" type="number" min={1} max={30} className={inputCls} value={spec.limits.maxSteps} onChange={(e) => set({ ...spec, limits: { ...spec.limits, maxSteps: num(e.target.value, 8) } })} /></Field>
              <Field label="Max tool calls" id="l-tools" error={err("limits.maxToolCalls")}><input id="l-tools" type="number" min={1} max={30} className={inputCls} value={spec.limits.maxToolCalls} onChange={(e) => set({ ...spec, limits: { ...spec.limits, maxToolCalls: num(e.target.value, 6) } })} /></Field>
              <Field label="Max cost per run ($)" id="l-cost" error={err("limits.maxCost")}><input id="l-cost" type="number" min={0.01} max={10} step={0.05} className={inputCls} value={spec.limits.maxCost} onChange={(e) => set({ ...spec, limits: { ...spec.limits, maxCost: num(e.target.value, 0.25) } })} /></Field>
            </div>
          </Section>

          <div className="flex justify-end"><Button variant="danger" onClick={() => void archive()}><Trash2 size={15} />Delete agent</Button></div>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-semibold"><Rocket size={18} className="text-brand" />Publish</h2>
            <p className="mt-1 text-sm text-muted">{live ? `Chat uses version ${live.version}${live.note ? ` · “${live.note}”` : ""}.` : "Publish to make this agent available in Chat."}</p>
            <div className="mt-3 flex gap-2">
              <input aria-label="Version note" className={inputCls} placeholder="What changed? (optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
              <Button onClick={() => void publish()} disabled={save === "saving"}>Publish</Button>
            </div>
            {message && <p role="status" className={cx("mt-2 text-sm", message.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300")}>{message.text}</p>}
            {agent.versions.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted"><History size={13} />Versions</h3>
                <ol className="max-h-56 space-y-1 overflow-y-auto scroll-thin">
                  {agent.versions.map((v) => (
                    <li key={v.version} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2">
                      <span className="font-mono text-xs font-semibold">v{v.version}</span>
                      <span className="min-w-0 flex-1 truncate text-muted">{v.note || v.name} · {ago(v.createdAt)}</span>
                      {v.version === agent.currentVersion
                        ? <span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">live</span>
                        : <button onClick={() => void rollback(v.version)} className="inline-flex items-center gap-1 text-xs text-brand hover:underline"><RotateCcw size={12} />Roll back</button>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {agent.currentVersion !== null && <a href={`#/chat/${agent.id}`} className="mt-3 inline-block text-sm text-brand hover:underline">Open in Chat →</a>}
          </Card>

          <Card className="flex h-[560px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h2 className="font-semibold">Test chat</h2>
                <p className="text-xs text-muted">Talks to the saved draft · runs show as “(test)”</p>
              </div>
              <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setTestKey((k) => k + 1)}>Clear</Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col text-sm">
              <Conversation key={testKey} agent={{ id: agent.id, name: spec.name, examples: spec.examples }} draft onChange={() => {}} />
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
