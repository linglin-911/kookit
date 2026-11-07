import type Chapter from "../model/chapter";
import type ChapterDoc from "../model/chapterDoc";
import { beginDiagnostic } from "./diagnostics";

export interface ChapterWeights {
  sizes: number[];
  prefix: number[];
  total: number;
}

type WeightMode = "progress" | "pages";
const weightsCache = new WeakMap<
  ChapterDoc[],
  { length: number; progress?: ChapterWeights; pages?: ChapterWeights }
>();

/** Chapter snapshots are replaced on reparse; no source text or DOM is cached here. */
export const getChapterWeights = (
  chapters: ChapterDoc[],
  mode: WeightMode = "progress"
): ChapterWeights => {
  let cached = weightsCache.get(chapters);
  if (!cached || cached.length !== chapters.length) {
    cached = { length: chapters.length };
    weightsCache.set(chapters, cached);
  }
  const existing = cached[mode];
  if (existing) return existing;
  const finish = beginDiagnostic("Reader", "buildChapterWeights", {
    chapterCount: chapters.length,
    mode,
  });
  const sizes: number[] = [];
  const prefix: number[] = [];
  let total = 0;
  for (const chapter of chapters) {
    // Preserve the two legacy weighting rules, including their zero-size fallback.
    const text = chapter?.text;
    const size = text ? text.size || (mode === "pages" ? text.length : 0) || 1 : 1;
    prefix.push(total);
    sizes.push(size);
    total += size;
  }
  const weights = { sizes, prefix, total };
  cached[mode] = weights;
  finish({ totalWeight: total });
  return weights;
};

/** Required if a caller deliberately mutates section weights in place. */
export const invalidateChapterWeights = (chapters: ChapterDoc[]): void => {
  weightsCache.delete(chapters);
};

export const getChapterStartPercentage = (
  chapters: ChapterDoc[],
  index: number
): number => {
  const { prefix, total } = getChapterWeights(chapters);
  return total ? (prefix[index] ?? 0) / total : 0;
};

export const getRecordedPercentage = (
  chapters: ChapterDoc[],
  index: number,
  blockRatio: number
): number => {
  const { prefix, total } = getChapterWeights(chapters);
  if (!total) return 0;
  // The old formula used zero, not the fallback weight 1, for this numerator.
  const currentSize = chapters[index]?.text?.size || 0;
  return (prefix[index] ?? 0) / total + (currentSize / total) * blockRatio;
};

export const flattenChapterTree = (chapters: Chapter[]): Chapter[] => {
  const flattened: Chapter[] = [];
  const stack = [...chapters].reverse();
  while (stack.length) {
    const chapter = stack.pop()!;
    flattened.push(chapter);
    if (chapter.subitems) {
      for (let index = chapter.subitems.length - 1; index >= 0; index--) {
        stack.push(chapter.subitems[index]);
      }
    }
  }
  return flattened;
};
