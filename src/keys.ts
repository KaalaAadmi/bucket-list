// Where files live in the bucket. Keys are stored per asset and never derived again,
// so objects imported from Shot Listed keep their old `originals/...` keys.
import { extensionFor } from "./policy.js";

export function originalKey(app: string, collection: string, id: string, contentType: string, at = new Date()): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `apps/${app}/${collection}/${yyyy}/${mm}/${id}.${extensionFor(contentType)}`;
}

export function variantKey(app: string, id: string, name: string, contentType: string): string {
  return `apps/${app}/variants/${id}/${name}.${extensionFor(contentType)}`;
}

/** Keep the original name for downloads, minus anything that breaks a header. */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f"\\/]/g, "_").trim();
  return (cleaned || "file").slice(0, 200);
}
