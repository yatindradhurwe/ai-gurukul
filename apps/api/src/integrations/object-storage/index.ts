import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Short-lived signed URLs for private, tenant-scoped objects. Replace the
 * signer with the S3-compatible SDK presigner in production; the contract —
 * tenant-prefixed keys and expiring links — stays the same.
 */
export function signedUrl(tenantId: string, key: string, ttlSeconds = 300): string {
  if (!key.startsWith(`${tenantId}/`)) {
    throw new Error("object key is outside the tenant's namespace");
  }
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", env.JWT_SECRET).update(`${key}:${expires}`).digest("base64url");
  return `/media/${encodeURIComponent(key)}?expires=${expires}&sig=${sig}`;
}
