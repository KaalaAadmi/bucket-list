// Thin wrapper over R2's S3-compatible API. Files never pass through Vercel:
// the server only signs short-lived URLs and the phone talks to R2 directly.
// Ported from shot-listed/web/src/lib/media/r2.ts.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DEFAULT_VIEW_URL_TTL_S, UPLOAD_URL_TTL_S } from "./policy.js";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
};

export type R2 = { client: S3Client; bucket: string };


export function createR2(cfg: R2Config): R2 {
  const client = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2 rejects the newer default checksum headers on presigned PUTs from browsers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    forcePathStyle: true,
  });
  return { client, bucket: cfg.bucket };
}

/** One presigned PUT; the browser must send exactly this Content-Type or R2 returns 403. */
export async function signSinglePut(r2: R2, key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    r2.client,
    new PutObjectCommand({ Bucket: r2.bucket, Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_S },
  );
}

export async function startMultipart(r2: R2, key: string, contentType: string): Promise<string> {
  const res = await r2.client.send(
    new CreateMultipartUploadCommand({ Bucket: r2.bucket, Key: key, ContentType: contentType }),
  );
  if (!res.UploadId) throw new Error("R2 did not return an UploadId");
  return res.UploadId;
}

export async function signParts(
  r2: R2,
  key: string,
  uploadId: string,
  partNumbers: number[],
): Promise<{ partNumber: number; url: string }[]> {
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(
        r2.client,
        new UploadPartCommand({ Bucket: r2.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: UPLOAD_URL_TTL_S },
      ),
    })),
  );
}

export async function completeMultipart(
  r2: R2,
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  await r2.client.send(
    new CompleteMultipartUploadCommand({
      Bucket: r2.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );
}

export async function abortMultipart(r2: R2, key: string, uploadId: string): Promise<void> {
  await r2.client.send(new AbortMultipartUploadCommand({ Bucket: r2.bucket, Key: key, UploadId: uploadId }));
}

/**
 * Parts R2 already holds for an open multipart upload, so a stopped upload can carry on.
 * Returns null if R2 no longer knows the upload (aborted, or dropped by the lifecycle rule).
 */
export async function listParts(
  r2: R2,
  key: string,
  uploadId: string,
): Promise<{ partNumber: number; etag: string; size: number }[] | null> {
  const parts: { partNumber: number; etag: string; size: number }[] = [];
  let marker: string | undefined;
  try {
    for (;;) {
      const res = await r2.client.send(
        new ListPartsCommand({ Bucket: r2.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: Number(p.Size ?? 0) });
      }
      if (!res.IsTruncated || !res.NextPartNumberMarker) break;
      marker = res.NextPartNumberMarker;
    }
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NoSuchUpload" || e.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/** Returns null if the object is not there (upload never finished). */
export async function headObject(r2: R2, key: string): Promise<{ size: number; contentType?: string } | null> {
  try {
    const res = await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }));
    return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw err;
  }
}

/** Private bucket: every view or download goes through a short-lived signed GET. */
export async function signGet(
  r2: R2,
  key: string,
  opts: { downloadName?: string; expiresIn?: number } = {},
): Promise<string> {
  return getSignedUrl(
    r2.client,
    new GetObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      ResponseContentDisposition: opts.downloadName ? `attachment; filename="${opts.downloadName}"` : undefined,
    }),
    { expiresIn: opts.expiresIn ?? DEFAULT_VIEW_URL_TTL_S },
  );
}

export async function deleteObject(r2: R2, key: string): Promise<void> {
  await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
}
