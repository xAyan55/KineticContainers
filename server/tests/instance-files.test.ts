import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTestDb, setDbForTests, newId, nowIso } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import { createApiKey } from "../src/services/apiKeys.js";
import { resolveContainerPath } from "../src/services/virtualization/containerFiles.js";

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

function makeInstance(db: ReturnType<typeof openTestDb>, ownerId: string, containerId: string, nodeId: string | null = "local"): string {
  const id = newId("vps");
  const now = nowIso();
  db.prepare(
    "INSERT INTO instances (id, name, container_id, node_id, owner_id, status, cpu, memory_mb, storage_gb, template, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'stopped', 1, 512, 10, 'alpine-3.20', ?, ?)"
  ).run(id, containerId, containerId, nodeId, ownerId, now, now);
  return id;
}

describe("container file manager", () => {
  let app: ReturnType<typeof createApp>;
  let tmp = "";
  let rootfs = "";
  let alice = "";
  let bob = "";
  let instanceId = "";
  let symlinksSupported = false;

  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kct-files-"));
    vi.stubEnv("KCT_LXC_PATH", tmp);

    await makeUser(db, { email: "admin@test.local", password: "AdminPass12345", role: "admin", name: "Admin" });
    alice = await makeUser(db, { email: "alice@test.local", password: "AlicePass12345", name: "Alice" });
    bob = await makeUser(db, { email: "bob@test.local", password: "BobPass12345", name: "Bob" });
    instanceId = makeInstance(db, alice, "alice-web");

    // Fake container rootfs on disk.
    rootfs = path.join(tmp, "alice-web", "rootfs");
    fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
    fs.mkdirSync(path.join(rootfs, "data", "sub"), { recursive: true });
    fs.mkdirSync(path.join(rootfs, "emptydir"), { recursive: true });
    fs.writeFileSync(path.join(rootfs, "README.txt"), "hello container\n");
    fs.writeFileSync(path.join(rootfs, "etc", "app.conf"), "port=8080\n");
    fs.writeFileSync(path.join(rootfs, "data", "sub", "nested.txt"), "nested\n");
    fs.writeFileSync(path.join(rootfs, "bin.tool"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    fs.writeFileSync(path.join(rootfs, "big.txt"), "a".repeat(1_200_000));
    fs.writeFileSync(path.join(rootfs, "real.txt"), "real target\n");
    fs.mkdirSync(path.join(tmp, "outside"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "outside", "secret.txt"), "outside secret\n");

    // Symlinks need privileges on some platforms; skip those tests when unavailable.
    try {
      fs.symlinkSync("real.txt", path.join(rootfs, "probe-link"));
      fs.unlinkSync(path.join(rootfs, "probe-link"));
      fs.symlinkSync("real.txt", path.join(rootfs, "link-inside"));
      fs.symlinkSync(path.join(tmp, "outside", "secret.txt"), path.join(rootfs, "link-outside"));
      symlinksSupported = true;
    } catch {
      symlinksSupported = false;
    }

    app = createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function login(email: string, password: string) {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email, password });
    return agent;
  }

  describe("path validation", () => {
    it("rejects traversal, absolute escapes, and malformed input", () => {
      const root = path.join(tmp, "alice-web", "rootfs");
      for (const bad of ["..", "/..", "/../etc", "/a/../../etc", "", "relative", "/x/y/../../..", "/ok/\0null", `/${"a".repeat(2000)}`]) {
        expect(() => resolveContainerPath(root, bad), bad).toThrowError();
      }
      expect(resolveContainerPath(root, "/")).toBe(root);
      expect(resolveContainerPath(root, "/etc/app.conf")).toBe(path.join(root, "etc", "app.conf"));
      expect(resolveContainerPath(root, "/etc//app.conf")).toBe(path.join(root, "etc", "app.conf"));
      // ".." is rejected even when it would normalize back inside: input is
      // never silently rewritten, so callers always mean what they asked for.
      expect(() => resolveContainerPath(root, "/etc/../README.txt")).toThrowError();
    });
  });

  describe("authorization", () => {
    it("serves owners, blocks other users and anonymous callers", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const own = await aliceAgent.get(`/api/instances/${instanceId}/files`).query({ path: "/" });
      expect(own.status).toBe(200);
      expect(own.body.data.path).toBe("/");
      const names = (own.body.data.entries as { name: string }[]).map((e) => e.name);
      expect(names).toContain("README.txt");
      const entry = (own.body.data.entries as Record<string, unknown>[]).find((e) => e.name === "README.txt");
      expect(entry).toMatchObject({ type: "file", size: 16 });
      expect(typeof entry!.mode).toBe("string");
      expect(typeof entry!.mtime).toBe("string");

      const bobAgent = await login("bob@test.local", "BobPass12345");
      expect((await bobAgent.get(`/api/instances/${instanceId}/files`).query({ path: "/" })).status).toBe(404);
      expect((await bobAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/README.txt" })).status).toBe(404);
      expect((await bobAgent.put(`/api/instances/${instanceId}/files/content`).send({ path: "/README.txt", content: "x" })).status).toBe(404);
      expect((await bobAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/evil.txt", type: "file" })).status).toBe(404);
      expect((await bobAgent.delete(`/api/instances/${instanceId}/files`).send({ paths: ["/README.txt"] })).status).toBe(404);

      const anon = request(app);
      expect((await anon.get(`/api/instances/${instanceId}/files`).query({ path: "/" })).status).toBe(401);

      // The record is untouched by the blocked attempts.
      expect(fs.readFileSync(path.join(rootfs, "README.txt"), "utf8")).toBe("hello container\n");
    });

    it("lets administrators manage any instance's files", async () => {
      const admin = await login("admin@test.local", "AdminPass12345");
      const res = await admin.get(`/api/instances/${instanceId}/files`).query({ path: "/etc" });
      expect(res.status).toBe(200);
      expect(res.body.data.entries.map((e: { name: string }) => e.name)).toEqual(["app.conf"]);
    });

    it("refuses remote nodes honestly", async () => {
      const db = (await import("../src/db.js")).getDb();
      db.prepare(
        "INSERT INTO nodes (id, name, endpoint, api_token, status, node_type, provider, is_protected, created_at, updated_at) VALUES ('remote1', 'Remote', 'https://192.0.2.10', '', 'unknown', 'remote', 'local-lxc', 0, ?, ?)"
      ).run(nowIso(), nowIso());
      const remoteInstance = makeInstance(db, alice, "remote-box", "remote1");
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const res = await aliceAgent.get(`/api/instances/${remoteInstance}/files`).query({ path: "/" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("REMOTE_NODE_UNSUPPORTED");
    });

    it("reports a missing host filesystem instead of inventing one", async () => {
      const db = (await import("../src/db.js")).getDb();
      const ghost = makeInstance(db, alice, "ghost-box");
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const res = await aliceAgent.get(`/api/instances/${ghost}/files`).query({ path: "/" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("FILESYSTEM_NOT_FOUND");
    });
  });

  describe("file operations", () => {
    it("reads text files and refuses binary, oversized, and missing files", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const read = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/etc/app.conf" });
      expect(read.status).toBe(200);
      expect(read.body.data.content).toBe("port=8080\n");

      const binary = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/bin.tool" });
      expect(binary.status).toBe(415);
      expect(binary.body.error.code).toBe("UNSUPPORTED_FILE");

      const big = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/big.txt" });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe("FILE_TOO_LARGE");

      const missing = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/nope.txt" });
      expect(missing.status).toBe(404);

      const dir = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/etc" });
      expect(dir.status).toBe(400);
    });

    it("writes atomically with optimistic concurrency", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const before = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/etc/app.conf" });
      const saved = await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({
        path: "/etc/app.conf",
        content: "port=9090\n",
        expected_mtime: before.body.data.mtime,
      });
      expect(saved.status).toBe(200);
      expect(fs.readFileSync(path.join(rootfs, "etc", "app.conf"), "utf8")).toBe("port=9090\n");

      // Stale mtime: someone else changed the file.
      const stale = await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({
        path: "/etc/app.conf",
        content: "port=1111\n",
        expected_mtime: before.body.data.mtime,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("FILE_CHANGED");
      expect(typeof stale.body.error.details?.actual_mtime).toBe("string");
      expect(fs.readFileSync(path.join(rootfs, "etc", "app.conf"), "utf8")).toBe("port=9090\n");

      expect((await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({ path: "/etc", content: "x" })).status).toBe(400);
      expect((await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({ path: "/new.txt", content: "x" })).status).toBe(404);
    });

    it("creates files and directories, and conflicts on duplicates", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const file = await aliceAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/notes/todo.txt", type: "file" });
      expect(file.status).toBe(201);
      expect(file.body.data.entry).toMatchObject({ name: "todo.txt", type: "file", size: 0 });
      const dir = await aliceAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/notes/archive", type: "dir" });
      expect(dir.status).toBe(201);
      expect(fs.statSync(path.join(rootfs, "notes", "todo.txt")).isFile()).toBe(true);
      expect(fs.statSync(path.join(rootfs, "notes", "archive")).isDirectory()).toBe(true);

      expect((await aliceAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/notes/todo.txt", type: "file" })).status).toBe(409);
      expect((await aliceAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/etc", type: "dir" })).status).toBe(409);
      expect((await aliceAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/../../evil", type: "file" })).status).toBe(400);
    });

    it("renames and moves without touching anything else", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const renamed = await aliceAgent.patch(`/api/instances/${instanceId}/files/move`).send({ from: "/README.txt", to: "/README2.txt" });
      expect(renamed.status).toBe(200);
      expect(fs.existsSync(path.join(rootfs, "README.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(rootfs, "README2.txt"), "utf8")).toBe("hello container\n");

      const moved = await aliceAgent.patch(`/api/instances/${instanceId}/files/move`).send({ from: "/data/sub", to: "/sub2" });
      expect(moved.status).toBe(200);
      expect(fs.readFileSync(path.join(rootfs, "sub2", "nested.txt"), "utf8")).toBe("nested\n");

      expect((await aliceAgent.patch(`/api/instances/${instanceId}/files/move`).send({ from: "/README2.txt", to: "/etc/app.conf" })).status).toBe(409);
      expect((await aliceAgent.patch(`/api/instances/${instanceId}/files/move`).send({ from: "/sub2", to: "/sub2/inner" })).status).toBe(400);
      expect((await aliceAgent.patch(`/api/instances/${instanceId}/files/move`).send({ from: "/missing.txt", to: "/x.txt" })).status).toBe(404);
    });

    it("uploads batches and downloads exact bytes", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const payload = {
        path: "/data",
        files: [
          { name: "one.txt", content: Buffer.from("first file\n").toString("base64") },
          { name: "two.txt", content: Buffer.from("second file\n").toString("base64") },
        ],
      };
      const up = await aliceAgent.post(`/api/instances/${instanceId}/files/upload`).send(payload);
      expect(up.status).toBe(201);
      expect(up.body.data.files.map((f: { name: string }) => f.name)).toEqual(["one.txt", "two.txt"]);

      const dl = await aliceAgent
        .get(`/api/instances/${instanceId}/files/download`)
        .query({ path: "/data/one.txt" })
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
          res.on("end", () => done(null, Buffer.concat(chunks)));
        });
      expect(dl.status).toBe(200);
      expect(dl.headers["content-type"]).toContain("application/octet-stream");
      expect(dl.headers["content-disposition"]).toContain("one.txt");
      expect((dl.body as Buffer).toString("utf8")).toBe("first file\n");

      const bin = await aliceAgent.get(`/api/instances/${instanceId}/files/download`).query({ path: "/bin.tool" });
      expect(bin.status).toBe(200);
      expect(bin.headers["content-length"]).toBe("6");

      // Duplicate without consent conflicts; with consent it overwrites.
      const dup = await aliceAgent.post(`/api/instances/${instanceId}/files/upload`).send(payload);
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("ALREADY_EXISTS");
      const over = await aliceAgent
        .post(`/api/instances/${instanceId}/files/upload`)
        .send({ ...payload, overwrite: true, files: [{ name: "one.txt", content: Buffer.from("replaced\n").toString("base64") }] });
      expect(over.status).toBe(201);
      expect(over.body.data.files[0].overwritten).toBe(true);
      expect(fs.readFileSync(path.join(rootfs, "data", "one.txt"), "utf8")).toBe("replaced\n");

      expect((await aliceAgent.post(`/api/instances/${instanceId}/files/upload`).send({ path: "/data", files: [{ name: "../evil.txt", content: "eA==" }] })).status).toBe(400);
      expect((await aliceAgent.post(`/api/instances/${instanceId}/files/upload`).send({ path: "/data", files: [{ name: "bad.txt", content: "!!!not-base64!!!" }] })).status).toBe(400);
    });

    it("deletes recursively after validating every path", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const res = await aliceAgent.delete(`/api/instances/${instanceId}/files`).send({ paths: ["/data", "/README.txt"] });
      expect(res.status).toBe(200);
      expect(res.body.data.deleted.sort()).toEqual(["/README.txt", "/data"]);
      expect(fs.existsSync(path.join(rootfs, "data"))).toBe(false);

      // One missing path aborts the whole batch; nothing is removed.
      const bad = await aliceAgent.delete(`/api/instances/${instanceId}/files`).send({ paths: ["/etc/app.conf", "/missing.txt"] });
      expect(bad.status).toBe(404);
      expect(fs.existsSync(path.join(rootfs, "etc", "app.conf"))).toBe(true);

      expect((await aliceAgent.delete(`/api/instances/${instanceId}/files`).send({ paths: ["/"] })).status).toBe(400);
      expect((await aliceAgent.delete(`/api/instances/${instanceId}/files`).send({ paths: [] })).status).toBe(400);
    });

    it("paginates, sorts, and searches listings", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      for (const n of ["a.txt", "b.txt", "c.log", "d.txt"]) {
        fs.writeFileSync(path.join(rootfs, n), "x".repeat(n === "c.log" ? 50 : 5));
      }
      const page1 = await aliceAgent.get(`/api/instances/${instanceId}/files`).query({ path: "/", limit: 3, offset: 0, sort: "name", order: "asc" });
      expect(page1.body.data.entries).toHaveLength(3);
      expect(page1.body.data.pagination.total).toBeGreaterThanOrEqual(4);
      const page2 = await aliceAgent.get(`/api/instances/${instanceId}/files`).query({ path: "/", limit: 3, offset: 3, sort: "name", order: "asc" });
      expect(page2.body.data.entries.length).toBeGreaterThan(0);

      const bySize = await aliceAgent.get(`/api/instances/${instanceId}/files`).query({ path: "/", sort: "size", order: "desc", q: ".txt" });
      expect(bySize.body.data.entries[0].name).toBe("big.txt");
      expect(bySize.body.data.entries.every((e: { name: string }) => e.name.includes(".txt"))).toBe(true);
      for (let i = 1; i < bySize.body.data.entries.length; i++) {
        expect(bySize.body.data.entries[i - 1].size).toBeGreaterThanOrEqual(bySize.body.data.entries[i].size);
      }
    });

    it("audits mutating file operations without storing content", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({ path: "/etc/app.conf", content: "port=1\n" });
      const db = (await import("../src/db.js")).getDb();
      const events = db.prepare("SELECT action, detail FROM audit_events WHERE target_id = ? AND action = 'instance.files'").all(instanceId) as {
        action: string;
        detail: string;
      }[];
      expect(events.length).toBeGreaterThanOrEqual(1);
      const detail = JSON.parse(events[events.length - 1]!.detail) as Record<string, unknown>;
      expect(detail.op).toBe("write");
      expect(detail.path).toBe("/etc/app.conf");
      expect(events[events.length - 1]!.detail).not.toContain("port=1");
    });
  });

  describe("traversal and symlink attacks", () => {
    it("rejects traversal over the API", async () => {
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      for (const p of ["/../secret", "/etc/../../..", "..", "etc/app.conf"]) {
        const res = await aliceAgent.get(`/api/instances/${instanceId}/files`).query({ path: p });
        expect(res.status, p).toBe(400);
        expect(res.body.error.code, p).toBe("INVALID_PATH");
      }
      // Double-encoded traversal stays a literal filename: no second decode pass,
      // so it can never resolve outside the root (404, not a breakout).
      const encoded = await aliceAgent.get(`/api/instances/${instanceId}/files`).query({ path: "/%2e%2e/outside" });
      expect(encoded.status).toBe(404);
      expect(encoded.body.error.code).toBe("NOT_FOUND");
      const write = await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({ path: "/../evil.txt", content: "x" });
      expect(write.status).toBe(400);
      expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
    });

    it("refuses to follow symlinks outside the root", async () => {
      if (!symlinksSupported) return;
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const read = await aliceAgent.get(`/api/instances/${instanceId}/files/content`).query({ path: "/link-outside" });
      expect(read.status).toBe(400);
      expect(read.body.error.code).toBe("SYMLINK_REJECTED");

      const dl = await aliceAgent.get(`/api/instances/${instanceId}/files/download`).query({ path: "/link-outside" });
      expect(dl.status).toBe(400);

      const write = await aliceAgent.put(`/api/instances/${instanceId}/files/content`).send({ path: "/link-outside", content: "pwned\n" });
      expect(write.status).toBe(400);
      expect(fs.readFileSync(path.join(tmp, "outside", "secret.txt"), "utf8")).toBe("outside secret\n");

      // Removing the link itself is safe and leaves the target intact.
      const del = await aliceAgent.delete(`/api/instances/${instanceId}/files`).send({ paths: ["/link-outside"] });
      expect(del.status).toBe(200);
      expect(fs.existsSync(path.join(rootfs, "link-outside"))).toBe(false);
      expect(fs.readFileSync(path.join(tmp, "outside", "secret.txt"), "utf8")).toBe("outside secret\n");
    });

    it("does not traverse symlinked ancestors on write", async () => {
      if (!symlinksSupported) return;
      // A directory symlink inside the root pointing outside must not become a write path.
      fs.symlinkSync(path.join(tmp, "outside"), path.join(rootfs, "evil-dir"));
      const aliceAgent = await login("alice@test.local", "AlicePass12345");
      const res = await aliceAgent.post(`/api/instances/${instanceId}/files`).send({ path: "/evil-dir/planted.txt", type: "file" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("SYMLINK_REJECTED");
      expect(fs.existsSync(path.join(tmp, "outside", "planted.txt"))).toBe(false);
    });
  });

  describe("versioned API", () => {
    it("enforces the files scopes on /api/v1", async () => {
      const db = (await import("../src/db.js")).getDb();
      const reader = createApiKey(db, { name: "Reader", scopes: ["instances:files:read"], createdBy: alice, expiresAt: null, ipAllowlist: [] });
      const list = await request(app).get(`/api/v1/instances/${instanceId}/files`).set("Authorization", `Bearer ${reader.secret}`).query({ path: "/" });
      expect(list.status).toBe(200);
      expect(list.body.data.entries.length).toBeGreaterThan(0);

      const denied = await request(app).put(`/api/v1/instances/${instanceId}/files/content`).set("Authorization", `Bearer ${reader.secret}`).send({ path: "/README.txt", content: "x" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("INSUFFICIENT_SCOPE");

      const writer = createApiKey(db, { name: "Writer", scopes: ["instances:files:write"], createdBy: alice, expiresAt: null, ipAllowlist: [] });
      const saved = await request(app).put(`/api/v1/instances/${instanceId}/files/content`).set("Authorization", `Bearer ${writer.secret}`).send({ path: "/README.txt", content: "via api\n" });
      expect(saved.status).toBe(200);
      expect(fs.readFileSync(path.join(rootfs, "README.txt"), "utf8")).toBe("via api\n");

      // A key owned by another user still cannot reach this container.
      const other = createApiKey(db, { name: "Bob key", scopes: ["instances:files:read"], createdBy: bob, expiresAt: null, ipAllowlist: [] });
      const foreign = await request(app).get(`/api/v1/instances/${instanceId}/files`).set("Authorization", `Bearer ${other.secret}`).query({ path: "/" });
      expect(foreign.status).toBe(404);
    });
  });
});
