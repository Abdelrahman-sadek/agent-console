import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { openDatabase } from "./db.js";
import { loadMasterKey } from "./secrets.js";
import { IssueLog, errorDetail } from "./logger.js";
import { dirname, join } from "node:path";

const production = process.env.NODE_ENV === "production";
const adminPassword = process.env.ADMIN_PASSWORD ?? (production ? undefined : "demo");
if (adminPassword === undefined || (production && adminPassword.length < 8)) {
  console.error("ADMIN_PASSWORD must be set (at least 8 characters) in production.");
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH ?? "data/console.db";
const log = new IssueLog(process.env.LOG_FILE ?? join(databasePath === ":memory:" ? "data" : dirname(databasePath), "logs", "console.log"));
process.on("unhandledRejection", (reason) => log.error("server", `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`, errorDetail(reason)));
process.on("uncaughtException", (error) => {
  log.error("server", `Uncaught exception: ${error.message}`, errorDetail(error));
  process.exit(1); // Docker restarts the container; the log keeps the reason
});
const db = await openDatabase(databasePath);
const app = await createApp({ db, adminPassword, secureCookies: production && process.env.INSECURE_COOKIES !== "1", masterKey: loadMasterKey(databasePath), log });
log.info("startup", "Console started", { node: process.version });

if (production) {
  // The built UI; any non-API path falls back to index.html for client-side routing.
  const index = readFileSync("dist/web/index.html", "utf8");
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.html(index)));
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname: host }, () => console.log(`agent-console listening on http://${host}:${port}${production ? "" : " (dev password: demo)"}`));
