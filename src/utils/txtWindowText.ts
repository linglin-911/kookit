import type { PersistentTxtChapter } from "../libs/txtIndex";
import type { TxtWindowManager } from "./txtWindowManager";
const clean = (value: string) => value.replace(/\s/g, "");
export const escapeTxtPattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

/** Legacy count is the old h1/p ordinal. Resolve it from bounded line probes,
 * without ever materializing a giant paragraph or its preceding chapter DOM. */
export async function resolveLegacyTxtPosition(manager: TxtWindowManager, chapter: PersistentTxtChapter, saved: { text?: string; count?: string | number; xpath?: string; cfi?:string }, valid: () => boolean) {
  const needle = clean(String(saved.text || "").slice(0, 200));
  const paragraph = /\/p\[(\d+)\]/.exec(saved.xpath || "");
  // The old plain-TXT h1/p document used direct body children. Recognize only
  // that exact CFI shape; other formats/layouts keep their original adapters.
  const cfiPath=/^epubcfi\((.*)\)$/.exec(saved.cfi || "")?.[1].split("!").pop() || "";
  const cfi=/^\/4\/(\d+)(?:\[[^\]]*\])?(?:\/1(?::(\d+))?|,\/1:(\d+),\/1:\d+)$/.exec(cfiPath);
  const cfiOrdinal=cfi&&Number(cfi[1])%2===0?Number(cfi[1])/2-1:undefined;
  const cfiOffset=cfiOrdinal!==undefined?Number(cfi![2]||cfi![3]||0):0;
  let wanted = paragraph ? Number(paragraph[1]) - (chapter.hasTitle || chapter.fixedChunk ? 0 : 1) : /^\d+$/.test(String(saved.count)) ? Number(saved.count) : undefined;
  if(cfiOrdinal!==undefined)wanted=cfiOrdinal;
  if (!needle && !wanted && !cfiOffset) return 0;
  let ordinal = chapter.fixedChunk ? 1 : 0, lineStart = chapter.start, head = "", lineLength=0;
  const candidates: { ordinal:number; offset:number }[] = [];
  const finish = () => {
    const matches = !needle || clean(head).includes(needle);
    const result = matches && (wanted === undefined || ordinal === wanted) ? lineStart - chapter.start + Math.min(cfiOffset,lineLength) : undefined;
    if (matches && wanted !== undefined && Math.abs(ordinal-wanted)<2) candidates.push({ordinal,offset:lineStart-chapter.start});
    head = ""; lineLength=0; ordinal++; return result;
  };
  for await (const block of manager.readBlocks(chapter.index,0,valid)) {
    let start = 0;
    for (let i=0;i<block.text.length;i++) if (block.text[i] === "\n") {
      lineLength+=i-start;
      head += block.text.slice(start,i).slice(0,Math.max(0,4096-head.length));
      const result = finish(); if (result !== undefined) return result;
      lineStart=block.start+i+1; start=i+1;
      if (wanted !== undefined && ordinal>wanted+1) return candidates.length===1?candidates[0].offset:0;
    }
    lineLength+=block.text.length-start;
    head += block.text.slice(start).slice(0,Math.max(0,4096-head.length));
  }
  const result=finish(); return result ?? (candidates.length===1?candidates[0].offset:0);
}

export async function searchTxtWindow(manager: TxtWindowManager, chapters: PersistentTxtChapter[], generation: string | null, keyword: string, valid: () => boolean) {
  if (!keyword.trim() || keyword.length>2048) return { records:[], hasMore:false };
  const records: {cfi:string;excerpt:string}[]=[];
  const pattern = new RegExp(escapeTxtPattern(keyword),"giu");
  for (const chapter of chapters) {
    let carry="", previousEnd=chapter.start;
    for await (const block of manager.readBlocks(chapter.index,0,valid)) {
      if (!valid()) return {records:[],hasMore:false};
      const text=carry+block.text, base=block.start-carry.length;
      pattern.lastIndex=0;
      for (const match of text.matchAll(pattern)) {
        const index=match.index!, offset=base+index;
        if (offset+match[0].length<=previousEnd) continue;
        if (records.length===200) return { records, hasMore:true };
        records.push({ excerpt:text.slice(Math.max(0,index-80),index+match[0].length+80), cfi:JSON.stringify({chapterDocIndex:String(chapter.index),chapterTitle:chapter.label,chapterHref:`title${chapter.index}`,count:"search",keyword,txtWindow:{version:1,chapterId:chapter.chapterId,generation,offset:offset-chapter.start}}) });
      }
      previousEnd=block.end; carry=text.slice(-(keyword.length+160));
    }
  }
  return {records,hasMore:false};
}
