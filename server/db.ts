import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, AgentState, EventSink } from "@agent-farmework/core";
import { SqliteRunStateStore, openSqlite, type SqliteDatabase } from "@agent-farmework/production";
import type { AuditSink, ToolAuditRecord } from "@agent-farmework/tools";
import type { AgentSpec } from "./spec.js";

/** One SQLite file holds run state (framework store), events and the tool audit log. */
export async function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = await openSqlite(path);
  const runs = new SqliteRunStateStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, event TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_run_idx ON events (run_id, sequence);
    CREATE TABLE IF NOT EXISTS audit (
      audit_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, recorded_at TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_run_idx ON audit (run_id, recorded_at);
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, draft TEXT NOT NULL, current_version INTEGER, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_versions (
      agent_id TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, PRIMARY KEY (agent_id, version));
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_agent_idx ON knowledge_docs (agent_id, created_at);
  `);
  return { db, runs, events: new EventLog(db), audit: new SqliteAuditSink(db), queries: new RunQueries(db), agents: new AgentStore(db) };
}

export interface AgentRow {
  id: string;
  draft: AgentSpec;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface VersionRow { version: number; spec: AgentSpec; note: string; createdAt: string }
export interface KnowledgeDoc { id: string; title: string; text: string; bytes: number; createdAt: string }

/** Agents built in the browser: a draft, immutable published versions, and knowledge documents. */
export class AgentStore {
  constructor(private readonly db: SqliteDatabase) {}

  private row(r: Record<string, unknown>): AgentRow {
    return { id: String(r.id), draft: JSON.parse(String(r.draft)) as AgentSpec, currentVersion: r.current_version === null ? null : Number(r.current_version), createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
  }
  list(): AgentRow[] {
    return (this.db.prepare("SELECT * FROM agents WHERE archived = 0 ORDER BY created_at").all() as Record<string, unknown>[]).map((r) => this.row(r));
  }
  get(id: string): AgentRow | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ? AND archived = 0").get(id) as Record<string, unknown> | undefined;
    return r === undefined ? undefined : this.row(r);
  }
  create(id: string, draft: AgentSpec): AgentRow {
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO agents (id, draft, current_version, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)").run(id, JSON.stringify(draft), now, now);
    return this.get(id) as AgentRow;
  }
  saveDraft(id: string, draft: AgentSpec): void {
    this.db.prepare("UPDATE agents SET draft = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(draft), new Date().toISOString(), id);
  }
  /** Publishing freezes the current draft as the next version and makes it live. */
  publish(id: string, note: string): number {
    const row = this.get(id);
    if (row === undefined) throw new Error("agent not found");
    const last = this.db.prepare("SELECT MAX(version) AS v FROM agent_versions WHERE agent_id = ?").get(id) as { v: number | null };
    const version = (last.v ?? 0) + 1;
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO agent_versions (agent_id, version, spec, note, created_at) VALUES (?, ?, ?, ?, ?)").run(id, version, JSON.stringify(row.draft), note, now);
    this.db.prepare("UPDATE agents SET current_version = ?, updated_at = ? WHERE id = ?").run(version, now, id);
    return version;
  }
  /** Rolling back makes an older version live again and loads it into the draft. */
  rollback(id: string, version: number): void {
    const v = this.version(id, version);
    if (v === undefined) throw new Error("version not found");
    this.db.prepare("UPDATE agents SET current_version = ?, draft = ?, updated_at = ? WHERE id = ?").run(version, JSON.stringify(v.spec), new Date().toISOString(), id);
  }
  archive(id: string): void {
    this.db.prepare("UPDATE agents SET archived = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }
  versions(id: string): VersionRow[] {
    return (this.db.prepare("SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC").all(id) as Record<string, unknown>[]).map((r) => ({
      version: Number(r.version), spec: JSON.parse(String(r.spec)) as AgentSpec, note: String(r.note), createdAt: String(r.created_at),
    }));
  }
  version(id: string, version: number): VersionRow | undefined {
    return this.versions(id).find((v) => v.version === version);
  }
  docs(agentId: string): KnowledgeDoc[] {
    return (this.db.prepare("SELECT id, title, text, bytes, created_at FROM knowledge_docs WHERE agent_id = ? ORDER BY created_at").all(agentId) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), title: String(r.title), text: String(r.text), bytes: Number(r.bytes), createdAt: String(r.created_at),
    }));
  }
  addDoc(agentId: string, doc: { id: string; title: string; text: string }): void {
    this.db.prepare("INSERT INTO knowledge_docs (id, agent_id, title, text, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(doc.id, agentId, doc.title, doc.text, Buffer.byteLength(doc.text), new Date().toISOString());
  }
  removeDoc(agentId: string, docId: string): boolean {
    const r = this.db.prepare("DELETE FROM knowledge_docs WHERE agent_id = ? AND id = ?").run(agentId, docId) as { changes?: number | bigint };
    return Number(r.changes ?? 0) > 0;
  }
  /** Changes whenever documents change; used to rebuild knowledge bases only when needed. */
  docsRevision(agentId: string): string {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(created_at), '') AS m FROM knowledge_docs WHERE agent_id = ?").get(agentId) as { n: number; m: string };
    return `${r.n}:${r.m}`;
  }
}

type Listener = (event: AgentEvent) => void;

/** Persists every runtime event and fans it out to live subscribers (SSE). */
export class EventLog implements EventSink {
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor(private readonly db: SqliteDatabase) {}

  emit(event: AgentEvent): void {
    this.db
      .prepare("INSERT OR IGNORE INTO events (event_id, run_id, sequence, type, event) VALUES (?, ?, ?, ?, ?)")
      .run(event.eventId, event.runId, event.sequence, event.type, JSON.stringify(event));
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  forRun(runId: string, afterSequence = 0): AgentEvent[] {
    const rows = this.db.prepare("SELECT event FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence").all(runId, afterSequence) as { event: string }[];
    return rows.map((r) => JSON.parse(r.event) as AgentEvent);
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }
}

export class SqliteAuditSink implements AuditSink {
  constructor(private readonly db: SqliteDatabase) {}
  record(entry: ToolAuditRecord): void {
    this.db.prepare("INSERT OR IGNORE INTO audit (audit_id, run_id, recorded_at, record) VALUES (?, ?, ?, ?)").run(entry.auditId, entry.runId, entry.recordedAt, JSON.stringify(entry));
  }
  forRun(runId: string): ToolAuditRecord[] {
    const rows = this.db.prepare("SELECT record FROM audit WHERE run_id = ? ORDER BY recorded_at").all(runId) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as ToolAuditRecord);
  }
}

/** Read models over the framework's `agent_runs` table. */
export class RunQueries {
  constructor(private readonly db: SqliteDatabase) {}
  list(limit = 100): AgentState[] {
    const rows = this.db.prepare("SELECT state FROM agent_runs ORDER BY created_at DESC LIMIT ?").all(limit) as { state: string }[];
    return rows.map((r) => JSON.parse(r.state) as AgentState);
  }
  waiting(): AgentState[] {
    const rows = this.db.prepare("SELECT state FROM agent_runs WHERE status = 'WAITING_FOR_APPROVAL' ORDER BY updated_at").all() as { state: string }[];
    return rows.map((r) => JSON.parse(r.state) as AgentState);
  }
}

export type Database = Awaited<ReturnType<typeof openDatabase>>;
