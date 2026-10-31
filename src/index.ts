// Vercel entry point: Vercel detects a Hono app exported from src/index.ts and serves it
// as a Node function. Dependencies are built on the first request and reused while warm.
import { createApp, type Deps } from "./app.js";
import { env } from "./env.js";
import { createR2 } from "./r2.js";
import { memoryStore } from "./store/memory.js";
import { mongoStore } from "./store/mongo.js";

let deps: Promise<Deps> | undefined;

function build(): Promise<Deps> {
  deps ??= (async () => {
    const e = env();
    const store = e.STORE === "memory" ? memoryStore() : await mongoStore(e.MONGODB_URI!, e.MONGODB_DB);
    return {
      store,
      r2: createR2({
        accountId: e.R2_ACCOUNT_ID,
        accessKeyId: e.R2_ACCESS_KEY_ID,
        secretAccessKey: e.R2_SECRET_ACCESS_KEY,
        bucket: e.R2_BUCKET,
        endpoint: e.R2_ENDPOINT,
      }),
      adminToken: e.ADMIN_TOKEN,
      cronSecret: e.CRON_SECRET,
      freeTierBytes: e.FREE_TIER_BYTES,
    };
  })().catch((err) => {
    deps = undefined; // try again on the next request, e.g. after Atlas wakes up
    throw err;
  });
  return deps;
}

const app = createApp(build);

export default app;
