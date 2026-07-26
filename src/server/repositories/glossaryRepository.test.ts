import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../errors";

const prismaMock = {
  translationGlossary: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
};

vi.mock("../db", () => ({ prisma: prismaMock }));

const { glossaryRepository } = await import("./glossaryRepository");

const baseRow = {
  id: "gloss_1",
  organizationId: "org_1",
  name: "Product terms",
  sourceLanguage: "en",
  targetLanguage: "es",
  terms: [{ term: "widget", translation: "artilugio" }],
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("glossaryRepository.list", () => {
  it("scopes the query to organizationId and parses stored terms", async () => {
    prismaMock.translationGlossary.findMany.mockResolvedValue([baseRow]);
    const result = await glossaryRepository.list("org_1");
    expect(prismaMock.translationGlossary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org_1" } }),
    );
    expect(result[0].terms).toEqual([{ term: "widget", translation: "artilugio" }]);
  });
});

describe("glossaryRepository.findByIdOrThrow", () => {
  it("returns the parsed record when found", async () => {
    prismaMock.translationGlossary.findFirst.mockResolvedValue(baseRow);
    const result = await glossaryRepository.findByIdOrThrow("org_1", "gloss_1");
    expect(result.name).toBe("Product terms");
  });

  it("throws NotFoundError when no row matches (wrong org or unknown id)", async () => {
    prismaMock.translationGlossary.findFirst.mockResolvedValue(null);
    await expect(glossaryRepository.findByIdOrThrow("org_1", "missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("glossaryRepository.create", () => {
  it("passes the org id and input through to prisma.create", async () => {
    prismaMock.translationGlossary.create.mockResolvedValue(baseRow);
    await glossaryRepository.create("org_1", {
      name: "Product terms",
      sourceLanguage: "en",
      targetLanguage: "es",
      terms: [{ term: "widget", translation: "artilugio" }],
    });
    expect(prismaMock.translationGlossary.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org_1",
        name: "Product terms",
        sourceLanguage: "en",
        targetLanguage: "es",
        terms: [{ term: "widget", translation: "artilugio" }],
      },
    });
  });
});

describe("glossaryRepository.update", () => {
  it("re-asserts organizationId in the update's where clause", async () => {
    prismaMock.translationGlossary.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.translationGlossary.findFirst.mockResolvedValue(baseRow);
    await glossaryRepository.update("org_1", "gloss_1", { name: "Renamed" });
    expect(prismaMock.translationGlossary.updateMany).toHaveBeenCalledWith({
      where: { id: "gloss_1", organizationId: "org_1" },
      data: { name: "Renamed" },
    });
  });

  it("throws NotFoundError when the row doesn't belong to this org (count 0)", async () => {
    prismaMock.translationGlossary.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      glossaryRepository.update("org_1", "gloss_1", { name: "Renamed" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("glossaryRepository.delete", () => {
  it("throws NotFoundError when nothing was deleted", async () => {
    prismaMock.translationGlossary.deleteMany.mockResolvedValue({ count: 0 });
    await expect(glossaryRepository.delete("org_1", "gloss_1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves cleanly when a row was deleted", async () => {
    prismaMock.translationGlossary.deleteMany.mockResolvedValue({ count: 1 });
    await expect(glossaryRepository.delete("org_1", "gloss_1")).resolves.toBeUndefined();
  });
});

describe("glossaryRepository.findApplicableTerms", () => {
  it("queries by org + source + target language and flattens terms across matching rows", async () => {
    prismaMock.translationGlossary.findMany.mockResolvedValue([
      { ...baseRow, terms: [{ term: "widget", translation: "artilugio" }] },
      { ...baseRow, id: "gloss_2", terms: [{ term: "gadget", translation: "aparato" }] },
    ]);

    const terms = await glossaryRepository.findApplicableTerms("org_1", "en", "es");

    expect(prismaMock.translationGlossary.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org_1", sourceLanguage: "en", targetLanguage: "es" },
    });
    expect(terms).toEqual([
      { term: "widget", translation: "artilugio" },
      { term: "gadget", translation: "aparato" },
    ]);
  });

  it("silently filters out malformed entries in the stored Json terms array", async () => {
    prismaMock.translationGlossary.findMany.mockResolvedValue([
      { ...baseRow, terms: [{ term: "widget", translation: "artilugio" }, { garbage: true }, "oops"] },
    ]);
    const terms = await glossaryRepository.findApplicableTerms("org_1", "en", "es");
    expect(terms).toEqual([{ term: "widget", translation: "artilugio" }]);
  });

  it("returns an empty array when no glossary matches the language pair", async () => {
    prismaMock.translationGlossary.findMany.mockResolvedValue([]);
    expect(await glossaryRepository.findApplicableTerms("org_1", "en", "de")).toEqual([]);
  });
});
