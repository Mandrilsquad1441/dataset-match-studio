import { describe, expect, it } from "vitest";
import { previewJsonFile } from "./file-preview";

describe("streamed JSON previews", () => {
  it("reads only the requested top-level array rows", async () => {
    const file = new Blob([JSON.stringify(Array.from({ length: 40 }, (_, id) => ({ id, nested: { value: id } })))]);
    const rows = await previewJsonFile(file, 8);
    expect(rows).toHaveLength(8);
    expect(rows[7]).toEqual({ id: 7, nested: { value: 7 } });
  });

  it("previews records arrays inside a JSON wrapper", async () => {
    const file = new Blob([JSON.stringify({ metadata: { source: "sample" }, records: [{ label: "A" }, { label: "B" }] })]);
    expect(await previewJsonFile(file)).toEqual([{ label: "A" }, { label: "B" }]);
  });
});
