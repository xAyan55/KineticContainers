import "dotenv/config";
import { createApp, ensureSeedAdmin } from "./app.js";
import { getDb } from "./db.js";

async function main(): Promise<void> {
  getDb();
  await ensureSeedAdmin();
  const app = createApp();
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, "127.0.0.1", () => {
    console.info(`[kineticct] API listening on http://127.0.0.1:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
