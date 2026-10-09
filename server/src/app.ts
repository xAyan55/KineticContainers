import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { getDb, getSetting, newId, nowIso } from "./db.js";
import { hashPassword } from "./services/password.js";
import { csrfCheck } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { instancesRouter, templatesRouter } from "./routes/instances.js";
import { adminUsersRouter } from "./routes/admin/users.js";
import { adminOverviewRouter } from "./routes/admin/overview.js";
import { adminCreateRouter } from "./routes/admin/create.js";
import { nodesRouter } from "./routes/nodes.js";
import { settingsRouter } from "./routes/settings.js";

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  const origins = (process.env.CORS_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (origins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    })
  );

  app.get("/api/health", (_req, res) => res.json({ data: { ok: true, version: "0.1.0" } }));

  app.use("/api/auth", csrfCheck, authRouter);
  app.use("/api/me", csrfCheck, meRouter);
  app.use("/api/instances", csrfCheck, instancesRouter);
  app.use("/api/templates", csrfCheck, templatesRouter);
  app.use("/api/admin/overview", csrfCheck, adminOverviewRouter);
  app.use("/api/admin/users", csrfCheck, adminUsersRouter);
  app.use("/api/admin/instances", csrfCheck, adminCreateRouter);
  app.use("/api/nodes", csrfCheck, nodesRouter);
  app.use("/api/settings", csrfCheck, settingsRouter);

  // Serve built frontend when present (single-process self-hosting).
  const frontendDist = path.resolve(process.cwd(), "..", "frontend", "dist");
  const altDist = path.resolve(process.cwd(), "frontend", "dist");
  const dist = fs.existsSync(frontendDist) ? frontendDist : altDist;
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  // Centralized error shape — never leak stack traces.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
  });

  return app;
}

/** Create the initial administrator on first boot when no users exist. */
export async function ensureSeedAdmin(): Promise<void> {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  if (count > 0) return;
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.invalid").trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (password.length < 10) {
    console.warn("[kineticct] No users exist and SEED_ADMIN_PASSWORD is missing/too short; skipping seed. Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create the first admin.");
    return;
  }
  const name = (process.env.SEED_ADMIN_NAME ?? "Administrator").trim().slice(0, 120) || "Administrator";
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?, ?)"
  ).run(newId("usr"), email, name, await hashPassword(password), email, now, now);
  console.info(`[kineticct] Seeded initial admin <${email}>. Change the password after first login.`);
  void getSetting;
}
