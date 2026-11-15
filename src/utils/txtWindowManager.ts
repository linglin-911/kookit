import { TxtTextLRU } from "./txtResources";
import type { TxtBlockView } from "../libs/txtWindowAnchors";
import type { PersistentTxtChapter } from "../libs/txtIndex";
import type { TxtCheckpoint } from "../libs/txtBlocks";
export const TXT_WINDOW_BUDGET = { chapters: 24, blocks: 24, characters: 128 * 1024, nodes: 20000 };
export interface TxtWindowBlock {
    chapter: number;
    byteStart: number;
    byteEnd: number;
    start: number;
    end: number;
}
interface Mounted {
    block: TxtWindowBlock;
    node: HTMLElement;
    text: string;
}
interface Options {
    doc: Document;
    iframe: HTMLIFrameElement;
    element: HTMLElement;
    chapters: PersistentTxtChapter[];
    checkpoints: TxtCheckpoint[];
    generation: string | null;
    read: (chapter: PersistentTxtChapter, offset: number, length: number) => Promise<Uint8Array>;
    encoding: string;
    changed: (position: {
        chapter: number;
        offset: number;
        chapterId: string;
        generation: string | null;
    }) => void;
    windowChanged?: () => void;
    reflowHighlights?: () => void;
    paintSelection?: () => void;
    error: (error: unknown) => void;
}
/** One owner, one in-flight range, bounded decoded-text LRU and no Blob/HTML cache. The sparse directory is
 * metadata only; a deep chapter/block jump never decodes preceding source. */
