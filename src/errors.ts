// Every failure the API reports on purpose. Anything else becomes a generic 500.

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "unsupported_type"
  | "size_mismatch"
  | "internal";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 503,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);

/** A unique index said no. Stores throw this so the service never sees driver errors. */
export class DuplicateKeyError extends Error {
  constructor(readonly field: "contentHash" | "externalId" | "key" | "id") {
    super(`Duplicate ${field}`);
  }
}
