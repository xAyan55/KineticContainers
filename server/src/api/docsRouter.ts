import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "./openapi.js";

/**
 * Interactive API documentation at `/api/docs`.
 *
 * The page is served from this installation (no CDN, works offline) and
 * loads the live OpenAPI document from `/api/docs/openapi.json`, which is
 * generated from the same route registry the server enforces. Requests fired
 * from the explorer go to this origin with ordinary API authentication and
 * are rate-limited exactly like any other client.
 */

const HTML_CACHE: { html: string | null } = { html: null };

export function findDocsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "docs"),
    path.resolve(process.cwd(), "..", "docs"),
    path.resolve(process.cwd(), "..", "..", "docs"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "openapi.json")) || fs.existsSync(path.join(dir, "api.html"))) return dir;
  }
  return null;
}

function docsPage(): string {
  if (HTML_CACHE.html !== null) return HTML_CACHE.html;
  const dir = findDocsDir();
  const file = dir ? path.join(dir, "api.html") : null;
  if (file && fs.existsSync(file)) {
    HTML_CACHE.html = fs.readFileSync(file, "utf8");
  } else {
    HTML_CACHE.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>KineticCT API</title></head>
<body><h1>KineticCT API documentation</h1>
<p>docs/api.html was not found. The OpenAPI document is available at <a href="/api/docs/openapi.json">/api/docs/openapi.json</a>.</p>
</body></html>`;
  }
  return HTML_CACHE.html;
}

export function createDocsRouter(): Router {
  const router = Router();

  router.get("/openapi.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(JSON.stringify(buildOpenApiDocument(), null, 2));
  });

  router.get(["/", "/index.html"], (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(docsPage());
  });

  router.use(express.json({ limit: "1kb" }));
  router.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `Unknown documentation route: ${req.method} ${req.path}` } });
  });

  return router;
}
