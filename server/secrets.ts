import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SqliteDatabase } from "@agent-farmework/production";
import type { SavedProvider } from "./providers.js";

type ProviderSecret = SavedProvider;

/**
 * The master key that encrypts saved provider keys. `SECRETS_KEY` (32 bytes, base64) wins;
 * otherwise a random key is created once next to the database, readable by the server only.
 */
export function loadMasterKey(databasePath: string, env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  const fromEnv = env.SECRETS_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).");
    return key;
  }
  if (databasePath === ":memory:") return randomBytes(32);
  const file = join(dirname(databasePath), "secrets.key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
}

/** Provider keys saved from the browser, encrypted at rest (AES-256-GCM). Never returned to the browser. */
export class ProviderSecrets {
  constructor(private readonly db: SqliteDatabase, private readonly key: Buffer) {
    db.exec(`CREATE TABLE IF NOT EXISTS provider_secrets (
      provider_id TEXT PRIMARY KEY, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  private seal(value: ProviderSecret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private open(row: { iv: string; tag: string; data: string }): ProviderSecret | undefined {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.data, "base64")), decipher.final()]).toString("utf8")) as ProviderSecret;
    } catch {
      return undefined; // wrong master key or tampered row: treat as not saved
    }
  }

  all(): Record<string, ProviderSecret & { updatedAt: string }> {
    const rows = this.db.prepare("SELECT provider_id, iv, tag, data, updated_at FROM provider_secrets").all() as { provider_id: string; iv: string; tag: string; data: string; updated_at: string }[];
    const out: Record<string, ProviderSecret & { updatedAt: string }> = {};
    for (const r of rows) {
      const value = this.open(r);
      if (value !== undefined) out[r.provider_id] = { ...value, updatedAt: r.updated_at };
    }
    return out;
  }

  set(providerId: string, value: ProviderSecret): void {
    const s = this.seal(value);
    this.db
      .prepare("INSERT INTO provider_secrets (provider_id, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at")
      .run(providerId, s.iv, s.tag, s.data, new Date().toISOString());
  }

  remove(providerId: string): boolean {
    return Number((this.db.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(providerId) as { changes?: number | bigint }).changes ?? 0) > 0;
  }
}
