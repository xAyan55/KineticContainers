import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { openTestDb, setDbForTests } from "../src/db.js";
import { hashPassword } from "../src/services/password.js";
import { createApp } from "../src/app.js";
import { ROUTE_REGISTRY } from "../src/api/registry.js";
import { buildOpenApiDocument } from "../src/api/openapi.js";
import { findDocsDir } from "../src/api/docsRouter.js";

/**
 * Documentation cannot drift from the code:
 *
 *  1. every route actually mounted under `/api/v1` is declared in the registry
 *     (anything else would be rejected by the fail-closed scope guard);
 *  2. every registry entry is actually mounted (the specification must not
 *     advertise endpoints that do not exist);
 *  3. `docs/openapi.json` is byte-identical to the generated document.
 */

interface MountedRoute {
  method: string;
  path: string;
}

/** Reconstruct the mount prefix of an Express layer from its layer regexp. */
function mountPrefix(layer: { regexp?: RegExp }): string {
  const source = layer.regexp?.source;
  if (typeof source !== "string") throw new Error("Router layer without a regexp.");
  if (layer.regexp?.fast_slash) return "";
  const match = /^\^((?:\\.|[^$])*)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
  if (!match) throw new Error(`Unrecognized layer regexp: ${source}`);
  return match[1].replace(/\\(.)/g, "$1");
}

function collectRoutes(app: unknown): MountedRoute[] {
  const stack = (app as { _router?: { stack?: unknown[] } })._router?.stack;
  if (!Array.isArray(stack)) throw new Error("Express router stack unavailable.");
  const out: MountedRoute[] = [];

  const walk = (layers: unknown[], prefix: string): void => {
    for (const raw of layers) {
      const layer = raw as {
        route?: { path?: unknown; methods?: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: RegExp;
      };
      if (layer.route && typeof layer.route.path === "string") {
        const full = `${prefix}${layer.route.path}`;
        for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
          if (!enabled || method === "_all") continue;
          out.push({ method: method.toUpperCase(), path: full });
        }
        continue;
      }
      if (layer.name === "router" && Array.isArray(layer.handle?.stack)) {
        walk(layer.handle.stack, `${prefix}${mountPrefix(layer)}`);
      }
    }
  };

  walk(stack, "");
  return out;
}

function normalize(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

describe("API route registry and specification", () => {
  beforeEach(async () => {
    const db = openTestDb();
    setDbForTests(db);
    vi.stubEnv("CORS_ORIGINS", "");
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, role, status, avatar_seed, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?, ?)"
    ).run("usr_admin", "admin@test.local", "Admin", await hashPassword("AdminPass12345"), "admin", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  });

  it("mounts exactly the routes declared in the registry", () => {
    const app = createApp();
    const registered = new Set(
      collectRoutes(app)
        .filter((route) => route.path === "/api/v1" || route.path.startsWith("/api/v1/"))
        .map((route) => `${route.method} ${normalize(route.path)}`)
    );
    const declared = new Set(
      ROUTE_REGISTRY.map((spec) => `${spec.method} ${normalize(`/api/v1${spec.path}`)}`)
    );

    const undeclared = [...registered].filter((route) => !declared.has(route)).sort();
    const unmounted = [...declared].filter((route) => !registered.has(route)).sort();

    expect({ undeclared, unmounted }).toEqual({ undeclared: [], unmounted: [] });
  });

  it("rejects an endpoint that exists but is not declared (fail closed)", async () => {
    const app = createApp();
    // `GET /api/health` exists outside the versioned namespace, so the same
    // path under `/api/v1` must never reach a handler.
    const res = await request(app).get("/api/v1/health2");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("declares unique operation ids and a scope for every non-public route", () => {
    const ids = ROUTE_REGISTRY.map((spec) => spec.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of ROUTE_REGISTRY) {
      expect(spec.summary.length).toBeGreaterThan(10);
      if (spec.scope !== null) {
        expect(spec.scope).toMatch(/^[a-z_]+(:[a-z_]+)*$/);
      }
    }
  });

  it("publishes an OpenAPI document covering every registry entry", () => {
    const document = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId: string; "x-scope"?: string }>>;
    };
    const operations = Object.entries(document.paths).flatMap(([p, methods]) =>
      Object.entries(methods).map(([m, op]) => `${m.toUpperCase()} ${p} -> ${op.operationId}`)
    );
    const declared = ROUTE_REGISTRY.map(
      (spec) => `${spec.method} /api/v1${spec.path} -> ${spec.operationId}`
    );
    expect(new Set(operations)).toEqual(new Set(declared));

    for (const methods of Object.values(document.paths)) {
      for (const op of Object.values(methods)) {
        if (op["x-scope"] !== undefined) expect(op["x-scope"]).toBeTruthy();
      }
    }
  });

  it("keeps docs/openapi.json in sync with the generator", () => {
    const dir = findDocsDir();
    expect(dir).toBeTruthy();
    const file = path.join(dir as string, "openapi.json");
    expect(fs.existsSync(file)).toBe(true);
    const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    const committed = fs.readFileSync(file, "utf8");
    if (committed !== generated) {
      throw new Error("docs/openapi.json is stale — run `npm run openapi --workspace=server`.");
    }
  });

  it("serves the interactive documentation and the specification", async () => {
    const app = createApp();
    const page = await request(app).get("/api/docs");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.text).toContain("/api/docs/openapi.json");

    const spec = await request(app).get("/api/docs/openapi.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe("3.1.0");
    expect(spec.body.info.title).toBe("KineticCT API");
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(30);
    expect(spec.body.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
  });
});