export class TxtWindowManager {
    private blocks: TxtWindowBlock[] = [];
    private chapterBlocks: number[] = [];
    private mounted: Mounted[] = [];
    private token = 0;
    private lastWindow = "";
    private mountEpoch = 0;
    private dead = false;
    private frame = 0;
    private busy = false;
    private again = false;
    private observer: ResizeObserver;
    private anchor?: {
        node: Text;
        offset: number;
        top: number;
    };
    private root: HTMLElement;
    private needsHighlightReflow = false;
    private layoutSize = { width: 0, height: 0 };
    private reads: Promise<unknown> = Promise.resolve();
    private cache = new TxtTextLRU(512 * 1024);
    private activeReads = 0;
    selectionLimited = false;
    constructor(private options: Options) {
        const { chapters, checkpoints, doc, element } = options;
        let point = 0;
        for (const chapter of chapters) {
            this.chapterBlocks.push(this.blocks.length);
            while (point < checkpoints.length && checkpoints[point][0] <= chapter.byteStart)
                point++;
            let byteStart = chapter.byteStart, start = chapter.start;
            for (let i = point; i < checkpoints.length && checkpoints[i][0] < chapter.byteEnd; i++) {
                const [byteEnd, end] = checkpoints[i];
                this.blocks.push({ chapter: chapter.index, byteStart, byteEnd, start, end });
                byteStart = byteEnd;
                start = end;
            }
            this.blocks.push({ chapter: chapter.index, byteStart, byteEnd: chapter.byteEnd, start, end: chapter.end });
        }
        this.root = doc.createElement("main");
        this.root.dataset.txtWindow = "true";
        this.root.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;overflow-anchor:none;position:relative;z-index:1";
        doc.body.style.overflowAnchor = "none";
        element.style.overflowAnchor = "none";
        this.root.style.paddingBottom = element.clientHeight + "px";
        doc.body.append(this.root);
        element.addEventListener("scroll", this.schedule, { passive: true });
        doc.addEventListener("selectionchange", this.schedule);
        this.observer = new ResizeObserver(this.layoutChanged);
        this.observer.observe(element);
        this.observer.observe(this.root);
        doc.fonts?.addEventListener("loadingdone", this.layoutChanged);
    }
    private rect(m: Mounted) { return m.node.getBoundingClientRect(); }
    private viewport() { return this.options.element.scrollTop; }
    private visible() {
        const top = this.viewport();
        return this.mounted.find(m => this.rect(m).bottom > top + 1) || this.mounted[this.mounted.length - 1];
    }
    private capture() {
        const m = this.visible();
        if (!m)
            return undefined;
        const doc = this.options.doc;
        const caret = (doc as Document & {
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
        })
            .caretRangeFromPoint?.(Math.max(1, this.root.getBoundingClientRect().left + 8), this.viewport() + 2);
        if (caret?.startContainer.nodeType === 3 && this.root.contains(caret.startContainer)) {
            const range = caret.cloneRange();
            range.setEnd(caret.startContainer, Math.min((caret.startContainer.textContent || "").length, caret.startOffset + 1));
            return { node: caret.startContainer as Text, offset: caret.startOffset, top: range.getBoundingClientRect().top - this.viewport() };
        }
        const node = m.node.firstChild as Text;
        if (!node || node.nodeType !== 3)
            return undefined;
        const range = doc.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(1, node.length));
        return { node, offset: 0, top: range.getBoundingClientRect().top - this.viewport() };
    }
    private compensate(anchor = this.anchor) {
        if (!anchor?.node.isConnected)
            return;
        const range = this.options.doc.createRange();
        range.setStart(anchor.node, anchor.offset);
        range.setEnd(anchor.node, Math.min(anchor.node.length, anchor.offset + 1));
        this.options.element.scrollTop += range.getBoundingClientRect().top - this.viewport() - anchor.top;
    }
    private layoutChanged = () => {
        if (this.dead)
            return;
        this.root.style.paddingBottom = this.options.element.clientHeight + "px";
        this.height();
        this.compensate();
        this.needsHighlightReflow = true;
        this.schedule();
    };
    private height() {
        const rect = this.root.getBoundingClientRect();
        this.layoutSize = { width: rect.width, height: rect.height };
        this.options.iframe.style.height = Math.ceil(rect.height) + "px";
    }
    private emitPosition() {
        // A queued scroll/rAF or explicit record can run before ResizeObserver.
        // Compensate the old text anchor before sampling the newly reflowed layout.
        const rect = this.root.getBoundingClientRect();
        if (rect.width !== this.layoutSize.width || rect.height !== this.layoutSize.height) {
            this.height(); this.compensate();
        }
        this.anchor = this.capture();
        const m = (this.anchor && this.mounted.find(item => item.node.contains(this.anchor!.node))) || this.visible();
        if (!m) return;
        const range = this.options.doc.createRange();
        range.selectNodeContents(m.node);
        let offset = m.block.start;
        if (this.anchor && m.node.contains(this.anchor.node)) {
            range.setEnd(this.anchor.node, this.anchor.offset);
            offset += range.toString().length;
        }
        const chapter = this.options.chapters[m.block.chapter];
        this.options.changed({ chapter: chapter.index, chapterId: chapter.chapterId, offset: offset - chapter.start, generation: this.options.generation });
    }
    private schedule = () => {
        if (this.dead || this.frame)
            return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.emitPosition();
            this.options.paintSelection?.();
            if (this.needsHighlightReflow) {
                this.needsHighlightReflow = false;
                this.options.reflowHighlights?.();
            }
            void this.fill().catch(this.options.error);
        });
    };
    private readText(index: number, valid: () => boolean): Promise<string | undefined> {
        const request = this.reads.then(async () => {
            if (this.dead || !valid()) return undefined;
            const hit = this.cache.get(index);
            if (hit !== undefined) return hit;
            const block = this.blocks[index], chapter = this.options.chapters[block.chapter];
            this.activeReads++;
            try {
                const bytes = await this.options.read(chapter, block.byteStart - chapter.byteStart, block.byteEnd - block.byteStart);
                if (this.dead || !valid()) return undefined;
                if (bytes.length !== block.byteEnd - block.byteStart) throw Error("Incomplete TXT window block");
                const text = new TextDecoder(this.options.encoding, { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, "\n");
                if (text.length !== block.end - block.start) throw Error("TXT window block coordinates changed");
                this.cache.set(index, text);
                return text;
            } finally { this.activeReads--; }
        });
        this.reads = request.then(() => undefined, () => undefined);
        return request;
    }
    private async load(index: number, token: number) {
        let text: string | undefined;
        try { text = await this.readText(index, () => token === this.token); }
        catch (error) { if (this.dead || token !== this.token) return; throw error; }
        if (text === undefined || this.dead || token !== this.token) return;
        const block = this.blocks[index];
        const node = this.options.doc.createElement("span");
        node.dataset.txtBlock = String(index);
        node.dataset.txtStart = String(block.start);
        node.dataset.txtEnd = String(block.end);
        node.textContent = text;
        return { block, node, text };
    }
    private chapterNode(chapter: number) {
        const id = this.options.chapters[chapter].chapterId;
        let node = Array.from(this.root.children).find(n => (n as HTMLElement).dataset.chapterId === id) as HTMLElement | undefined;
        if (!node) {
            node = this.options.doc.createElement("section");
            node.dataset.chapterId = id;
            node.dataset.chapterIndex = String(chapter);
            // Inline sections keep native cross-chapter selection text free of invented newlines.
            node.style.display = "inline";
            const current = this.options.chapters[chapter], previous = this.options.chapters[chapter - 1];
            if (previous && current.start > previous.end) {
                const separator = this.options.doc.createElement("span");
                separator.dataset.txtSeparator = "true";
                separator.textContent = "\n".repeat(current.start - previous.end);
                node.append(separator);
            }
            const next = Array.from(this.root.children).find(n => Number((n as HTMLElement).dataset.chapterIndex) > chapter);
            this.root.insertBefore(node, next || null);
        }
        return node;
    }
    private mount(m: Mounted) {
        const anchor = this.capture();
        const next = this.mounted.find(other => Number(other.node.dataset.txtBlock) > Number(m.node.dataset.txtBlock));
        const parent = this.chapterNode(m.block.chapter);
        parent.insertBefore(m.node, next?.node.parentElement === parent ? next.node : null);
        // A sparse chapter window may begin in the middle of a chapter. Its preceding
        // separator belongs only to a mounted first block, never to a mid-chapter block.
        const separator = parent.querySelector<HTMLElement>("[data-txt-separator]");
        if (separator)
            separator.style.display = this.mounted.some(other => other.block.chapter === m.block.chapter && other.block.byteStart === this.options.chapters[m.block.chapter].byteStart) || m.block.byteStart === this.options.chapters[m.block.chapter].byteStart ? "inline" : "none";
        this.mounted.push(m);
        this.mounted.sort((a, b) => Number(a.node.dataset.txtBlock) - Number(b.node.dataset.txtBlock));
        this.height();
        this.compensate(anchor);
        this.anchor = this.capture();
    }
    private nodeCount() {
        const walker = this.options.doc.createTreeWalker(this.options.doc.body, 0xffffffff);
        let count = 1;
        while (walker.nextNode() && count <= TXT_WINDOW_BUDGET.nodes) count++;
        return count;
    }
    private fits(block: TxtWindowBlock) {
        const chapters = new Set(this.mounted.map(m => m.block.chapter));
        chapters.add(block.chapter);
        return chapters.size <= TXT_WINDOW_BUDGET.chapters && this.mounted.length < TXT_WINDOW_BUDGET.blocks &&
            this.mounted.reduce((n, m) => n + m.block.end - m.block.start, 0) + block.end - block.start <= TXT_WINDOW_BUDGET.characters &&
            this.nodeCount() + 5 <= TXT_WINDOW_BUDGET.nodes;
    }
    private evict(direction: number) {
        const m = direction > 0 ? this.mounted[0] : this.mounted[this.mounted.length - 1];
        if (!m || m === this.visible())
            return false;
        const rect = this.rect(m), top = this.viewport();
        if (rect.bottom > top && rect.top < top + this.options.element.clientHeight)
            return false;
        const selection = this.options.doc.getSelection();
        if (selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(m.node)) {
            // A selection may pin the existing window but never expand its hard budget.
            this.selectionLimited = true;
            return false;
        }
        const anchor = this.capture(), parent = m.node.parentElement;
        m.node.remove();
        if (m.block.byteStart === this.options.chapters[m.block.chapter].byteStart) {
            const separator = parent?.querySelector<HTMLElement>("[data-txt-separator]");
            if (separator) separator.style.display = "none";
        }
        if (!parent?.querySelector("[data-txt-block]"))
            parent?.remove();
        this.mounted = this.mounted.filter(item => item !== m);
        this.height();
        this.compensate(anchor);
        return true;
    }
    record() { if (!this.dead) this.emitPosition(); }
    async fill() {
        if (this.dead) return;
        if (this.busy) {
            this.again = true;
            return;
        }
        this.busy = true;
        const token = this.token;
        this.selectionLimited = !this.options.doc.getSelection()?.isCollapsed && this.selectionLimited;
        try {
            // Serial bounded pre-read. Short chapters can be replenished in one turn.
            for (let n = 0; n < TXT_WINDOW_BUDGET.blocks && !this.dead && token === this.token && this.mounted.length; n++) {
                const first = this.mounted[0], last = this.mounted[this.mounted.length - 1], top = this.viewport(), height = this.options.element.clientHeight;
                const before = this.rect(first).top > top - height;
                const after = this.rect(last).bottom < top + height * 3;
                const current = this.visible()!.block.chapter;
                let direction = after ? 1 : before ? -1 : 0;
                let index = direction > 0 ? Number(last.node.dataset.txtBlock) + 1 : Number(first.node.dataset.txtBlock) - 1;
                const underfilled = this.rect(last).bottom - this.rect(first).top < height * 3;
                if (!this.blocks[index] || (Math.abs(this.blocks[index].chapter - current) > 2 && !underfilled)) {
                    direction = before ? -1 : 0;
                    index = Number(first.node.dataset.txtBlock) - 1;
                }
                if (!direction || !this.blocks[index] || (Math.abs(this.blocks[index].chapter - current) > 2 && !underfilled))
                    break;
                while (!this.fits(this.blocks[index]) && this.evict(direction)) { /* Hard budgets include selected blocks. */ }
                if (!this.fits(this.blocks[index]))
                    break;
                const m = await this.load(index, token);
                if (!m)
                    break;
                this.mount(m);
            }
            if (this.dead || token !== this.token) return;
            this.emitPosition();
            const key = this.key;
            if (key !== this.lastWindow) { this.lastWindow = key; this.options.windowChanged?.(); }
        }
        finally {
            this.busy = false;
            if (this.again) {
                this.again = false;
                this.schedule();
            }
        }
    }
    async jump(chapter: number, offset = 0) {
        if (this.dead) return;
        const target = this.options.chapters[chapter];
        if (!target || !Number.isSafeInteger(offset) || offset < 0 || offset > target.end - target.start)
            throw Error("Invalid TXT window target");
        const token = ++this.token;
        // Chapter lookup is direct, and giant-chapter lookup is logarithmic.
        let low = this.chapterBlocks[chapter], high = (this.chapterBlocks[chapter + 1] ?? this.blocks.length) - 1;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.blocks[middle].end <= target.start + offset) low = middle + 1;
            else high = middle;
        }
        const index = low;
        const m = await this.load(index, token);
        if (!m)
            return;
        this.options.doc.getSelection()?.removeAllRanges();
        // Commit only after the destination is ready. Boundary scrolls never clear body.
        this.mountEpoch++;
        this.root.replaceChildren();
        this.mounted = [];
        this.anchor = undefined;
        this.mount(m);
        this.options.element.scrollTop = 0;
        const text = m.node.firstChild;
        if (text) {
            let local = Math.min(text.textContent!.length, Math.max(0, target.start + offset - m.block.start));
            if (local > 0 && /[\uDC00-\uDFFF]/.test(text.textContent![local] || ""))
                local--;
            const range = this.options.doc.createRange();
            range.setStart(text, local);
            range.setEnd(text, Math.min(text.textContent!.length, local + 1));
            this.options.element.scrollTop = Math.max(0, range.getBoundingClientRect().top);
        }
        this.emitPosition();
        await this.fill();
        this.schedule();
    }
    get views(): TxtBlockView[] {
        return this.mounted.map(m => ({node:m.node,chapter:this.options.chapters[m.block.chapter],start:m.block.start,end:m.block.end,text:m.text}));
    }
    get key() { return `${this.mountEpoch}:` + this.mounted.map(m => m.node.dataset.txtBlock).join(","); }
    get sourceBlocks() { return this.blocks; }
    get closed() { return this.dead; }
    async *readBlocks(chapter: number, offset = 0, valid: () => boolean = () => true) {
        if (this.dead) return;
        const current = this.options.chapters[chapter];
        if (!current) return;
        const first = this.chapterBlocks[chapter], last = this.chapterBlocks[chapter + 1] ?? this.blocks.length;
        for (let i = first; i < last && !this.dead && valid(); i++) {
            const block = this.blocks[i]; if (block.end <= current.start + offset) continue;
            const text = await this.readText(i, valid);
            if (text === undefined || this.dead || !valid()) return;
            yield { ...block, text };
        }
    }
    async move(direction: number) {
        await this.fill();
        if (this.dead) return;
        this.options.element.scrollBy(0, direction * (this.options.element.clientHeight - 50));
        this.schedule();
    }
    get stats() { return { ...TXT_WINDOW_BUDGET, mountedBlocks: this.mounted.length, mountedCharacters: this.mounted.reduce((n, m) => n + m.block.end - m.block.start, 0), mountedChapters: new Set(this.mounted.map(m => m.block.chapter)).size, nodes: this.dead ? 0 : this.nodeCount(), ...this.cache.stats, activeReads: this.activeReads, observers: this.dead ? 0 : 1, listeners: this.dead ? 0 : 3, animationFrames: this.frame ? 1 : 0, selectionLimited: this.selectionLimited }; }
    destroy() {
        if (this.dead) return;
        this.dead = true;
        this.token++;
        cancelAnimationFrame(this.frame); this.frame = 0; this.again = false;
        this.cache.clear();
        this.options.element.style.overflowAnchor = "";
        this.options.element.removeEventListener("scroll", this.schedule);
        this.options.doc.removeEventListener("selectionchange", this.schedule);
        this.options.doc.fonts?.removeEventListener("loadingdone", this.layoutChanged);
        this.observer.disconnect();
        this.root.replaceChildren(); this.root.remove();
        this.options.read = async () => { throw Error("TXT window is closed"); };
        this.options.changed = () => {}; this.options.windowChanged = undefined; this.options.reflowHighlights = undefined; this.options.paintSelection = undefined; this.options.error = () => {};
        this.options.chapters = []; this.options.checkpoints = [];
        this.reads = Promise.resolve();
        this.mounted = [];
        this.blocks = [];
        this.chapterBlocks = [];
        this.anchor = undefined;
    }
}
