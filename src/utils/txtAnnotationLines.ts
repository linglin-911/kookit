export interface TxtAnnotationEdges {
  id: string;
  entity: string;
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
interface EndingLine {
  line: VisualLine;
  annotation: TxtAnnotationEdges;
}

/** Assign paint on the mounted layout. Only non-overlapping bindings on
 * consecutive lines can alternate. A column break or an unmarked line
 * starts a new run. */
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
  const endings = new Map<number, EndingLine[]>();
  const starts: EndingLine[] = [];

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

  for (const annotation of annotations) {
    const first = annotation.first && measure(annotation.first, "first");
    if (first) starts.push({ line: first, annotation });
    const last = annotation.last && measure(annotation.last, "last");
    if (!last) continue;
    const column = endings.get(last.column);
    if (column) column.push({ line: last, annotation });
    else endings.set(last.column, [{ line: last, annotation }]);
  }
  for (const column of endings.values()) {
    column.sort((a, b) => a.line.position - b.line.position || a.annotation.chapter - b.annotation.chapter ||
      a.annotation.end - b.annotation.end);
  }
  starts.sort((a, b) => a.annotation.chapter - b.annotation.chapter || a.annotation.start - b.annotation.start);
  for (const { annotation, line } of starts) {
    const endingsInColumn = endings.get(line.column);
    if (!endingsInColumn) continue;
    const tolerance = Math.min(5, line.height * 0.25);
    let low = 0, high = endingsInColumn.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (endingsInColumn[middle].line.position < line.position - tolerance) low = middle + 1;
      else high = middle;
    }
    if (low === 0) continue;
    const previousPosition = endingsInColumn[low - 1].line.position;
    for (let i = low - 1; i >= 0 && previousPosition - endingsInColumn[i].line.position <= tolerance; i--) {
      const previous = endingsInColumn[i];
      const prior = previous.annotation;
      if (prior.entity === annotation.entity || prior.chapter > annotation.chapter ||
        (prior.chapter === annotation.chapter && prior.end > annotation.start)) continue;
      if (!consecutive(previous.line, line, tolerance)) continue;
      if (!alternate.has(prior.id)) alternate.add(annotation.id);
      break;
    }
  }
  return alternate;
}
