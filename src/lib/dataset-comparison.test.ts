import { describe, expect, it } from "vitest";
import { prepareLocalComparison, type LocalDataset } from "./dataset-comparison";

function dataset(rows: Record<string, unknown>[], idField?: string): LocalDataset {
  return { name: "Dataset", rows, nameField: "label", idField };
}

describe("local comparison of user datasets", () => {
  it("compares each Dataset 2 row to actual Dataset 1 records", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Café du Parc" }, { label: "North Office" }]),
      dataset([{ label: "NORTH-OFFICE" }, { label: "cafe du parc" }]),
    );
    expect(comparison.total).toBe(2);
    expect(comparison.compareRow(0)).toMatchObject({ name: "NORTH-OFFICE", targetIndex: 1, targetName: "North Office", lane: "review", confidence: null });
    expect(comparison.compareRow(1)).toMatchObject({ targetIndex: 0, lane: "review", confidence: null });
  });

  it("uses explicitly selected shared identifiers even when names have changed", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Old department", code: 0 }], "code"),
      { ...dataset([{ label: "New department", foreignCode: "0" }]), idField: "foreignCode" },
    );
    expect(comparison.compareRow(0)).toMatchObject({ targetIndex: 0, lane: "strong", confidence: null });
    expect(comparison.compareRow(0).explanation).toContain("selected shared identifier matches exactly");
  });

  it("keeps identical names with contradictory shared identifiers separate", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Main office", code: "A" }], "code"),
      dataset([{ label: "Main office", code: "B" }], "code"),
    );
    expect(comparison.compareRow(0)).toMatchObject({ targetIndex: null, lane: "no-match", confidence: null });
    expect(comparison.compareRow(0).explanation).toContain("conflicts on Selected shared identifier");
  });

  it("does not compare unrelated ID columns unless both sides are selected", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Main office", code: "A" }], "code"),
      dataset([{ label: "Main office", code: "B" }]),
    );
    expect(comparison.compareRow(0).lane).toBe("review");
  });

  it.each(["AB/C", "ab-c", "00AB-C"])("preserves meaningful identifier differences: %s", (code) => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Main office", code: "AB-C" }], "code"),
      dataset([{ label: "Main office", code }], "code"),
    );
    expect(comparison.compareRow(0)).toMatchObject({ lane: "no-match", targetIndex: null });
  });

  it.each(["name", "identifier"])("preserves duplicate %s ambiguity in either dataset", (kind) => {
    const single = dataset([{ label: "Main office", code: "A" }], kind === "identifier" ? "code" : undefined);
    const duplicate = { ...single, rows: [single.rows[0], { ...single.rows[0] }] };
    expect(prepareLocalComparison(duplicate, single).compareRow(0)).toMatchObject({ targetIndex: null, lane: "review" });
    expect(prepareLocalComparison(single, duplicate).compareRow(0)).toMatchObject({ targetIndex: null, lane: "review" });
  });

  it("can resolve repeated names through a unique shared identifier", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Main office", code: "A" }, { label: "Main office", code: "B" }], "code"),
      dataset([{ label: "Main office", code: "B" }], "code"),
    );
    expect(comparison.compareRow(0)).toMatchObject({ targetIndex: 1, lane: "strong" });
  });

  it("suggests similar text for review without inventing confidence", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Northbank Medical Center" }]),
      dataset([{ label: "Northbank Medical Centre" }]),
    );
    expect(comparison.compareRow(0)).toMatchObject({ targetIndex: 0, lane: "review", confidence: null });
  });

  it("distinguishes weak overlap from absence of a local candidate", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Northbank Medical Centre" }]),
      dataset([{ label: "Northbank Industrial Supply" }, { label: "Coastal Library" }]),
    );
    expect(comparison.compareRow(0)).toMatchObject({ lane: "low", confidence: null });
    expect(comparison.compareRow(1)).toMatchObject({ lane: "no-match", targetIndex: null, confidence: null });
  });

  it("does not choose arbitrarily between equally similar candidates", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: "Northbank Medical Centre" }, { label: "Northbank Medical Centre" }]),
      dataset([{ label: "Northbank Medical Center" }]),
    );
    expect(comparison.compareRow(0)).toMatchObject({ lane: "review", targetIndex: null });
  });

  it("does not turn missing or nested values into false exact matches", () => {
    const comparison = prepareLocalComparison(
      dataset([{ label: null }, { label: { value: "Office" } }]),
      dataset([{ label: null }, { label: { value: "Office" } }]),
    );
    expect(comparison.compareRow(0)).toMatchObject({ name: "Row 1", targetIndex: null, lane: "no-match" });
    expect(comparison.compareRow(1)).toMatchObject({ targetIndex: null, lane: "no-match" });
    expect(() => comparison.compareRow(2)).toThrow(RangeError);
  });

  it("handles 10,000 duplicate names without scanning every duplicate for each row", () => {
    const rows = Array.from({ length: 10_000 }, () => ({ label: "Same label" }));
    const comparison = prepareLocalComparison(dataset(rows), dataset(rows));
    for (let index = 0; index < comparison.total; index += 1) {
      expect(comparison.compareRow(index)).toMatchObject({ lane: "review", targetIndex: null });
    }
  });

  it("keeps exact lookup complete even when text postings are large", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({ label: `Common project ${index}`, code: `${index}` }));
    const comparison = prepareLocalComparison(dataset(rows, "code"), dataset([{ label: "Renamed", code: "9999" }], "code"));
    expect(comparison.compareRow(0)).toMatchObject({ lane: "strong", targetIndex: 9999 });
    const bounded = prepareLocalComparison(dataset(rows), dataset([{ label: "Common project extension" }]));
    expect(bounded.compareRow(0).explanation).toContain("bounded candidate set");
  });
});
