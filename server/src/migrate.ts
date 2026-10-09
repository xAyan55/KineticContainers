import "dotenv/config";
import { getDb } from "./db.js";

// `npm run migrate` — applies pending migrations then exits.
getDb();
console.info("[kineticct] migrations applied");
process.exit(0);
