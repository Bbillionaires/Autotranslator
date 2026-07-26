"use client";

/**
 * Glossary management UI — Phase 7 ("glossary management UI (CRUD against Phase 4's
 * `glossaryRepository`/Zod schemas — build the missing Server Actions + UI now)"). Wired to
 * `src/server/actions/glossary.ts`, all Session+Role(Manager+) (this page is already gated
 * at Administrator+, a strict superset, but the actions re-check independently regardless).
 */
import { useEffect, useState, useTransition } from "react";
import { createGlossary, deleteGlossary, listGlossaries } from "@/server/actions/glossary";
import type { TranslationGlossaryRecord } from "@/server/repositories/glossaryRepository";

export function GlossarySection() {
  const [glossaries, setGlossaries] = useState<TranslationGlossaryRecord[] | null>(null);
  const [name, setName] = useState("");
  const [sourceLanguage, setSourceLanguage] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("");
  const [term, setTerm] = useState("");
  const [translation, setTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await listGlossaries();
      if (result.ok) {
        setGlossaries(result.data);
      } else {
        setError(result.message);
      }
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createGlossary({
        name,
        sourceLanguage,
        targetLanguage,
        terms: [{ term, translation }],
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setName("");
      setSourceLanguage("");
      setTargetLanguage("");
      setTerm("");
      setTranslation("");
      refresh();
    });
  }

  function handleDelete(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteGlossary({ id });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      refresh();
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-semibold text-foreground">Translation glossaries</h2>
      <p className="text-sm text-muted">
        Glossary terms are merged into every translation call for the matching source→target language pair (e.g.
        product names, brand terms) so they&rsquo;re never mistranslated.
      </p>

      <ul className="flex flex-col gap-2">
        {(glossaries ?? []).map((glossary) => (
          <li key={glossary.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
            <div>
              <span className="font-medium text-foreground">{glossary.name}</span>{" "}
              <span className="text-xs text-muted">
                ({glossary.sourceLanguage} → {glossary.targetLanguage}, {glossary.terms.length} term
                {glossary.terms.length === 1 ? "" : "s"})
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleDelete(glossary.id)}
              disabled={isPending}
              className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
            >
              Delete
            </button>
          </li>
        ))}
        {glossaries && glossaries.length === 0 && <li className="text-sm text-muted">No glossaries yet.</li>}
      </ul>

      <form onSubmit={handleCreate} className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="glossary-name" className="text-xs font-medium text-muted">
            Glossary name
          </label>
          <input
            id="glossary-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="glossary-source" className="text-xs font-medium text-muted">
              Source language
            </label>
            <input
              id="glossary-source"
              required
              value={sourceLanguage}
              onChange={(e) => setSourceLanguage(e.target.value)}
              placeholder="es"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="glossary-target" className="text-xs font-medium text-muted">
              Target language
            </label>
            <input
              id="glossary-target"
              required
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              placeholder="en"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="glossary-term" className="text-xs font-medium text-muted">
            Term
          </label>
          <input
            id="glossary-term"
            required
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="glossary-translation" className="text-xs font-medium text-muted">
            Translation
          </label>
          <input
            id="glossary-translation"
            required
            value={translation}
            onChange={(e) => setTranslation(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        {error && <p className="text-sm text-danger sm:col-span-2">{error}</p>}
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Add glossary"}
          </button>
        </div>
      </form>
    </section>
  );
}
