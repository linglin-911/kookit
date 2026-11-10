import { buildHighlightStyleForType } from "./common";
import { textBand, hitsText } from "./textHitGeometry";
import { windowPoint, windowRange, TxtBlockView } from "../libs/txtWindowAnchors";

export interface WindowNote {
  key: string; entityKey?: string; bindingId?: string; color: string; hasNote?: boolean;
  chapterIndex: number; txtAnchor?: { start: number; end: number };
}
const SELECTION_CSS = "html[data-compact-selection] ::selection{background-color:transparent !important;}\n";
interface NativeHighlight { priority: number; add(range: Range): void; delete(range: Range): void; }
interface HighlightAPI {
  Highlight: new (...ranges: Range[]) => NativeHighlight;
  CSS: { highlights: Map<string, NativeHighlight> };
}
interface Entry { note: WindowNote; group: string; parts: TxtBlockView[]; ranges: Range[]; }
interface CachedRange { range: Range; references: number; }
interface PaintGroup { name: string; color: string; native: NativeHighlight; references: number; ranges: Map<Range, number>; }
/** Chromium's native range paint preserves text nodes, selection, copy and DOM
 * budgets. Each entry owns only the mounted fragments of a binding. */
export class TxtWindowHighlights {
  private entries = new Map<string, Entry>();
  private serial = 0;
  private revision = 0;
  private stylesDirty = false;
  private groups = new Map<string, PaintGroup>();
  private rangeCache = new WeakMap<HTMLElement, Map<string, CachedRange>>();
  private style: HTMLStyleElement;
  private api: HighlightAPI;
  private selectionPaint: SVGSVGElement;
  private selectionPath: SVGPathElement;
  private previousIsolation: string;
  private click?: (event: Event) => void;
  private blocks: TxtBlockView[] = [];
  constructor(private doc: Document) {
    this.api = doc.defaultView as unknown as HighlightAPI;
    if (!this.api.Highlight || !this.api.CSS?.highlights) throw Error("Native TXT highlights are unavailable");
    this.style = doc.createElement("style"); this.style.dataset.txtHighlights = "true"; doc.head.append(this.style);
    this.style.textContent = SELECTION_CSS;
    this.previousIsolation = doc.body.style.isolation;
    doc.body.style.isolation = "isolate";
    this.selectionPaint = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.selectionPaint.dataset.txtSelection = "true";
    this.selectionPaint.setAttribute("aria-hidden", "true");
    this.selectionPaint.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:0;";
    this.selectionPath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    this.selectionPath.setAttribute("fill", "#f3a6a68c");
    this.selectionPaint.append(this.selectionPath);
    doc.body.append(this.selectionPaint);
    doc.addEventListener("click", this.handleClick, true);
  }
  async update(notes: WindowNote[], blocks: TxtBlockView[], click: (event: Event) => void) {
    const revision = ++this.revision;
    let processed = 0, chunkStarted = performance.now();
    this.click = click; this.blocks = blocks;
    const active = new Set<string>();
    // Prune replaced datasets before adding new IDs. Otherwise repeatedly
    // superseded paints could accumulate partial datasets until scrolling stops.
    const requested = new Set(notes.map(note => note.bindingId || note.key));
    for (const [id, entry] of this.entries) {
      if (++processed % 256 === 0 && performance.now() - chunkStarted >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (revision !== this.revision) return;
        chunkStarted = performance.now();
      }
      if (!requested.has(id)) { this.release(entry); this.entries.delete(id); }
    }
    for (const note of notes) {
      if (++processed % 256 === 0 && performance.now() - chunkStarted >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (revision !== this.revision) return;
        chunkStarted = performance.now();
      }
      const id = note.bindingId || note.key, parts = blocks.filter(block => block.chapter.index === note.chapterIndex && note.txtAnchor && block.end > block.chapter.bodyStart + note.txtAnchor.start && block.start < block.chapter.bodyStart + note.txtAnchor.end);
      if (!parts.length || !note.txtAnchor) continue;
      active.add(id);
      const old = this.entries.get(id);
      // Removing a block relocates live Range endpoints to a connected parent.
      // A matching block key and isConnected alone can therefore retain an empty
      // highlight after revisiting the same source coordinates.
      if (old && old.note.color === note.color && old.note.entityKey === note.entityKey &&
          old.note.chapterIndex === note.chapterIndex &&
          old.note.txtAnchor?.start === note.txtAnchor.start && old.note.txtAnchor?.end === note.txtAnchor.end &&
          old.parts.length === parts.length && old.parts.every((part, index) =>
            part.node === parts[index].node && part.start === parts[index].start && part.end === parts[index].end) &&
          old.ranges.every((range, index) => !range.collapsed &&
            parts[index].node.contains(range.startContainer) &&
            parts[index].node.contains(range.endContainer))) { old.note = note; continue; }
      const ranges = parts.map(block => this.rangeFor(block, Math.max(block.start, block.chapter.bodyStart + note.txtAnchor!.start), Math.min(block.end, block.chapter.bodyStart + note.txtAnchor!.end)));
      if (old) this.release(old);
      const priority = Math.max(0, 1000000 - (note.txtAnchor.end - note.txtAnchor.start));
      const groupKey = JSON.stringify([note.color, priority]);
      let group = this.groups.get(groupKey);
      if (!group) {
        const native = new this.api.Highlight(); native.priority = priority;
        group = { name: `koodo-txt-note-${++this.serial}`, color: note.color, native, references: 0, ranges: new Map() };
        this.groups.set(groupKey, group); this.api.CSS.highlights.set(group.name, native); this.stylesDirty = true;
      }
      // Equal-style/equal-priority paint shares one Chromium object and CSS rule.
      // Each relationship retains its own exact ranges and click identity.
      for (const range of ranges) {
        const references = group.ranges.get(range) || 0;
        if (!references) group.native.add(range);
        group.ranges.set(range, references + 1);
      }
      group.references++;
      this.entries.set(id, { note, group: groupKey, parts, ranges });
    }
    for (const [id, entry] of this.entries) {
      if (++processed % 256 === 0 && performance.now() - chunkStarted >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (revision !== this.revision) return;
        chunkStarted = performance.now();
      }
      if (!active.has(id)) { this.release(entry); this.entries.delete(id); }
    }
    for (const [key, group] of this.groups) if (!group.references) {
      this.api.CSS.highlights.delete(group.name); this.groups.delete(key); this.stylesDirty = true;
    }
    if (!this.stylesDirty) return;
    // Canonicalize colors through CSSOM; no raw SQL/renderer string enters CSS syntax.
    const rules = SELECTION_CSS + Array.from(this.groups.values()).map(group => {
      const match = /^(background|underline|strikethrough|wavy|dotted)-(.+)$/.exec(group.color), type = match?.[1] || "background";
      const probe = this.doc.createElement("span"); probe.style.color = match?.[2] || "#FEF3CD";
      const color = probe.style.color || "#FEF3CD";
      probe.style.cssText=buildHighlightStyleForType(`${type}-${/^#[0-9a-f]{3,8}$/i.test(match?.[2]||"")?match![2]:color}`,false,false);
      const css=["background-color","color","text-decoration","text-decoration-color","text-decoration-style","text-decoration-thickness","text-underline-offset","text-decoration-skip-ink"].map(property=>`${property}:${probe.style.getPropertyValue(property)}`).join(";");
      return `::highlight(${group.name}){${css}}`;
    }).join("\n");
    if(this.style.textContent!==rules)this.style.textContent=rules;
    this.stylesDirty = false;
  }
  private rangeFor(block: TxtBlockView, start: number, end: number) {
    let cached = this.rangeCache.get(block.node);
    if (!cached) { cached = new Map(); this.rangeCache.set(block.node, cached); }
    const key = `${start}:${end}`, previous = cached.get(key);
    if (previous && !previous.range.collapsed && block.node.contains(previous.range.startContainer) && block.node.contains(previous.range.endContainer)) {
      previous.references++; return previous.range;
    }
    const range = windowRange([block], block.chapter.chapterId, start, end);
    cached.set(key, { range, references: 1 }); return range;
  }
  private release(entry: Entry) {
    const group = this.groups.get(entry.group);
    if (!group) return;
    for (const [index, range] of entry.ranges.entries()) {
      const block = entry.parts[index], anchor = entry.note.txtAnchor!;
      const key = `${Math.max(block.start, block.chapter.bodyStart + anchor.start)}:${Math.min(block.end, block.chapter.bodyStart + anchor.end)}`;
      const cached = this.rangeCache.get(block.node), shared = cached?.get(key);
      if (shared?.range === range && --shared.references === 0) {
        cached!.delete(key); if (!cached!.size) this.rangeCache.delete(block.node);
      }
      const references = (group.ranges.get(range) || 1) - 1;
      if (references) group.ranges.set(range, references);
      else { group.ranges.delete(range); group.native.delete(range); }
    }
    if (--group.references === 0) {
      this.api.CSS.highlights.delete(group.name); this.groups.delete(entry.group); this.stylesDirty = true;
    }
  }
  // Called from the window manager's existing coalesced frame for selection,
  // scroll, layout and font changes. One SVG path, no per-character DOM wrappers.
  updateSelection() {
    const selection = this.doc.getSelection();
    let path = "";
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      const element = range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
      const maxHeight = parseFloat(this.doc.defaultView!.getComputedStyle(element || this.doc.body).fontSize) * 2;
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height || rect.height > maxHeight) continue;
        const band = textBand(rect);
        const x = band.left + this.doc.defaultView!.scrollX, y = band.top + this.doc.defaultView!.scrollY;
        path += `M${x},${y}h${band.width}v${band.height}h${-band.width}Z`;
      }
    }
    if (this.selectionPath.getAttribute("d") !== path) this.selectionPath.setAttribute("d", path);
    if (path) {
      if (!this.doc.documentElement.hasAttribute("data-compact-selection")) this.doc.documentElement.setAttribute("data-compact-selection", "");
    }
    else if (this.doc.documentElement.hasAttribute("data-compact-selection")) this.doc.documentElement.removeAttribute("data-compact-selection");
  }
  private handleClick = (event: MouseEvent) => {
    if (!this.doc.getSelection()?.isCollapsed || !this.click) return;
    const caret = (this.doc as Document & { caretRangeFromPoint(x:number,y:number):Range|null }).caretRangeFromPoint(event.clientX,event.clientY);
    if (!caret) return;
    let point: ReturnType<typeof windowPoint>;
    try { point = windowPoint(this.blocks, caret.startContainer, caret.startOffset); } catch { return; }
    const rows = Array.from(this.entries.values()).filter(({note}) => note.chapterIndex === point.block.chapter.index && note.txtAnchor && point.position >= point.block.chapter.bodyStart + note.txtAnchor.start && point.position <= point.block.chapter.bodyStart + note.txtAnchor.end)
      // Caret APIs round to the nearest insertion edge. The inclusive coarse
      // interval admits the last glyph's right half; rectangles reject the
      // preceding glyph's right half and the trimmed vertical margins.
      .filter(entry => entry.ranges.some(range => Array.from(range.getClientRects()).some(rect => hitsText(rect, event.clientX, event.clientY))));
    rows.sort((a,b)=>(a.note.txtAnchor!.end-a.note.txtAnchor!.start)-(b.note.txtAnchor!.end-b.note.txtAnchor!.start));
    const entry = rows[0]; if (!entry) return;
    const target = this.doc.createElement("span");
    target.dataset.key = entry.note.bindingId || entry.note.key; target.dataset.bindingId = target.dataset.key;
    target.dataset.noteKey = entry.note.entityKey || entry.note.key;
    const routed = new MouseEvent("click", { clientX: event.clientX, clientY: event.clientY });
    Object.defineProperty(routed,"target",{value:target}); this.click(routed); event.stopPropagation();
  };
  get ranges() { return Array.from(this.entries.values()).map(entry => ({ bindingId: entry.note.bindingId || entry.note.key, entityKey: entry.note.entityKey || entry.note.key, ranges: entry.ranges })); }
  destroy() { this.revision++; for (const group of this.groups.values()) this.api.CSS.highlights.delete(group.name); this.groups.clear(); this.entries.clear(); this.rangeCache = new WeakMap(); this.blocks = []; this.doc.removeEventListener("click",this.handleClick,true); this.style.remove(); this.selectionPaint.remove(); this.doc.documentElement.removeAttribute("data-compact-selection"); this.doc.body.style.isolation = this.previousIsolation; this.click = undefined; }
}
