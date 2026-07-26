import { describe, expect, it } from "vitest";
import { createGlossarySchema, glossaryTermSchema, updateGlossarySchema } from "./glossary";

describe("glossaryTermSchema", () => {
  it("accepts a valid term with optional notes", () => {
    const result = glossaryTermSchema.safeParse({
      term: "widget",
      translation: "artilugio",
      notes: "product-specific term",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid term without notes", () => {
    expect(glossaryTermSchema.safeParse({ term: "widget", translation: "artilugio" }).success).toBe(
      true,
    );
  });

  it("rejects an empty term or translation", () => {
    expect(glossaryTermSchema.safeParse({ term: "", translation: "artilugio" }).success).toBe(false);
    expect(glossaryTermSchema.safeParse({ term: "widget", translation: "" }).success).toBe(false);
  });
});

describe("createGlossarySchema", () => {
  const valid = {
    name: "Product terms",
    sourceLanguage: "en",
    targetLanguage: "es",
    terms: [{ term: "widget", translation: "artilugio" }],
  };

  it("accepts a fully valid glossary", () => {
    expect(createGlossarySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an empty terms array", () => {
    const result = createGlossarySchema.safeParse({ ...valid, terms: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a missing name/sourceLanguage/targetLanguage", () => {
    expect(createGlossarySchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(createGlossarySchema.safeParse({ ...valid, sourceLanguage: "" }).success).toBe(false);
    expect(createGlossarySchema.safeParse({ ...valid, targetLanguage: "" }).success).toBe(false);
  });
});

describe("updateGlossarySchema", () => {
  it("accepts a partial update with only one field", () => {
    expect(updateGlossarySchema.safeParse({ name: "Renamed glossary" }).success).toBe(true);
  });

  it("accepts an empty object (no-op update)", () => {
    expect(updateGlossarySchema.safeParse({}).success).toBe(true);
  });

  it("still rejects an explicitly empty terms array", () => {
    expect(updateGlossarySchema.safeParse({ terms: [] }).success).toBe(false);
  });
});
