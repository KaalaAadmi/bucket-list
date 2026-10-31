// Local server: `npm run dev` (reads .env) or `npm run start:memory` (no database needed).
// On Vercel, src/index.ts is used directly; this file is only for your machine.
import { serve } from "@hono/node-server";
import app from "./index.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file: fine if the variables are already set
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`bucket-list listening on http://localhost:${port} (store: ${process.env.STORE ?? "mongo"})`);
});
