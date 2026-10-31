// What to do with a new upload request, given what's already stored. Pure, so it can be
// tested without a database; assets.ts does the lookups and acts on the answer.
// Ported from shot-listed/web/src/lib/media/dedupe.ts.

export type ExistingUpload = {
  id: string;
  status: "uploading" | "uploaded";
  size: number;
  externalId?: string;
};

export type UploadDecision =
  /** Already stored. `adoptExternalId`: give the existing item the caller's source ID. */
  | { action: "duplicate"; id: string; adoptExternalId: boolean }
  /** An earlier attempt at the same file never finished: carry on with it, don't start over. */
  | { action: "resume"; id: string }
  | { action: "new" }
  | { action: "reject"; status: 400; message: string };

export function decideUpload(input: {
  size: number;
  externalId?: string;
  /** Item with the same source ID (Photos UUID), if any. Checked first. */
  byExternalId?: ExistingUpload | null;
  /** Item with the same content hash in the same collection, if any. */
  byHash?: ExistingUpload | null;
}): UploadDecision {
  const { byExternalId, byHash } = input;

  if (byExternalId) {
    return byExternalId.status === "uploaded"
      ? { action: "duplicate", id: byExternalId.id, adoptExternalId: false }
      : { action: "resume", id: byExternalId.id };
  }

  if (byHash) {
    // Identical bytes can't have different lengths; this is a client bug, not a duplicate.
    if (byHash.size !== input.size) {
      return { action: "reject", status: 400, message: "Content hash matches a file of a different size" };
    }
    if (byHash.status === "uploading") return { action: "resume", id: byHash.id };
    return {
      action: "duplicate",
      id: byHash.id,
      // The phone uploaded these exact bytes; now the Mac sends them with a Photos UUID.
      adoptExternalId: Boolean(input.externalId) && !byHash.externalId,
    };
  }

  return { action: "new" };
}
