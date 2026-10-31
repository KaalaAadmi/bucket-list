// Create an API key for an app. The key is printed once; store it in that app's env vars.
//   ADMIN_TOKEN=... npm run create-key -- --url https://<storage>.vercel.app --app shot-listed --name vercel --scopes read,write,delete
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.STORAGE_API_URL ?? "http://localhost:8787" },
    app: { type: "string" },
    name: { type: "string" },
    scopes: { type: "string", default: "read,write,delete" },
  },
});

const token = process.env.ADMIN_TOKEN;
if (!token || !values.app || !values.name) {
  console.error("Usage: ADMIN_TOKEN=... npm run create-key -- --url <storage url> --app <app> --name <label> [--scopes read,write,delete]");
  process.exit(1);
}

const res = await fetch(new URL("/v1/keys", values.url), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ app: values.app, name: values.name, scopes: values.scopes!.split(",").map((s) => s.trim()) }),
});
const body = (await res.json()) as { key?: string; id?: string; error?: { message: string } };
if (!res.ok || !body.key) {
  console.error(`Failed (${res.status}): ${body.error?.message ?? "unknown error"}`);
  process.exit(1);
}
console.log(`Key ${body.id} for ${values.app} (${values.scopes}). Shown once:\n\n${body.key}\n`);
