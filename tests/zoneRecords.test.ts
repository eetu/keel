import { describe, expect, it } from "vitest";

import { zoneRecordKey, zoneRecordName } from "../src/infra/zoneRecords";

describe("a zone record", () => {
  it("keeps two TXT records on the apex apart by their content", () => {
    const spf = { type: "TXT", name: "@", content: '"v=spf1 -all"' } as const;
    const verify = { type: "TXT", name: "@", content: '"verification=1"' } as const;
    expect(zoneRecordKey(spf)).not.toBe(zoneRecordKey(verify));
    expect(zoneRecordKey(spf)).toMatch(/^txt-apex-[0-9a-f]{8}$/);
  });

  it("is named in full, the way Cloudflare returns it", () => {
    expect(zoneRecordName({ type: "MX", name: "@", content: "m" }, "example.com")).toBe(
      "example.com",
    );
    expect(zoneRecordName({ type: "TXT", name: "_dmarc", content: "d" }, "example.com")).toBe(
      "_dmarc.example.com",
    );
  });
});
