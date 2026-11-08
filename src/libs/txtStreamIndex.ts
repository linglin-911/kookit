import { checkpointTxtStream, TxtCheckpoint } from "./txtBlocks";
import { isTitle } from "./textProcessor";
import { TXT_INDEX_CONTRACT, PersistentTxtChapter } from "./txtIndex";

interface Options {
  encoding: string; bomBytes: number; byteLength: number; parserRegex?: string;
  id: () => string;
  onChapter: (chapter: PersistentTxtChapter) => Promise<void>;
  onHeadings: () => Promise<void>;
}
interface Line {
  start: number; end: number; byteStart: number; byteEnd: number;
  next: number; byteNext: number; label: string; title: boolean;
  first: string; tail: string; blank: boolean;
}
interface Section { first: Line; end: Line; lines: number; firstChars: string; tail: string; }
const tail = (a: string, b: string) => Array.from(a + b).slice(-2).join("");
const section = (line: Line): Section => ({ first: line, end: line, lines: 1, firstChars: line.first, tail: line.tail });
const append = (a: Section, b: Section) => {
  a.end = b.end; a.lines += b.lines;
  if (!a.firstChars) a.firstChars = b.firstChars;
  a.tail = tail(a.tail, b.tail);
};
/** Single physical pass. Retains bounded line probes and section summaries, never
 * a book/chapter string or an array of all chapter metadata. Custom regexes have
 * an explicit 64K UTF-16 line limit; a Worker watchdog handles pathological CPU. */
