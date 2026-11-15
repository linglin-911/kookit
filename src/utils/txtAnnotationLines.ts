export interface TxtAnnotationEdges {
  id: string;
  chapter: number;
  start: number;
  end: number;
  first?: Range;
  last?: Range;
}

interface VisualLine {
  position: number;
  column: number;
  height: number;
  paragraph: HTMLElement | null;
}
interface AnnotationGroup {
  ids: string[];
  first: TxtAnnotationEdges;
  last: TxtAnnotationEdges;
}

/** Paint overlapping bindings as one group. Alternate between disjoint groups
 * on the same or consecutive visual lines within a column. */
export function alternatingTxtAnnotations(doc: Document, annotations: TxtAnnotationEdges[]) {
  const alternate = new Set<string>();
  if (annotations.length < 2) return alternate;
  const view = doc.defaultView!;
  const root = doc.documentElement;
  const rootStyle = view.getComputedStyle(root);
  const vertical = rootStyle.writingMode.startsWith("vertical");
  const rtl = rootStyle.direction === "rtl";
  const backwards = rootStyle.writingMode === "vertical-rl";
  const columnWidth = parseFloat(rootStyle.columnWidth);
  const gap = parseFloat(rootStyle.columnGap) || 0;
  const available = vertical ? root.clientHeight : root.clientWidth;
  const columns = Math.max(1, Math.floor((available + gap) / (columnWidth + gap)));
  const pitch = (available + gap) / columns;
  const bounds = root.getBoundingClientRect();
  const styles = new WeakMap<Element, number>();
  const rangeRects = new WeakMap<Range, { first?: DOMRect; last?: DOMRect }>();
  const paragraphRects = new WeakMap<HTMLElement, ReturnType<typeof visibleEdges>>();

  function visibleEdges(range: Range) {
    const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    return { first: rects[0], last: rects[rects.length - 1] };
  }
  const blockPosition = (rect: DOMRect) => vertical
    ? (backwards ? -(rect.left + rect.width / 2) : rect.left + rect.width / 2)
    : rect.top + rect.height / 2;
  const measure = (range: Range, side: "first" | "last"): VisualLine | undefined => {
    let rects = rangeRects.get(range);
    if (!rects) { rects = visibleEdges(range); rangeRects.set(range, rects); }
    const rect = rects[side];
    if (!rect) return undefined;
    const node = side === "first" ? range.startContainer : range.endContainer;
    const element = (node.nodeType === 1 ? node as Element : node.parentElement) || doc.body;
    let height = styles.get(element);
    if (height === undefined) {
      const style = view.getComputedStyle(element);
      height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      styles.set(element, height);
    }
    const inlinePosition = vertical ? rect.top - bounds.top + root.scrollTop
      : rtl ? bounds.right - rect.right - root.scrollLeft : rect.left - bounds.left + root.scrollLeft;
    const column = Number.isFinite(pitch) && pitch > 0 ? Math.floor((inlinePosition + 0.5) / pitch) : 0;
    return { position: blockPosition(rect), column, height, paragraph: element.closest("p[data-txt-start]") };
  };
  const paragraphEdge = (paragraph: HTMLElement, side: "first" | "last") => {
    let edges = paragraphRects.get(paragraph);
    if (!edges) {
      const range = doc.createRange();
      range.selectNodeContents(paragraph);
      edges = visibleEdges(range);
      paragraphRects.set(paragraph, edges);
    }
    return edges[side];
  };
  const consecutive = (previous: VisualLine, next: VisualLine, tolerance: number) => {
    if (previous.paragraph && next.paragraph && previous.paragraph !== next.paragraph) {
      let sibling = previous.paragraph.nextElementSibling;
      while (sibling && view.getComputedStyle(sibling).display === "none") sibling = sibling.nextElementSibling;
      if (sibling !== next.paragraph) return false;
      const last = paragraphEdge(previous.paragraph, "last"), first = paragraphEdge(next.paragraph, "first");
      return !!last && !!first && Math.abs(previous.position - blockPosition(last)) <= tolerance &&
        Math.abs(next.position - blockPosition(first)) <= tolerance;
    }
    const height = (previous.height + next.height) / 2;
    return Math.abs(next.position - previous.position - height) <= Math.max(tolerance, height * 0.23);
  };

  const sorted = [...annotations].sort((a, b) =>
    a.chapter - b.chapter || a.start - b.start || b.end - a.end);
  const groups: AnnotationGroup[] = [];
  for (const annotation of sorted) {
    const group = groups[groups.length - 1];
    if (!group || group.last.chapter !== annotation.chapter || annotation.start >= group.last.end) {
      groups.push({ ids: [annotation.id], first: annotation, last: annotation });
      continue;
    }
    group.ids.push(annotation.id);
    if (annotation.end > group.last.end) group.last = annotation;
  }

  let previous: VisualLine | undefined;
  let previousRed = false;
  for (const group of groups) {
    const first = group.first.first && measure(group.first.first, "first");
    let red = false;
    if (first && previous && first.column === previous.column && !previousRed) {
      const tolerance = Math.min(5, first.height * 0.25);
      const distance = first.position - previous.position;
      const sameLine = first.paragraph === previous.paragraph && Math.abs(distance) <= tolerance;
      red = sameLine || (distance > tolerance && consecutive(previous, first, tolerance));
    }
    if (red) for (const id of group.ids) alternate.add(id);
    previous = group.last.last && measure(group.last.last, "last");
    previousRed = red;
  }
  return alternate;
}
