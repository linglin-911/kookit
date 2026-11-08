import { buildHighlightStyleForType } from "./common";
import { windowPoint, windowRange, TxtBlockView } from "../libs/txtWindowAnchors";

export interface WindowNote {
  key: string; entityKey?: string; bindingId?: string; color: string; hasNote?: boolean;
  chapterIndex: number; txtAnchor?: { start: number; end: number };
}
interface NativeHighlight { priority: number; }
interface HighlightAPI {
  Highlight: new (...ranges: Range[]) => NativeHighlight;
  CSS: { highlights: Map<string, NativeHighlight> };
}
interface Entry { note: WindowNote; name: string; signature: string; ranges: Range[]; }
/** Chromium's native range paint preserves text nodes, selection, copy and DOM
 * budgets. Each entry owns only the mounted fragments of a binding. */
export class TxtWindowHighlights {
  private entries = new Map<string, Entry>();
  private serial = 0;
  private style: HTMLStyleElement;
  private api: HighlightAPI;
  private click?: (event: Event) => void;
  private blocks: TxtBlockView[] = [];
  constructor(private doc: Document) {
    this.api = doc.defaultView as unknown as HighlightAPI;
    if (!this.api.Highlight || !this.api.CSS?.highlights) throw Error("Native TXT highlights are unavailable");
    this.style = doc.createElement("style"); this.style.dataset.txtHighlights = "true"; doc.head.append(this.style);
    doc.addEventListener("click", this.handleClick, true);
  }
  update(notes: WindowNote[], blocks: TxtBlockView[], click: (event: Event) => void) {
    this.click = click; this.blocks = blocks;
    const active = new Set<string>();
    for (const note of notes) {
      const id = note.bindingId || note.key, parts = blocks.filter(block => block.chapter.index === note.chapterIndex && note.txtAnchor && block.end > block.chapter.bodyStart + note.txtAnchor.start && block.start < block.chapter.bodyStart + note.txtAnchor.end);
      if (!parts.length || !note.txtAnchor) continue;
      active.add(id);
      const signature = JSON.stringify([note.color, note.entityKey, note.txtAnchor, parts.map(part => [part.node.dataset.txtBlock, part.start, part.end])]);
      const old = this.entries.get(id);
      if (old?.signature === signature && old.ranges.every(range => range.startContainer.isConnected)) continue;
      const ranges = parts.map(block => windowRange([block], block.chapter.chapterId, Math.max(block.start, block.chapter.bodyStart + note.txtAnchor!.start), Math.min(block.end, block.chapter.bodyStart + note.txtAnchor!.end)));
      const name = old?.name || `koodo-txt-note-${++this.serial}`, native = new this.api.Highlight(...ranges);
      native.priority = Math.max(0, 1000000 - (note.txtAnchor.end - note.txtAnchor.start));
      this.api.CSS.highlights.set(name, native);
      this.entries.set(id, { note, name, signature, ranges });
    }
    for (const [id, entry] of this.entries) if (!active.has(id)) { this.api.CSS.highlights.delete(entry.name); this.entries.delete(id); }
    // Canonicalize colors through CSSOM; no raw SQL/renderer string enters CSS syntax.
    const rules = Array.from(this.entries.values()).map(entry => {
      const match = /^(background|underline|strikethrough|wavy)-(.+)$/.exec(entry.note.color), type = match?.[1] || "background";
      const probe = this.doc.createElement("span"); probe.style.color = match?.[2] || "#FEF3CD";
      const color = probe.style.color || "#FEF3CD";
      probe.style.cssText=buildHighlightStyleForType(`${type}-${/^#[0-9a-f]{3,8}$/i.test(match?.[2]||"")?match![2]:color}`,false,false);
      const css=["background-color","color","text-decoration","text-decoration-color","text-decoration-style","text-decoration-thickness"].map(property=>`${property}:${probe.style.getPropertyValue(property)}`).join(";");
      return `::highlight(${entry.name}){${css}}`;
    }).join("\n");
    if(this.style.textContent!==rules)this.style.textContent=rules;
  }
  private handleClick = (event: MouseEvent) => {
    if (!this.doc.getSelection()?.isCollapsed || !this.click) return;
    const caret = (this.doc as Document & { caretRangeFromPoint(x:number,y:number):Range|null }).caretRangeFromPoint(event.clientX,event.clientY);
    if (!caret) return;
    let point: ReturnType<typeof windowPoint>;
    try { point = windowPoint(this.blocks, caret.startContainer, caret.startOffset); } catch { return; }
    const rows = Array.from(this.entries.values()).filter(({note}) => note.chapterIndex === point.block.chapter.index && note.txtAnchor && point.position >= point.block.chapter.bodyStart + note.txtAnchor.start && point.position < point.block.chapter.bodyStart + note.txtAnchor.end);
    rows.sort((a,b)=>(a.note.txtAnchor!.end-a.note.txtAnchor!.start)-(b.note.txtAnchor!.end-b.note.txtAnchor!.start));
    const entry = rows[0]; if (!entry) return;
    const target = this.doc.createElement("span");
    target.dataset.key = entry.note.bindingId || entry.note.key; target.dataset.bindingId = target.dataset.key;
    target.dataset.noteKey = entry.note.entityKey || entry.note.key;
    const routed = new MouseEvent("click", { clientX: event.clientX, clientY: event.clientY });
    Object.defineProperty(routed,"target",{value:target}); this.click(routed); event.stopPropagation();
  };
  get ranges() { return Array.from(this.entries.values()).map(entry => ({ bindingId: entry.note.bindingId || entry.note.key, entityKey: entry.note.entityKey || entry.note.key, ranges: entry.ranges })); }
  destroy() { for (const entry of this.entries.values()) this.api.CSS.highlights.delete(entry.name); this.entries.clear(); this.blocks = []; this.doc.removeEventListener("click",this.handleClick,true); this.style.remove(); this.click = undefined; }
}
