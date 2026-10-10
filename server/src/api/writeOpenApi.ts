import fs from "node:fs";
import path from "node:path";
import { buildOpenApiDocument } from "./openapi.js";
import { findDocsDir } from "./docsRouter.js";

/** Write `docs/openapi.json` from the live route registry (`npm run openapi`). */
function main(): void {
  const dir = findDocsDir() ?? path.resolve(process.cwd(), "..", "docs");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "openapi.json");
  const document = buildOpenApiDocument();
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const paths = Object.keys(document.paths as Record<string, unknown>).length;
  console.info(`[kineticct] wrote ${target} (${paths} paths)`);
}

main();