export async function scanTxtStream(chunks: AsyncIterable<Uint8Array>, options: Options) {
  const { encoding, bomBytes, byteLength } = options;
  const regex = options.parserRegex ? new RegExp(options.parserRegex) : null;
  const stride = encoding.startsWith("utf-16") ? 2 : 1;
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  let offset = bomBytes, textStart = 0, byteStart = bomBytes, length = 0;
  let raw = "", probe = "", trimmedLength = 0, leading = true, first = "", last = "";
  let probeLength = 0, probeMeaningfulLength = 0;
  let nonLeadingLength = 0, pendingCR: number | null = null, carry = new Uint8Array();
  let content = false, lineCount = 0, count = 0, headings = false;
  let current: Section | null = null, candidate: Section | null = null;
  let fallback: Section | null = null, fallbackIndex = 0;

  const readText = (text: string) => {
    length += text.length;
    if (regex && length > 65536) throw Error("TXT custom parser line exceeds 65536 UTF-16 units");
    if (regex) raw += text;
    const significant = leading ? text.trimStart() : text;
    if (!significant) return;
    leading = false;
    if (!regex && raw.length < 65536) raw += significant.slice(0, 65536 - raw.length);
    const noTabs = significant.replace(/\t/g, "");
    if (probe.length < 100) probe += noTabs.slice(0, 100 - probe.length);
    const cleanEnd = noTabs.trimEnd().length;
    if (cleanEnd) probeMeaningfulLength = probeLength + cleanEnd;
    probeLength += noTabs.length;
    const trimmed = significant.trimEnd();
    if (trimmed) {
      trimmedLength = nonLeadingLength + trimmed.length;
      if (Array.from(first).length < 2) {
        for (const point of significant) {
          if (!/\s/u.test(point)) first += point;
          if (Array.from(first).length === 2) break;
        }
      }
      const points: string[] = [];
      for (let end = trimmed.length; end > 0 && points.length < 2;) {
        const code = trimmed.charCodeAt(end - 1);
        const start = code >= 0xdc00 && code <= 0xdfff && end > 1 &&
          trimmed.charCodeAt(end - 2) >= 0xd800 && trimmed.charCodeAt(end - 2) <= 0xdbff ? end - 2 : end - 1;
        const point = trimmed.slice(start, end);
        if (!/\s/u.test(point)) points.unshift(point);
        end = start;
      }
      last = tail(last, points.join(""));
    }
    nonLeadingLength += significant.length;
  };
  const emit = async (part: Section, hasTitle: boolean, fixed: boolean, body?: Section) => {
    const label = fixed ? `Chapter ${fallbackIndex++}` : hasTitle ? part.first.label : "";
    const start = part.first.start, end = part.end.end, lines = part.lines;
    const chapter: PersistentTxtChapter = {
      index: count++, chapterId: options.id(), label, start, end,
      byteStart: part.first.byteStart, byteEnd: part.end.byteEnd,
      bodyStart: hasTitle ? part.first.next : start,
      bodyByteStart: hasTitle ? part.first.byteNext : part.first.byteStart,
      firstChars: hasTitle ? body?.firstChars || "" : part.firstChars,
      lastChars: hasTitle ? body?.tail || "" : part.tail,
      lineCount: lines, hasTitle, fixedChunk: fixed,
      recognition: fixed ? "fixed" : hasTitle ? "heading" : "preamble",
      size: Math.max(1, end - start - Math.max(0, lines - 1) + lines * 7 + (hasTitle ? 2 : 0) + (fixed ? 22 + label.length : 0)),
    };
    await options.onChapter(chapter);
  };
  let body: Section | null = null;
  const process = async (line: Line) => {
    if (!content && line.blank) return;
    content = true; lineCount++;
    const one = section(line);
    if (!headings) {
      if (!fallback) fallback = section(line); else append(fallback, section(line));
      if (fallback.lines === 500) { await emit(fallback, false, true); fallback = null; }
    }
    if (line.title) {
      // Empty heading candidates become ordinary body lines.
      if (candidate) {
        if (current) append(current, candidate); else current = candidate;
        if (headings) { if (body) append(body, candidate); else body = { ...candidate }; }
      }
      candidate = one;
    } else if (candidate) {
      append(candidate, one);
      if (!line.blank) {
        if (!headings) {
          await options.onHeadings(); count = 0; headings = true; fallback = null;
        }
        if (current) await emit(current, !!body, false, body || undefined);
        current = candidate;
        // Candidate consists of title, blank lines, and this first nonblank body.
        body = section(line);
        // Blank lines still count toward section length but not body features.
        candidate = null;
      }
    } else {
      if (current) append(current, one); else current = one;
      if (headings) { if (body) append(body, section(line)); else body = section(line); }
    }
  };
  const finishLine = async (end: number, newlineBytes: number) => {
    readText(decoder.decode());
    let title = false, label = "";
    if (regex) { regex.lastIndex = 0; title = !!raw && regex.test(raw); label = raw.trim(); }
    else {
      // Appending a sentinel preserves whitespace inside a long probe when
      // cleanText trims it before taking the first 100 units.
      title = !!trimmedLength && !!isTitle(probe + (probeMeaningfulLength > 100 ? "x" : ""));
      if (title && trimmedLength > 65536) throw Error("TXT chapter title exceeds 65536 UTF-16 units");
      label = raw.slice(0, trimmedLength).trim();
    }
    const line: Line = { start: textStart, end: textStart + length, byteStart, byteEnd: end,
      next: textStart + length + (newlineBytes ? 1 : 0), byteNext: end + newlineBytes,
      title, label, first, tail: last, blank: !trimmedLength };
    await process(line);
    textStart = line.next; byteStart = line.byteNext; length = 0;
    raw = ""; probe = ""; probeLength = 0; probeMeaningfulLength = 0; trimmedLength = 0; nonLeadingLength = 0; leading = true; first = ""; last = "";
  };
  const checkpoints: TxtCheckpoint[] = [];
  for await (let chunk of checkpointTxtStream(chunks, encoding, bomBytes, checkpoints)) {
    if (carry.length) { const joined = new Uint8Array(carry.length + chunk.length); joined.set(carry); joined.set(chunk, carry.length); chunk = joined; }
    const usable = chunk.length - chunk.length % stride;
    carry = chunk.slice(usable);
    chunk = chunk.subarray(0, usable);
    let segment = 0;
    for (let i = 0; i < chunk.length; i += stride) {
      const value = stride === 1 ? chunk[i] : encoding === "utf-16le" ? chunk[i] | chunk[i + 1] << 8 : chunk[i] << 8 | chunk[i + 1];
      if (pendingCR !== null) {
        await finishLine(pendingCR, stride * (value === 10 ? 2 : 1)); pendingCR = null;
        if (value === 10) { segment = i + stride; continue; }
      }
      if (value === 10 || value === 13) {
        readText(decoder.decode(chunk.subarray(segment, i), { stream: true }));
        if (value === 13) pendingCR = offset + i; else await finishLine(offset + i, stride);
        segment = i + stride;
      }
    }
    readText(decoder.decode(chunk.subarray(segment), { stream: true }));
    offset += chunk.length;
  }
  if (carry.length || offset !== byteLength) throw Error("Incomplete TXT byte stream");
  if (pendingCR !== null) await finishLine(pendingCR, stride);
  await finishLine(byteLength, 0);
  if (candidate && current) { append(current, candidate); if (body) append(body, candidate); }
  else if (candidate) current = candidate;
  if (headings) { if (current) await emit(current, true, false, body || undefined); }
  else if (fallback) await emit(fallback, false, true);
  else if (!content) {
    const empty: Line = { start: textStart, end: textStart, byteStart: byteLength, byteEnd: byteLength,
      next: textStart, byteNext: byteLength, label: "", title: false, first: "", tail: "", blank: true };
    const part = section(empty); part.lines = 0; await emit(part, false, true);
  }
  return { checkpoints, contract: { ...TXT_INDEX_CONTRACT }, encoding, bomBytes, byteLength,
    textLength: textStart, lineCount, mode: headings ? "chapter-headings" as const : "fixed-500-lines" as const };
}
