import { createHash } from "node:crypto";

import type { ZoneRecord } from "../config/types";

/**
 * A zone record's resource name. The content's hash is part of it: two TXT
 * records on the apex differ only there, and a changed value then becomes a
 * new record created before the old one is deleted, so the name never goes
 * unanswered.
 */
export function zoneRecordKey(record: ZoneRecord): string {
  const label =
    record.name === "@"
      ? "apex"
      : record.name.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(record.content).digest("hex").slice(0, 8);
  return `${record.type.toLowerCase()}-${label}-${hash}`;
}

/** The record's full name, which is how Cloudflare stores and returns it. */
export const zoneRecordName = (record: ZoneRecord, domain: string): string =>
  record.name === "@" ? domain : `${record.name}.${domain}`;
