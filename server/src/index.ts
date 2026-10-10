import dotenv from "dotenv";
import path from "node:path";
// Load the repo-root .env as a fallback so `npm --workspace` runs and the
// systemd unit (WorkingDirectory=server/) pick up the installer's config.
// Precedence: real environment > server/.env > repo-root .env.
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config();
import { createApp, ensureSeedAdmin } from "./app.js";
import { getDb } from "./db.js";
import { attachConsoleGateway } from "./services/virtualization/console.js";

async function main(): Promise<void> {
  getDb();
  await ensureSeedAdmin();
  const app = createApp();
  const port = Number(process.env.PORT ?? 8080);
  const server = app.listen(port, "127.0.0.1", () => {
    console.info(`[kineticct] API listening on http://127.0.0.1:${port}`);
  });
  attachConsoleGateway(server);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
