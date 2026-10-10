import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_TINY = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]).toString("base64")}`;
const ICO_TINY = `data:image/x-icon;base64,${Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.alloc(100)]).toString("base64")}`;

function pngOfSize(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function makeUser(
  db: ReturnType<typeof openTestDb>,
  opts: { email: string; password: string; role?: "admin" | "user"; name?: string }
): Promise<string> {
  const id = newId("usr");
  const now = nowIso();
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
  ).run(id, opts.email.toLowerCase(), opts.name ?? "Test", await hashPassword(opts.password), opts.role ?? "user", opts.email.toLowerCase(), now, now);
  return id;
}

describe("branding uploads", () => {
  let app: ReturnType<typeof createApp>;
  let brandDir = "";

  beforeEach(async () => {
    brandDir = fs.mkdtempSync(path.join(os.tmpdir(), "kct-brand-"));
    vi.stubEnv("KINETICCT_BRANDING_DIR", brandDir);
    vi.stubEnv("CORS_ORIGINS", "");
    const db = openTestDb();
    setDbForTests(db);
    await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin", name: "Admin" });
    await makeUser(db, { email: "user@test.local", password: "UserPass12345", role: "user", name: "User" });
    app = createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(brandDir, { recursive: true, force: true });
  });

  async function adminAgent() {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "AdminPass12345" });
    return agent;
  }

  async function userAgent() {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "user@test.local", password: "UserPass12345" });
    return agent;
  }

  it("requires admin for uploads", async () => {
    expect((await request(app).post("/api/settings/branding").send({ logo: PNG_1X1 })).status).toBe(401);
    const user = await userAgent();
    const res = await user.post("/api/settings/branding").send({ logo: PNG_1X1 });
    expect(res.status).toBe(403);
  });

  it("uploads a logo and serves it back publicly", async () => {
    const admin = await adminAgent();
    const up = await admin.post("/api/settings/branding").send({ logo: PNG_1X1 });
    expect(up.status).toBe(200);
    expect(up.body.data.logo_url).toMatch(/^\/api\/settings\/branding\/logo\?v=\d+$/);

    const served = await request(app).get(up.body.data.logo_url);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");

    const pub = await request(app).get("/api/settings/public");
    expect(pub.body.data.settings.logo_url).toBe(up.body.data.logo_url);

    const full = await admin.get("/api/settings");
    expect(full.body.data.settings.logo_url).toBe(up.body.data.logo_url);
  });

  it("accepts JPEG and ICO where allowed", async () => {
    const admin = await adminAgent();
    expect((await admin.post("/api/settings/branding").send({ logo: JPEG_TINY })).status).toBe(200);
    expect((await admin.post("/api/settings/branding").send({ favicon: ICO_TINY })).status).toBe(200);
    const fav = await admin.post("/api/settings/branding").send({});
    expect(fav.body.data.favicon_url).toMatch(/favicon/);
  });

  it("rejects non-image, mismatched, and SVG uploads", async () => {
    const admin = await adminAgent();
    const text = `data:text/plain;base64,${Buffer.from("hello").toString("base64")}`;
    expect((await admin.post("/api/settings/branding").send({ logo: text })).status).toBe(400);
    const mismatch = `data:image/png;base64,${Buffer.from("hello, not a png").toString("base64")}`;
    expect((await admin.post("/api/settings/branding").send({ logo: mismatch })).status).toBe(400);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64")}`;
    const svgRes = await admin.post("/api/settings/branding").send({ logo: svg });
    expect(svgRes.status).toBe(400);
    expect((await admin.post("/api/settings/branding").send({ logo: "not-a-data-url" })).status).toBe(400);
    // Nothing persisted from the rejected attempts.
    const pub = await request(app).get("/api/settings/public");
    expect(pub.body.data.settings.logo_url).toBe("");
  });

  it("rejects oversize images", async () => {
    const admin = await adminAgent();
    const big = await admin.post("/api/settings/branding").send({ logo: pngOfSize(1024 * 1024 + 100) });
    expect(big.status).toBe(400);
  });

  it("accepts bodies above the default JSON cap via the branding parser", async () => {
    const admin = await adminAgent();
    // ~410KB of JSON: would 413 under the global 256kb parser.
    const res = await admin.post("/api/settings/branding").send({ logo: pngOfSize(300 * 1024) });
    expect(res.status).toBe(200);
    expect(res.body.data.logo_url).toContain("/api/settings/branding/logo");
  });

  it("clears images with null and 404s afterwards", async () => {
    const admin = await adminAgent();
    await admin.post("/api/settings/branding").send({ logo: PNG_1X1, favicon: ICO_TINY });
    const cleared = await admin.post("/api/settings/branding").send({ logo: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.logo_url).toBe("");
    expect(cleared.body.data.favicon_url).toContain("favicon");
    expect((await request(app).get("/api/settings/branding/logo")).status).toBe(404);
    await admin.post("/api/settings/branding").send({ favicon: null });
    expect((await request(app).get("/api/settings/branding/favicon")).status).toBe(404);
  });

  it("404s unknown asset kinds and missing files", async () => {
    expect((await request(app).get("/api/settings/branding/logo")).status).toBe(404);
    expect((await request(app).get("/api/settings/branding/banner")).status).toBe(404);
  });
});
