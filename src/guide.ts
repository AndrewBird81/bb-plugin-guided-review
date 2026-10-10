import { z } from "zod";

export const DiffRefSchema = z.object({ file: z.string().min(1), summary: z.string().min(1) });
export const SectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  overview: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]).optional(),
  diffs: z.array(DiffRefSchema),
});
export const GuideSchema = z.object({
  title: z.string().min(1),
  intent: z.string().min(1),
  sections: z.array(SectionSchema),
  unplacedFiles: z.array(z.string()),
  /** What changed since the reviewer's last review, on a re-review. */
  sinceReview: z.string().optional(),
  review: z.object({ gitRef: z.string().min(1), base: z.string().optional() }).optional(),
  source: z.unknown().optional(),
  generator: z.unknown().optional(),
});
export type Guide = z.infer<typeof GuideSchema>;

export function validateGuide(raw: unknown):
  | { ok: true; guide: Guide }
  | { ok: false; errors: string[] } {
  const parsed = GuideSchema.safeParse(raw);
  if (parsed.success) return { ok: true, guide: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export function checkCoverage(guide: Guide, files: string[]):
  | { ok: true }
  | { ok: false; errors: string[] } {
  const placed = new Map<string, number>();
  for (const s of guide.sections) for (const d of s.diffs) placed.set(d.file, (placed.get(d.file) ?? 0) + 1);
  for (const f of guide.unplacedFiles) placed.set(f, (placed.get(f) ?? 0) + 1);

  const errors: string[] = [];
  const fileSet = new Set(files);
  for (const [file, count] of placed) {
    if (!fileSet.has(file)) errors.push(`extra: ${file} is in the guide but not in the diff`);
    else if (count > 1) errors.push(`duplicate: ${file} appears ${count} times`);
  }
  for (const f of files) if (!placed.has(f)) errors.push(`missing: ${f} is in the diff but not in the guide`);
  return errors.length ? { ok: false, errors } : { ok: true };
}
