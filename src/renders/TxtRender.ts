import { resolveLegacyTxtPosition, searchTxtWindow, escapeTxtPattern } from "../utils/txtWindowText";
import { TxtWindowHighlights, WindowNote } from "../utils/txtWindowHighlights";
import { selectedWindowAnchor, windowRange, windowPoint } from "../libs/txtWindowAnchors";
import { TxtWindowManager } from "../utils/txtWindowManager";
import type { PersistentTxtIndex } from "../libs/txtIndex";
import { selectedTxtAnchor, txtRange } from "../libs/txtAnchors";
import { clearHighlight, highlightRange } from "../utils/noteUtil";
import type { PersistentTxtChapter } from "../libs/txtIndex";
import { createIframe, handleLayout } from "../utils/layoutUtil";
import GeneralRender from "./GeneralRender";
import { makeHtmlBook } from "../libs/html";
import GeneralParser from "../utils/generalParser";
import chardet from "chardet";
import {
  decodeTxtSource,
  buildPersistentTxtIndex,
  TxtIndexStore,
  prepareTxtIndex,
} from "../libs/txtIndex";
import { getCache } from "../libs/cache.js";
import { beginDiagnostic, diagnosticError } from "../utils/diagnostics";

class TxtRender extends GeneralRender {
  txtWindow?: TxtWindowManager;
  private continuousScroll: boolean;
  private disposed = false;
  private closeTask?: Promise<void>;
  private parseVersion = 0;
  private cleanups = new Set<() => void>();
  addCleanup(cleanup: () => void) {
    if (this.disposed) { cleanup(); return; }
    this.cleanups.add(cleanup);
  }
  private windowHighlights?: TxtWindowHighlights;
  private windowNotes: WindowNote[] = [];
  private relatedAnnotations: unknown[] = [];
  setTxtRelatedAnnotations(rows:unknown[]) { if (!this.disposed) this.relatedAnnotations=rows; }
  getTxtRelatedAnnotations() { return this.relatedAnnotations; }
  private windowClick: (event: Event) => void = () => {};
  private searchVersion = 0;
  private navigationVersion = 0;
  searchHasMore = false;
  private audioBatch?: { chapter: number; start: number; end: number; text: string; cursor: number; positions?:number[] };
  private audioNext?: {chapter:number;offset:number};
  private auxiliaryHighlights = new Set<string>();
  private onTxtWindowPosition?: (position: Record<string, unknown>) => void;
  private txtIndex?: PersistentTxtIndex;
  private txtChapterById = new Map<string,PersistentTxtChapter>();
  private txtGeneration: string | null = null;
  txtBuffer: ArrayBuffer;
  charset: string;
  parserRegex: string;
  txtIndexStore?: TxtIndexStore;
  constructor(txtBuffer: ArrayBuffer, config: any) {
    super({ ...config, format: "TXT" });
    this.txtBuffer = txtBuffer;
    this.charset = config.charset;
    this.parserRegex = config.parserRegex;
    this.txtIndexStore = config.txtIndexStore;
    this.onTxtWindowPosition = config.onTxtWindowPosition;
    const positionCallback = config.onTxtWindowPosition;
    if (typeof positionCallback?.cancel === "function") this.addCleanup(() => positionCallback.cancel());
    // Transforming/assisted reading keeps its established rendering path until
    // it has an equivalent source map; never silently ignore a reader setting.
    this.continuousScroll = config.txtContinuousScroll === true && this.readerMode === "scroll" &&
      !["Simplified To Traditional","Traditional To Simplified"].includes(config.convertChinese) &&
      !config.textRules?.length && config.isBionic !== "yes" && config.textOrientation !== "vertical" &&
      !["both","target"].includes(config.fullTranslationMode);
  }
  async renderTo(element: HTMLElement, bookLocation?: any): Promise<void> {
    const finish = beginDiagnostic("TXT", "renderTo", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
    });
    try {
      if (this.disposed) throw Error("TXT reader is closed");
      this.element = element;
      if (!this.book) {
        await this.parse(bookLocation);
      }
      if (this.disposed) throw Error("TXT reader is closed");
      const parser = new GeneralParser(this.book);
      const chapterFinish = beginDiagnostic("TXT", "buildChapterIndex", {
        traceId: this.diagnosticTraceId,
      });
      const chapterList = await parser.getChapter(this.book.toc);
      const chapterDocList = await parser.getChapterDoc();
      if (this.disposed) throw Error("TXT reader is closed");
      this.chapterList = chapterList; this.chapterDocList = chapterDocList;
      chapterFinish({
        chapterCount: this.chapterList.length,
        chapterDocCount: this.chapterDocList.length,
      });
      if (this.disposed) throw Error("TXT reader is closed");
      createIframe(element, this.isAllowScript);
      const doc = this.getDocument();
      if (!doc) {
        throw new Error(
          "TXT reader iframe document is unavailable after creation"
        );
      }
      handleLayout(element, this.readerMode, doc);
      if (this.continuousScroll && this.txtIndex?.checkpoints && this.txtIndexStore?.readChapterRange) {
        this.txtGeneration = (await this.getTxtDirectory()).generation;
        if (this.disposed) throw Error("TXT reader is closed");
        this.windowHighlights = new TxtWindowHighlights(doc);
        this.txtWindow = new TxtWindowManager({ doc, iframe: this.getIframe()!, element,
          chapters: this.txtIndex.chapters, checkpoints: this.txtIndex.checkpoints,
          generation: this.txtGeneration, encoding: this.txtIndex.encoding,
          read: this.txtIndexStore.readChapterRange,
          windowChanged: () => {
            this.clearWindowAuxiliary();
            this.windowHighlights?.update(this.windowNotes, this.txtWindow?.views || [], this.windowClick);
            this.trigger("txt-window-changed");
          },
          changed: position => {
            const chapter = this.txtIndex!.chapters[position.chapter];
            const previous = this.tempLocation.txtWindow;
            Object.assign(this.tempLocation, { chapterDocIndex: String(position.chapter), chapterTitle: chapter.label,
              chapterHref: `title${position.chapter}`, count: "0", text: "", page: "",
              xpath: `/body/DocFragment[${position.chapter + 1}]`, timestamp: Math.floor(Date.now()/1000),
              txtWindow: { version: 1, chapterId: position.chapterId, generation: position.generation, offset: position.offset },
              percentage: String((chapter.start + position.offset) / Math.max(1, this.txtIndex!.textLength)) });
            if (previous?.chapterId !== position.chapterId || previous?.offset !== position.offset)
              this.onTxtWindowPosition?.({ ...this.tempLocation });
          },
          error: error => { diagnosticError("TXT", "window:failed", error, { traceId: this.diagnosticTraceId }); this.trigger("txt-window-error"); },
        });
      }
      finish({
        chapterCount: this.chapterList.length,
        chapterDocCount: this.chapterDocList.length,
        iframeReady: true,
        continuousWindow: !!this.txtWindow,
        blockCoordinates: !!this.txtIndex?.checkpoints,
      });
    } catch (error) {
      diagnosticError("TXT", "renderTo:failed", error, {
        traceId: this.diagnosticTraceId,
      });
      finish({ failed: true });
      throw error;
    }
  }
  async parse(bookLocation?: any) {
    if (this.disposed) throw Error("TXT reader is closed");
    const version = ++this.parseVersion;
    const assertCurrent = () => { if (this.disposed || version !== this.parseVersion) throw Error("TXT preparation cancelled"); };
    const finish = beginDiagnostic("TXT", "parse", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
      charset: this.charset || "default",
      refresh: bookLocation?.refresh === true,
    });
    try {
      if (this.txtIndexStore?.readChapter && (this.txtIndexStore.prepare || this.txtIndexStore.readSource)) {
        // The desktop random-access path never retains a whole-file buffer or
        // decoded book string, including after a cold index rebuild.
        this.txtBuffer = new ArrayBuffer(0);
        const store = this.txtIndexStore;
        let index = await prepareTxtIndex(
          store,
          this.charset,
          this.parserRegex,
          bookLocation?.refresh === true
        );
        // Old valid caches lacked sparse blocks. A supported scroll session
        // requests a verified, same-generation metadata upgrade before mounting,
        // rather than silently re-entering the replace-and-reset chapter path.
        assertCurrent();
        if (this.continuousScroll && !index.checkpoints && store.ensureBlocks)
          index = await store.ensureBlocks();
        assertCurrent();
        this.txtIndex = index;
        this.txtChapterById = new Map(index.chapters.map(chapter=>[chapter.chapterId,chapter]));
        this.book?.destroy?.();
        this.book = makeHtmlBook(
          "",
          true,
          this.parserRegex,
          bookLocation,
          this.diagnosticTraceId,
          index,
          (chapterIndex) => store.readChapter!(index.chapters[chapterIndex])
        );
        finish({
          chapterCount: index.chapters.length,
          randomAccess: true,
          retainedSourceBytes: 0,
        });
        return;
      }
      const textDecoder = new TextDecoder(this.charset);
      const bytes = new Uint8Array(this.txtBuffer);
      const decodeFinish = beginDiagnostic("TXT", "decode", {
        traceId: this.diagnosticTraceId,
        bufferBytes: bytes.byteLength,
        charset: this.charset || "default",
      });
      // Phase 2 deliberately retains whole-file decode. Only chapter scanning is
      // eliminated on a persistent cache hit; random body reads belong to phase 3.
      const source = this.txtIndexStore
        ? decodeTxtSource(bytes, this.charset)
        : null;
      const text = source ? source.text : textDecoder.decode(bytes);
      decodeFinish({
        textCharacters: text.length,
        transitionWholeFileDecode: Boolean(source),
      });
      const persistentFinish = beginDiagnostic(
        "TXT",
        "persistentChapterIndex",
        {
          traceId: this.diagnosticTraceId,
        }
      );
      let index = this.txtIndexStore
        ? await this.txtIndexStore.load(bookLocation?.refresh === true)
        : null;
      const cacheHit = Boolean(index);
      if (source && this.txtIndexStore && !index) {
        index = buildPersistentTxtIndex(bytes, source, this.parserRegex);
        await this.txtIndexStore.save(index);
      }
      if (
        index &&
        (index.textLength !== text.length || index.byteLength !== bytes.length)
      ) {
        throw new Error("TXT snapshot does not match the persistent index");
      }
      persistentFinish({
        enabled: Boolean(this.txtIndexStore),
        cacheHit,
        chapterCount: index?.chapters.length || 0,
      });
      assertCurrent();
      this.book?.destroy?.();
      this.book = makeHtmlBook(
        text,
        true,
        this.parserRegex,
        bookLocation,
        this.diagnosticTraceId,
        index || undefined
      );
      finish({ textCharacters: text.length });
    } catch (error) {
      diagnosticError("TXT", "parse:failed", error, {
        traceId: this.diagnosticTraceId,
        bufferBytes: this.txtBuffer.byteLength,
      });
      finish({ failed: true });
      throw error;
    }
  }
  getTxtWindowState() {
    if (!this.txtWindow) return undefined;
    return { key:this.txtWindow.key, generation:this.txtGeneration, blocks:this.txtWindow.views.map(block=>({chapterIndex:block.chapter.index,chapterId:block.chapter.chapterId,start:Math.max(0,block.start-block.chapter.bodyStart),end:Math.max(0,block.end-block.chapter.bodyStart)})).filter(block=>block.end>block.start) };
  }
  getTxtSourceRange(chapterId:string,start:number,end:number) {
    const chapter=this.txtChapterById.get(chapterId);
    if(!chapter||!this.txtWindow)throw Error("TXT window source is unavailable");
    return windowRange(this.txtWindow.views,chapterId,chapter.bodyStart+start,chapter.bodyStart+end);
  }
  getTxtHighlightRanges() { return this.windowHighlights?.ranges || []; }
  getTxtGeneration() { return this.txtGeneration; }
  private windowPosition(chapterIndex:number,offset:number) {
    const chapter=this.txtIndex!.chapters[chapterIndex];
    return { ...this.tempLocation, chapterDocIndex:String(chapterIndex),chapterTitle:chapter.label,chapterHref:`title${chapterIndex}`,count:"0",text:"",page:"",xpath:`/body/DocFragment[${chapterIndex+1}]`,percentage:String((chapter.start+offset)/Math.max(1,this.txtIndex!.textLength)),txtWindow:{version:1,chapterId:chapter.chapterId,generation:this.txtGeneration,offset} };
  }
  async goToXpath(xpath:string) {
    if (!this.txtWindow) return super.goToXpath(xpath);
    const chapterDocIndex=Number(/DocFragment\[(\d+)\]/.exec(xpath)?.[1] || 1)-1;
    await this.goToPosition(JSON.stringify({chapterDocIndex,xpath}));
  }
  async goToNode(node: Node) {
    if (!this.txtWindow) return super.goToNode(node);
    if (!this.getDocument()?.contains(node)) return;
    const range=this.getDocument()!.createRange();range.selectNodeContents(node);
    this.element.scrollTop=Math.max(0,range.getBoundingClientRect().top);await this.record();
  }
  async getNotePosition() {
    if (!this.txtWindow) return super.getNotePosition();
    const selection=this.getDocument()!.getSelection();
    if (selection?.rangeCount) {
      const range=selection.getRangeAt(0), point=windowPoint(this.txtWindow.views,range.startContainer,range.startOffset);
      return this.windowPosition(point.block.chapter.index,point.position-point.block.chapter.start);
    }
    await this.record();return this.tempLocation;
  }
  async getHighlightCoords() { if (this.txtWindow) return this.getAnnotationAnchor(); return super.getHighlightCoords(); }
  async prevChapter() {
    if (!this.txtWindow) return super.prevChapter();
    const chapter=Math.max(0,Number(this.tempLocation.chapterDocIndex||0)-1);await this.goToChapterDocIndex(chapter);
  }
  async nextChapter() {
    if (!this.txtWindow) return super.nextChapter();
    const chapter=Math.min(this.txtIndex!.chapters.length-1,Number(this.tempLocation.chapterDocIndex||0)+1);await this.goToChapterDocIndex(chapter);
  }
  async goToPercentage(percentage:number) {
    if (!this.txtWindow) return super.goToPercentage(percentage);
    if (!Number.isFinite(percentage)||percentage<0||percentage>1) throw Error("Invalid TXT progress");
    this.navigationVersion++;
    const chapters=this.txtIndex!.chapters,position=Math.floor(this.txtIndex!.textLength*percentage);
    let low=0,high=chapters.length-1;
    while(low<high){const middle=(low+high+1)>>>1;if(chapters[middle].start<=position)low=middle;else high=middle-1;}
    await this.txtWindow.jump(low,Math.max(0,Math.min(chapters[low].end-chapters[low].start,position-chapters[low].start)));this.trigger("rendered");
  }
  private windowPageCharacters() {
    const chapter=this.getTxtChapterSnapshot()!;
    return Math.max(1,this.getEstimatedSizePerPage()*Math.max(1,chapter.end-chapter.start)/Math.max(1,chapter.size));
  }
  getChapterProgress() {
    if (!this.txtWindow) return super.getChapterProgress();
    const chapter=this.getTxtChapterSnapshot()!,size=this.windowPageCharacters(),offset=this.tempLocation.txtWindow?.offset||0;
    const totalPage=Math.max(1,Math.ceil((chapter.end-chapter.start)/size));
    return {totalPage,currentPage:Math.min(totalPage,Math.floor(offset/size)+1),percentage:this.tempLocation.percentage||"0"};
  }
  getProgress() {
    if (!this.txtWindow) return super.getProgress();
    if(this.isShowTotalPage!=="yes")return this.getChapterProgress();
    const totalPage=Math.max(1,Math.ceil(this.txtIndex!.textLength/this.windowPageCharacters()));
    return {totalPage,currentPage:Math.min(totalPage,Math.floor(totalPage*Number(this.tempLocation.percentage||0))+1),percentage:this.tempLocation.percentage||"0"};
  }
  async goToPage(page:number) {
    if (!this.txtWindow) return super.goToPage(page);
    this.navigationVersion++;
    const chapter=this.getTxtChapterSnapshot()!;await this.txtWindow.jump(chapter.index,Math.min(chapter.end-chapter.start,Math.max(0,Math.floor((page-1)*this.windowPageCharacters()))));
  }
  cancelTxtSearch() { this.searchVersion++; }
  async doSearch(keyword:string) {
    if(this.disposed)return [];
    if(!this.txtWindow)return super.doSearch(keyword);
    const version=++this.searchVersion;
    const result=await searchTxtWindow(this.txtWindow,this.txtIndex!.chapters,this.txtGeneration,keyword,()=>version===this.searchVersion&&!this.txtWindow?.closed);
    if(version!==this.searchVersion)return [];
    this.searchHasMore=result.hasMore;return result.records;
  }
  private paintWindowAuxiliary(name:string,ranges:Range[],style:string) {
    if(this.disposed)return;
    const doc=this.getDocument();if(!doc)return;
    const api=doc.defaultView as unknown as {Highlight:new(...ranges:Range[])=>{priority:number};CSS:{highlights:Map<string,unknown>}};
    if(!ranges.length){api.CSS.highlights.delete(name);return;}
    const probe=doc.createElement("span");probe.style.cssText=style;
    const css=["background-color","color","text-decoration","text-decoration-color","text-decoration-style","text-decoration-thickness"].map(property=>`${property}:${probe.style.getPropertyValue(property)}`).join(";");
    let element=doc.getElementById(name);if(!element){element=doc.createElement("style");element.id=name;doc.head.append(element);}element.textContent=`::highlight(${name}){${css}}`;
    const highlight=new api.Highlight(...ranges);highlight.priority=2000000;api.CSS.highlights.set(name,highlight);this.auxiliaryHighlights.add(name);
  }
  private clearWindowAuxiliary() {
    if(!this.auxiliaryHighlights.size)return;
    const doc=this.getDocument(),css=(doc?.defaultView as unknown as {CSS?:{highlights?:Map<string,unknown>}})?.CSS;
    for(const name of this.auxiliaryHighlights){css?.highlights?.delete(name);doc?.getElementById(name)?.remove();}this.auxiliaryHighlights.clear();
  }
  highlightSearchNode(text:string,style:string) {
    if(!this.txtWindow)return super.highlightSearchNode(text,style);
    const ranges:Range[]=[];const pattern=new RegExp(escapeTxtPattern(text),"giu"),views=this.txtWindow.views;
    if(text)for(const chapterId of new Set(views.map(block=>block.chapter.chapterId))){
      const blocks=views.filter(block=>block.chapter.chapterId===chapterId),source=blocks.map(block=>block.text).join("");
      for(const match of source.matchAll(pattern)){if(ranges.length>=200)break;ranges.push(windowRange(blocks,chapterId,blocks[0].start+match.index!,blocks[0].start+match.index!+match[0].length));}
    }
    this.paintWindowAuxiliary("koodo-txt-search",ranges,style);
  }
  async audioText(forSpeech = false) {
    if (this.disposed) return [];
    if(!this.txtWindow)return super.audioText();
    const chapters=this.txtIndex!.chapters,chapterIndex=(forSpeech?this.audioNext?.chapter:undefined)??Number(this.tempLocation.chapterDocIndex||0),offset=(forSpeech?this.audioNext?.offset:undefined)??Number(this.tempLocation.txtWindow?.offset||0);
    if(forSpeech)this.audioNext=undefined;
    const manager = this.txtWindow;
    for(let index=chapterIndex;index<chapters.length&&!this.disposed;index++){
      const chapter=chapters[index];
      for await(const block of manager.readBlocks(index,index===chapterIndex?offset:0)){
        if (this.disposed) return [];
        const start=Math.max(block.start,chapter.bodyStart,index===chapterIndex?chapter.start+offset:0),text=block.text.slice(start-block.start);
        const lines=text.split("\n").filter(line=>line.trim());if(!lines.length)continue;
        if(forSpeech)this.audioBatch={chapter:index,start,end:block.end,text,cursor:0};return lines;
      }
    }
    if(forSpeech)this.audioBatch=undefined;return [];
  }
  async advanceTxtAudio() {
    if(!this.txtWindow||!this.audioBatch)return false;
    let {chapter,end}=this.audioBatch;const chapters=this.txtIndex!.chapters;
    if(end>=chapters[chapter].end){chapter++;if(chapter>=chapters.length){this.audioBatch=undefined;return false;}end=chapters[chapter].start;}
    await this.txtWindow.jump(chapter,end-chapters[chapter].start);if(this.disposed)return false;this.audioNext={chapter,offset:end-chapters[chapter].start};this.audioBatch=undefined;return true;
  }
  resetTxtAudio() { this.audioBatch=undefined;this.audioNext=undefined;this.clearWindowAuxiliary(); }
  setTxtAudioSequence(texts:string[],skip=0) {
    const batch=this.audioBatch;if(!batch)return;let cursor=0;
    batch.positions=texts.map(text=>{const index=batch.text.indexOf(text,cursor);if(index>=0)cursor=index+text.length;return index;}).slice(skip);
  }
  async highlightAudioNode(text:string,style:string,sentenceIndex?:number) {
    if(!this.txtWindow)return super.highlightAudioNode(text,style);
    const batch=this.audioBatch;if(!batch||!text)return;
    const index=sentenceIndex!==undefined&&batch.positions?batch.positions[sentenceIndex]:batch.text.indexOf(text,batch.cursor);if(index===undefined||index<0)return;
    batch.cursor=index+text.length;const chapter=this.txtIndex!.chapters[batch.chapter],start=batch.start+index;
    let range:Range;
    try{range=windowRange(this.txtWindow.views,chapter.chapterId,start,start+text.length);}catch{await this.txtWindow.jump(chapter.index,start-chapter.start);range=windowRange(this.txtWindow.views,chapter.chapterId,start,start+text.length);}
    this.paintWindowAuxiliary("koodo-txt-audio",[range],style);
    this.element.scrollTop=Math.max(0,range.getBoundingClientRect().top);await this.record();
  }
  async visibleText() {
    if(!this.txtWindow)return super.visibleText();
    return this.txtWindow.views.filter(block=>{const rect=block.node.getBoundingClientRect();return rect.bottom>this.element.scrollTop&&rect.top<this.element.scrollTop+this.element.clientHeight;}).map(block=>block.text);
  }
  async chapterText() {
    if(!this.txtWindow)return super.chapterText();
    return this.txtWindow.views.filter(block=>block.chapter.index===Number(this.tempLocation.chapterDocIndex||0)).map(block=>block.text).join("");
  }
  async getRestAudioText(count:number) {
    if(this.disposed)return [];
    if(!this.txtWindow)return super.getRestAudioText(count);
    const result:{chapterDocIndex:number;audioText:string[]}[]=[],manager=this.txtWindow,chapters=this.txtIndex!.chapters;
    for(let index=Number(this.tempLocation.chapterDocIndex||0)+1;!this.disposed&&index<Math.min(chapters.length,Number(this.tempLocation.chapterDocIndex||0)+1+Math.min(3,Math.max(0,count)));index++){
      const audioText:string[]=[];let blocks=0;
      for await(const block of manager.readBlocks(index)){if(this.disposed)return [];audioText.push(...block.text.split("\n").filter(line=>line.trim()));if(++blocks===2)break;}
      result.push({chapterDocIndex:index,audioText});
    }return result;
  }

  isTxtWindowActive() { return !!this.txtWindow; }
  async goToChapter(index: number, href: string, title: string) {
    if (!this.txtWindow) return super.goToChapter(index, href, title);
    this.navigationVersion++;
    this.resetTxtAudio(); await this.txtWindow.jump(Number(index)); this.trigger("rendered");
  }
  async goToPosition(value: string) {
    if (this.disposed) return;
    if (!this.txtWindow) return super.goToPosition(value);
    const version = ++this.navigationVersion;
    this.resetTxtAudio();
    const saved = JSON.parse(value), index = saved.txtWindow ? this.txtChapterById.get(saved.txtWindow.chapterId)?.index ?? -1 : Number(saved.chapterDocIndex || 0), chapter = this.txtIndex?.chapters[index];
    if (!chapter) throw new Error("TXT saved chapter is unavailable");
    if (saved.txtWindow && (saved.txtWindow.version !== 1 || saved.txtWindow.chapterId !== chapter.chapterId || saved.txtWindow.generation !== this.txtGeneration))
      throw new Error("TXT saved window belongs to another index generation");
    let offset = saved.txtWindow?.offset;
    if (offset === undefined && saved.annotationBindingId) {
      if (saved.annotationStatus !== "active" || saved.annotationChapterId !== chapter.chapterId || saved.annotationGeneration !== this.txtGeneration)
        throw Error("TXT annotation belongs to another index generation");
      offset = chapter.bodyStart - chapter.start + Number(saved.annotationStart || 0);
    }
    if (offset === undefined) {
      offset = await resolveLegacyTxtPosition(this.txtWindow, chapter, saved, () => version === this.navigationVersion);
      if (version !== this.navigationVersion) return;
    }
    await this.txtWindow.jump(index, offset);
    this.trigger("rendered");
  }
  async record() {
    if (this.disposed) return;
    if (!this.txtWindow) return super.record();
    this.txtWindow.record(); this.trigger("page-changed");
  }
  async next() { if (this.disposed) return; if (this.txtWindow) return this.txtWindow.move(1); return super.next(); }
  async prev() { if (this.disposed) return; if (this.txtWindow) return this.txtWindow.move(-1); return super.prev(); }
  async getTxtDirectory() {
    if (this.txtIndexStore?.readDirectory) return this.txtIndexStore.readDirectory();
    // Volatile/unsupported encodings keep their existing parser; directory
    // access still never invokes a section loader or builds body HTML.
    return {
      generation: null,
      chapters: this.book.sections.map((section, index: number) => ({
        chapterId: section.chapter?.chapterId || `volatile-${index}`,
        index,
        label: section.label || "",
      })),
    };
  }
  async goToTxtChapter(chapterId: string, index: number) {
    const section = this.book?.sections?.[index];
    if (!Number.isSafeInteger(index) || index < 0 || !section ||
      (section.chapter?.chapterId || `volatile-${index}`) !== chapterId) {
      throw new Error("TXT directory belongs to a different index generation");
    }
    await this.goToChapterDocIndex(index);
  }
  getTxtChapterSnapshot(): PersistentTxtChapter | undefined {
    return this.book?.sections?.[Number(this.tempLocation?.chapterDocIndex || 0)]?.chapter;
  }
  getAnnotationAnchor() {
    if (this.txtWindow) {
      if (!this.txtIndexStore?.sourceTicket) throw new Error("TXT source is unavailable for annotations");
      return { format:"TXT", sourceTicket:this.txtIndexStore.sourceTicket, ...selectedWindowAnchor(this.getDocument()!, this.txtWindow.views) };
    }
    const chapter=this.getTxtChapterSnapshot(),doc=this.getDocument();
    if(!chapter||!doc||!this.txtIndexStore?.sourceTicket)throw new Error("TXT source is unavailable for annotations");
    return {format:"TXT",sourceTicket:this.txtIndexStore.sourceTicket,...selectedTxtAnchor(doc,chapter)};
  }
  async renderHighlighters(notes: Array<{key:string;entityKey?:string;bindingId?:string;color:string;hasNote?:boolean;notes?:string;chapterIndex?:number;txtAnchor?:{start:number;end:number}}>,handleNoteClick:(event:Event)=>void) {
    if (this.txtWindow) {
      this.windowNotes = notes.filter(note => note.txtAnchor).map(note => ({ ...note, chapterIndex: note.chapterIndex ?? Number(this.tempLocation.chapterDocIndex || 0) }));
      this.windowClick = handleNoteClick;
      this.windowHighlights!.update(this.windowNotes, this.txtWindow.views, handleNoteClick); return;
    }
    if(this.disposed)return;
    if(!this.txtIndexStore?.sourceTicket)return super.renderHighlighters(notes,handleNoteClick);
    const doc=this.getDocument(),chapter=this.getTxtChapterSnapshot();if(!doc||!chapter)return;
    clearHighlight(doc,this.diagnosticTraceId);
    // Resolve against the current DOM: wrapping an earlier overlapping range
    // mutates live Range endpoints.
    for(const item of notes.filter(item=>item.txtAnchor)){
      const range=txtRange(doc,chapter,item.txtAnchor!.start,item.txtAnchor!.end);
      highlightRange({nativeRange:range},item.color,item.bindingId||item.key,handleNoteClick,doc,!!item.hasNote,false,"");
    }
    doc.getSelection()?.removeAllRanges();
    for(const item of notes){
      for(const element of Array.from(doc.querySelectorAll<HTMLElement>("[data-key]"))){
        if(element.dataset.key===(item.bindingId||item.key)){
          element.dataset.noteKey=item.entityKey||item.key;element.dataset.bindingId=item.bindingId||item.key;
        }
      }
    }
  }
  removeContent() {
    if (this.disposed) return this.closeTask;
    this.disposed = true; this.parseVersion++;
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch (error) { diagnosticError("TXT", "cleanup:failed", error, { traceId: this.diagnosticTraceId }); }
    }
    this.cleanups.clear();
    if (this.element) {
      this.autoScroll?.(0, "no");
      this.readingRulerManager?.removeOverlay(); this.speedReadingManager?.removeOverlay(); this.paragraphModeManager?.removeOverlay();
    }
    this.disposeEvents?.(); this.releaseChapterCaches?.();
    this.navigationVersion++; this.searchVersion++; this.windowHighlights?.destroy(); this.windowHighlights = undefined;
    this.windowNotes = []; this.relatedAnnotations=[]; this.audioBatch = undefined; this.audioNext=undefined; this.clearWindowAuxiliary();
    this.txtWindow?.destroy(); this.txtWindow = undefined; this.txtIndex = undefined; this.txtChapterById.clear();
    if (this.element) super.removeContent();
    this.callbacks = { base: {} };
    this.flattenChapters = []; this.chapterSizeCache = null; this.transMap = {};
    this.windowClick = () => {}; this.onTxtWindowPosition = undefined; this.txtGeneration = null;
    this.book?.destroy?.();
    this.book = null;
    this.chapterList = [];
    this.chapterDocList = [];
    this.txtBuffer = new ArrayBuffer(0);
    if (this.speedReadingManager) { this.speedReadingManager.words = []; this.speedReadingManager.playing = false; }
    if (this.paragraphModeManager) this.paragraphModeManager.currentParagraph = null;
    this.closeTask = this.txtIndexStore?.close?.().catch((error) => {
      diagnosticError("TXT", "closeSource:failed", error, {
        traceId: this.diagnosticTraceId,
      });
    });
    this.txtIndexStore = undefined;
    return this.closeTask;
  }
  trigger(name: string, args: unknown[] = []) {
    if (this.disposed) return;
    return super.trigger(name, args);
  }
  async refreshContent() {
    const finish = beginDiagnostic("TXT", "refreshContent", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
    });
    try {
      const previousWindow = this.txtWindow;
      const previousChapter = Number(this.tempLocation.chapterDocIndex || 0);
      await this.parse({ refresh: true });
      if (previousWindow) {
        this.windowHighlights?.destroy(); this.windowHighlights = undefined; this.windowNotes = [];
        previousWindow.destroy(); this.txtWindow = undefined;
        await this.renderTo(this.element);
        await this.goToChapterDocIndex(Math.min(previousChapter, this.chapterDocList.length - 1));
        this.chapterSizeCache = null;
        finish({ chapterCount: this.chapterList.length, chapterDocCount: this.chapterDocList.length });
        return this.chapterList;
      }
      const parser = new GeneralParser(this.book);
      this.chapterList = await parser.getChapter(this.book.toc);
      this.chapterDocList = await parser.getChapterDoc();
      await this.record();
      this.chapterSizeCache = null;
      finish({
        chapterCount: this.chapterList.length,
        chapterDocCount: this.chapterDocList.length,
      });
      return this.chapterList;
    } catch (error) {
      diagnosticError("TXT", "refreshContent:failed", error, {
        traceId: this.diagnosticTraceId,
      });
      finish({ failed: true });
      throw error;
    }
  }
  async preCache() {
    const finish = beginDiagnostic("TXT", "preCache", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
    });
    try {
      if (!this.book) {
        await this.parse({ refresh: true });
      }
      const cache = await getCache(this.book);
      finish({ cacheCreated: Boolean(cache) });
      return cache;
    } catch (error) {
      diagnosticError("TXT", "preCache:failed", error, {
        traceId: this.diagnosticTraceId,
      });
      finish({ failed: true });
      throw error;
    }
  }

  async getMetadata(txtBuffer: ArrayBuffer) {
    const finish = beginDiagnostic("TXT", "getMetadata", {
      traceId: this.diagnosticTraceId,
      bufferBytes: txtBuffer.byteLength,
    });
    try {
      // Define the size of the chunk to read for detection (e.g., 4KB)
      const CHUNK_SIZE = 4096;
      const bufferLength = txtBuffer.byteLength;

      // Determine the actual size to read (up to CHUNK_SIZE or the file size if smaller)
      const sizeToRead = Math.min(bufferLength, CHUNK_SIZE);

      // Create a Uint8Array from the beginning chunk of the buffer
      const chunkArray = new Uint8Array(txtBuffer, 0, sizeToRead);

      // Detect the charset using only the chunk
      let detectedCharset = chardet.detect(chunkArray);

      // Fallback to utf8 if detection fails or returns null/undefined
      const charset = detectedCharset || "utf8";
      this.charset = charset;
      finish({ charset, bytesSampled: sizeToRead });

      return { charset: charset };
    } catch (error) {
      diagnosticError("TXT", "getMetadata:failed", error, {
        traceId: this.diagnosticTraceId,
        bufferBytes: txtBuffer.byteLength,
      });
      finish({ failed: true, fallbackCharset: "utf8" });
      // Fallback to utf8 in case of error during detection
      this.charset = "utf8";
      return { charset: "utf8" };
    }
  }
}

export default TxtRender;
