import type { PersistentTxtChapter } from "./txtIndex";

export interface TxtBlockView { node: HTMLElement; chapter: PersistentTxtChapter; start: number; end: number; text: string; }
const textNodes = (root: HTMLElement) => {
  const result: Text[] = [], walker = root.ownerDocument.createTreeWalker(root, 4);
  while (walker.nextNode()) result.push(walker.currentNode as Text);
  return result;
};
export function verifyBlock(block: TxtBlockView) {
  const nodes = textNodes(block.node);
  if (nodes.map(node => node.data).join("") !== block.text) throw Error("Text transformations changed source positions");
  return nodes;
}
export function windowPoint(blocks: TxtBlockView[], node: Node, offset: number) {
  const block = blocks.find(block => block.node === node || block.node.contains(node));
  if (!block) throw Error("Selection is outside mounted TXT source");
  verifyBlock(block);
  const range = block.node.ownerDocument.createRange(); range.selectNodeContents(block.node); range.setEnd(node, offset);
  const position = block.start + range.toString().length;
  const local = position - block.start;
  if (local > 0 && local < block.text.length && /[\uDC00-\uDFFF]/.test(block.text[local]) && /[\uD800-\uDBFF]/.test(block.text[local - 1])) throw Error("TXT point splits a surrogate pair");
  return { block, position };
}
export function windowRange(blocks: TxtBlockView[], chapterId: string, start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw Error("Invalid TXT range");
  const chapterBlocks = blocks.filter(block => block.chapter.chapterId === chapterId);
  const resolve = (position: number, last: boolean) => {
    const candidates = chapterBlocks.filter(block => block.start <= position && block.end >= position);
    const block = last ? candidates[0] : candidates[candidates.length - 1];
    if (!block) throw Error("TXT source interval is unavailable");
    const nodes = verifyBlock(block); let remaining = position - block.start;
    for (const node of nodes) {
      if (remaining <= node.length) {
        windowPoint(blocks, node, remaining); return { node: node as Node, offset: remaining };
      }
      remaining -= node.length;
    }
    if (remaining === 0) return { node: block.node as Node, offset: 0 };
    throw Error("TXT source point is unavailable");
  };
  // A Range must not silently bridge unloaded source.
  const covered = chapterBlocks.filter(block => block.end > start && block.start < end).sort((a,b)=>a.start-b.start);
  let next = start;
  for (const block of covered) { if (block.start > next) throw Error("TXT source gap is not mounted"); verifyBlock(block); next = Math.max(next, block.end); }
  if (next < end) throw Error("TXT source gap is not mounted");
  const first = resolve(start, false), last = resolve(end, true), range = first.node.ownerDocument!.createRange();
  range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset); return range;
}
export function selectedWindowAnchor(doc: Document, blocks: TxtBlockView[]) {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) throw Error("Select source text first");
  const range = selection.getRangeAt(0), first = windowPoint(blocks, range.startContainer, range.startOffset), last = windowPoint(blocks, range.endContainer, range.endOffset);
  const chapter = first.block.chapter;
  if (last.block.chapter.chapterId !== chapter.chapterId) throw Error("A text binding must stay within one chapter");
  if (first.position < chapter.bodyStart || last.position <= first.position) throw Error("Select chapter body text");
  windowRange(blocks, chapter.chapterId, first.position, last.position);
  return { chapterIndex: chapter.index, chapterId: chapter.chapterId, start: first.position - chapter.bodyStart, end: last.position - chapter.bodyStart };
}
