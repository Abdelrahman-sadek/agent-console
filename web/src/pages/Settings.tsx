import { CheckCircle2, ChevronDown, ExternalLink, KeyRound, Loader2, Plug, Plus, Server, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, del, post, put, type ProviderInfo } from "../api";
import { Button, Card, cx } from "../ui";

const inputCls = "w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

type Result = { ok: boolean; message: string } | null;

function Status({ p }: { p: ProviderInfo }) {
  if (!p.configured) return <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-muted">Not connected</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 size={12} />Connected{p.keyHint ? ` · key ${p.keyHint}` : ""}{p.source === "server" ? " · server" : ""}
    </span>
  );
}

function ProviderRow({ p, onChange }: { p: ProviderInfo; onChange: (list: ProviderInfo[]) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(p.source === "console" && p.baseURL !== p.defaultBaseURL ? (p.baseURL ?? "") : "");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [result, setResult] = useState<Result>(null);
  const showUrl = p.needsBaseURL || p.custom;

  const act = async (kind: "save" | "test" | "remove") => {
    setBusy(kind); setResult(null);
    try {
      if (kind === "save") {
        const body: Record<string, string> = {};
        if (key.trim()) body.apiKey = key.trim();
        if (showUrl || url.trim()) body.baseURL = url.trim();
        const r = await put<{ providers: ProviderInfo[] }>(`/api/settings/providers/${p.id}`, body);
        onChange(r.providers); setKey("");
        // Check straight away so a typo shows up here, not in a chat.
        const t = await post<{ ok: boolean; message: string }>(`/api/settings/providers/${p.id}/test`, {});
        setResult(t);
        onChange((await api<{ providers: ProviderInfo[] }>("/api/settings/providers")).providers);
      } else if (kind === "test") {
        setResult(await post<{ ok: boolean; message: string }>(`/api/settings/providers/${p.id}/test`, {}));
        onChange((await api<{ providers: ProviderInfo[] }>("/api/settings/providers")).providers);
      } else {
        if (!window.confirm(p.custom ? `Remove ${p.label}? Agents using it stop working until you pick another model.` : `Forget the key saved for ${p.label}?`)) return;
        onChange((await del<{ providers: ProviderInfo[] }>(`/api/settings/providers/${p.id}`)).providers);
        setUrl("");
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Failed." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="px-5 py-4">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 text-left">
        <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-xl", p.configured ? "bg-brand/10 text-brand" : "bg-panel-2 text-muted")}>{p.custom ? <Server size={17} /> : <Plug size={17} />}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{p.label}</span>
          <span className="block truncate text-xs text-muted">{p.baseURL ?? (p.needsBaseURL ? "Needs a server URL" : "")}</span>
        </span>
        <Status p={p} />
        <ChevronDown size={16} className={cx("text-muted transition", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mt-4 space-y-3 pl-12">
          {p.source === "server" && <p className="text-xs text-muted">Set on the server. Anything you save here takes priority.</p>}
          {(p.needsKey || p.custom || p.id === "ollama") && (
            <div className="space-y-1.5">
              <label htmlFor={`key-${p.id}`} className="flex items-center justify-between text-sm font-medium">
                API key{!p.needsKey && <span className="font-normal text-muted"> (optional)</span>}
                {p.keyUrl && <a href={p.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-normal text-brand hover:underline">Get a key <ExternalLink size={11} /></a>}
              </label>
              <input id={`key-${p.id}`} type="password" autoComplete="off" spellCheck={false} className={cx(inputCls, "font-mono")} value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={p.keyHint ? `Saved (${p.keyHint}). Paste a new key to replace it` : "Paste your API key"} />
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor={`url-${p.id}`} className="block text-sm font-medium">Base URL{!showUrl && <span className="font-normal text-muted"> (optional, for proxies)</span>}</label>
            <input id={`url-${p.id}`} className={cx(inputCls, "font-mono")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={p.defaultBaseURL ?? "http://host.docker.internal:11434/v1"} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void act("save")} disabled={busy !== null || (!key.trim() && !url.trim() && !showUrl)}>{busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}Save & test</Button>
            {p.configured && <Button variant="ghost" onClick={() => void act("test")} disabled={busy !== null}>{busy === "test" && <Loader2 size={15} className="animate-spin" />}Test</Button>}
            {(p.source === "console" || p.custom) && <Button variant="danger" onClick={() => void act("remove")} disabled={busy !== null}><Trash2 size={15} />{p.custom ? "Remove provider" : "Forget key"}</Button>}
          </div>
          {result && (
            <p role="status" className={cx("inline-flex items-center gap-1.5 text-sm", result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300")}>
              {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{result.message}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function AddCustom({ onAdded }: { onAdded: (list: ProviderInfo[]) => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const r = await post<{ id: string; providers: ProviderInfo[] }>("/api/settings/providers", { label, baseURL: url, ...(key.trim() ? { apiKey: key.trim() } : {}) });
      await post(`/api/settings/providers/${r.id}/test`, {}).catch(() => {});
      onAdded((await api<{ providers: ProviderInfo[] }>("/api/settings/providers")).providers);
      setLabel(""); setUrl(""); setKey(""); setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the provider.");
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}><Plus size={15} />Add a custom provider</Button>;
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="font-semibold">Custom OpenAI-compatible provider</h2>
        <p className="text-sm text-muted">Any server that speaks the OpenAI chat API: vLLM, LM Studio, LiteLLM, Azure gateways, Fireworks, Perplexity…</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input aria-label="Provider name" className={inputCls} placeholder="Name, e.g. Company vLLM" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input aria-label="Provider base URL" className={cx(inputCls, "font-mono")} placeholder="https://llm.example.com/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input aria-label="Provider API key" type="password" autoComplete="off" className={cx(inputCls, "font-mono sm:col-span-2")} placeholder="API key (optional)" value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-rose-600 dark:text-rose-300">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={() => void add()} disabled={busy || label.trim().length < 2 || !url.trim()}>{busy && <Loader2 size={15} className="animate-spin" />}Add provider</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </Card>
  );
}

export function SettingsPage({ onChange }: { onChange: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  useEffect(() => { api<{ providers: ProviderInfo[] }>("/api/settings/providers").then((r) => setProviders(r.providers)).catch(() => setProviders([])); }, []);
  const update = (list: ProviderInfo[]) => { setProviders(list); onChange(); };
  const connected = providers?.filter((p) => p.configured) ?? [];
  const others = providers?.filter((p) => !p.configured) ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Model providers</h1>
        {providers && <p className="mt-1 text-sm font-medium">{connected.length} connected · {others.length} available</p>}
        <p className="mt-1 text-sm text-muted">
          Connect the AI models your agents use. Keys are encrypted on the server and never shown again; only the last 4 characters are displayed.
          Changes apply immediately. The offline Demo model is always available.
        </p>
      </header>
      {providers === null ? <Loader2 className="animate-spin text-muted" /> : (
        <div className="space-y-6">
          {/* One list with stable keys, so a row keeps its message when it moves to "connected". */}
          <Card>
            <ul className="divide-y divide-line">
              {[...connected, ...others].map((p) => <ProviderRow key={p.id} p={p} onChange={update} />)}
            </ul>
          </Card>
          <AddCustom onAdded={update} />
          <p className="text-xs text-muted">Tip: OpenRouter gives one key for Claude, GPT, Gemini, Llama and more, including some free models.</p>
        </div>
      )}
    </div>
  );
}
