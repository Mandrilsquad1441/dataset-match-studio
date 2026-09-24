import { describe, expect, it } from "vitest";
import { fingerprintRow, vendorRecordKey } from "./idempotency";

describe("source identity for retry-safe imports", () => {
  it("fingerprints the same raw object consistently regardless of key order", async () => {
    const first = await fingerprintRow({ name: "Northstar", values: { b: 2, a: 1 } });
    const reimported = await fingerprintRow({ values: { a: 1, b: 2 }, name: "Northstar" });
    expect(reimported).toBe(first);
    expect(vendorRecordKey(null, first)).toBe(vendorRecordKey(undefined, reimported));
  });

  it("prefers a vendor's stable source record ID over a changing row fingerprint", () => {
    expect(vendorRecordKey("  vendor-42 ", "raw-hash-1")).toBe("vendor-42");
    expect(vendorRecordKey("vendor-42", "raw-hash-2")).toBe("vendor-42");
  });
});
