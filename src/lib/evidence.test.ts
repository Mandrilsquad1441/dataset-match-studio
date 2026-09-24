import { describe, expect, it } from "vitest";
import { validateEvidenceReferences } from "./evidence";

describe("escalation evidence references", () => {
  it("accepts only field paths present in the supplied candidate pair", () => {
    const result = validateEvidenceReferences([
      { side: "internal", path: "identifiers.registry" },
      { side: "vendor", path: "fields.status" },
      { side: "internal", path: "secret.prompt" },
    ], {
      internal: { identifiers: { registry: "NS-1042" } },
      vendor: { fields: { status: "open" } },
    });
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toEqual([{ side: "internal", path: "secret.prompt" }]);
  });
});
