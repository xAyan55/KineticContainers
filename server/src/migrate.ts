import dotenv from "dotenv";
import path from "node:path";
// Same fallback as index.ts: repo-root .env, then server-local .env.
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();
import { getDb } from "./db.js";

// `npm run migrate` — applies pending migrations then exits.
getDb();
console.info("[kineticct] migrations applied");
process.exit(0);
