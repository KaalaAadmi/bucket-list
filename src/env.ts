import { z } from "zod";

// Read on first request, so a build never needs secrets.
const schema = z
  .object({
    // "memory" is for local trials and tests only; it forgets everything on restart.
    STORE: z.enum(["mongo", "memory"]).default("mongo"),
    MONGODB_URI: z.string().min(1).optional(),
    MONGODB_DB: z.string().min(1).default("r2_storage"),

    R2_ACCOUNT_ID: z.string().min(1),
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_BUCKET: z.string().min(1),
    // Override for an EU bucket (https://<account>.eu.r2.cloudflarestorage.com) or a local S3 mock.
    R2_ENDPOINT: z.string().url().optional(),

    // Creates and revokes API keys. Generate with `openssl rand -hex 32`.
    ADMIN_TOKEN: z.string().min(32),
    // Vercel sends this to the daily cleanup route. Set it in Vercel; `openssl rand -hex 32`.
    CRON_SECRET: z.string().min(16).optional(),
    FREE_TIER_BYTES: z.coerce.number().positive().default(10 * 1024 ** 3),
  })
  .superRefine((e, ctx) => {
    if (e.STORE === "mongo" && !e.MONGODB_URI) {
      ctx.addIssue({ code: "custom", path: ["MONGODB_URI"], message: "required when STORE=mongo" });
    }
    if (e.STORE === "memory" && process.env.VERCEL_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["STORE"], message: "memory store is not allowed in production" });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ");
      throw new Error(`bucket-list is missing or has invalid env vars: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
