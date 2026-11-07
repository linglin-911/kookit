import {
  buildTxtChapterIndex,
  TxtChapterIndex,
  TxtChapterIndexEntry,
} from "./textProcessor";

// Shared wire contract with Koodo's txt-index-store.js. Bump when parsing,
// normalization, feature extraction or offset semantics change.
export const TXT_INDEX_CONTRACT = {
  parserVersion: 1,
  indexVersion: 1,
  normalizationVersion: 1,
  featureVersion: 1,
};
export interface PersistentTxtChapter extends TxtChapterIndexEntry {
  chapterId: string;
  byteStart: number;
  byteEnd: number;
  bodyByteStart: number;
  bodyStart: number;
  firstChars: string;
  lastChars: string;
  recognition: "heading" | "preamble" | "fixed";
}
export interface PersistentTxtIndex extends TxtChapterIndex {
  chapters: PersistentTxtChapter[];
  contract: typeof TXT_INDEX_CONTRACT;
  encoding: string;
  bomBytes: number;
  textLength: number;
  byteLength: number;
}
export interface TxtIndexStore {
  load: (force: boolean) => Promise<PersistentTxtIndex | null>;
  save: (index: PersistentTxtIndex) => Promise<void>;
}

export const decodeTxtSource = (bytes: Uint8Array, charset = "utf-8") => {
  let encoding = new TextDecoder(charset || "utf-8").encoding;
  let bomBytes = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    bomBytes = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    bomBytes = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bomBytes = 2;
  }
  // Reject malformed byte sequences instead of persisting misleading coordinates.
  // ignoreBOM preserves a literal U+FEFF after the physical file BOM removed above.
  const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true })
    .decode(bytes.subarray(bomBytes))
    .replace(/\r\n?/g, "\n");
  return { text, encoding, bomBytes };
};

/** Build byte coordinates only at chapter/line boundaries, never a per-character map.
 * Physical byte ranges include no file BOM. UTF-16 ranges refer to LF-normalized text.
 * The newline immediately before the next section is excluded, matching phase 1.
 */
export const buildPersistentTxtIndex = (
  bytes: Uint8Array,
  source: ReturnType<typeof decodeTxtSource>,
  parserRegex = ""
): PersistentTxtIndex => {
  if (
    ![
      "utf-8",
      "gbk",
      "gb18030",
      "utf-16le",
      "utf-16be",
      "windows-1252",
    ].includes(source.encoding)
  ) {
    throw new Error("Unsupported persistent TXT encoding");
  }
  const { text, encoding, bomBytes } = source;
  const index = buildTxtChapterIndex(text, parserRegex);
  const positions = new Map<number, number>();
  const bodies = index.chapters.map((chapter) => {
    const newline = text.indexOf("\n", chapter.start);
    const bodyStart = chapter.hasTitle
      ? newline < 0 || newline >= chapter.end
        ? chapter.end
        : newline + 1
      : chapter.start;
    for (const offset of [chapter.start, chapter.end, bodyStart])
      positions.set(offset, -1);
    return bodyStart;
  });
  const wide = encoding.startsWith("utf-16");
  const stride = wide ? 2 : 1;
  const unit = (offset: number) =>
    wide
      ? encoding === "utf-16le"
        ? bytes[offset] | (bytes[offset + 1] << 8)
        : (bytes[offset] << 8) | bytes[offset + 1]
      : bytes[offset];
  let byteStart = bomBytes;
  let textStart = 0;
  while (byteStart <= bytes.length) {
    let byteEnd = byteStart;
    while (
      byteEnd < bytes.length &&
      unit(byteEnd) !== 10 &&
      unit(byteEnd) !== 13
    )
      byteEnd += stride;
    const newline = text.indexOf("\n", textStart);
    const textEnd = newline < 0 ? text.length : newline;
    if (positions.has(textStart)) positions.set(textStart, byteStart);
    if (positions.has(textEnd)) positions.set(textEnd, byteEnd);
    if (byteEnd >= bytes.length) break;
    const crlf =
      unit(byteEnd) === 13 &&
      byteEnd + stride < bytes.length &&
      unit(byteEnd + stride) === 10;
    byteStart = byteEnd + stride * (crlf ? 2 : 1);
    textStart = textEnd + 1;
  }
  const byteAt = (position: number) => {
    const result = positions.get(position);
    if (result === undefined || result < 0)
      throw new Error("TXT boundary is not a physical line boundary");
    return result;
  };
  return {
    ...index,
    contract: { ...TXT_INDEX_CONTRACT },
    encoding,
    bomBytes,
    textLength: text.length,
    byteLength: bytes.length,
    chapters: index.chapters.map((chapter, i) => {
      const bodyStart = bodies[i];
      const body = text.slice(bodyStart, chapter.end);
      // v1: skip blank body lines; take two non-whitespace Unicode code points
      // from the first nonblank body line, and the final two from the whole body.
      let firstChars = "";
      for (let start = 0; start < body.length; ) {
        const newline = body.indexOf("\n", start);
        const end = newline < 0 ? body.length : newline;
        const line = body.slice(start, end);
        if (line.trim()) {
          const points: string[] = [];
          for (const point of line) {
            if (!/\s/u.test(point)) points.push(point);
            if (points.length === 2) break;
          }
          firstChars = points.join("");
          break;
        }
        start = end + 1;
      }
      const lastChars: string[] = [];
      for (let end = body.length; end > 0 && lastChars.length < 2; ) {
        const tail = body.charCodeAt(end - 1);
        const start =
          tail >= 0xdc00 &&
          tail <= 0xdfff &&
          end > 1 &&
          body.charCodeAt(end - 2) >= 0xd800 &&
          body.charCodeAt(end - 2) <= 0xdbff
            ? end - 2
            : end - 1;
        const point = body.slice(start, end);
        if (!/\s/u.test(point)) lastChars.unshift(point);
        end = start;
      }
      return {
        ...chapter,
        chapterId: crypto.randomUUID(),
        bodyStart,
        byteStart: byteAt(chapter.start),
        byteEnd: byteAt(chapter.end),
        bodyByteStart: byteAt(bodyStart),
        firstChars,
        lastChars: lastChars.join(""),
        recognition: chapter.fixedChunk
          ? "fixed"
          : chapter.hasTitle
            ? "heading"
            : "preamble",
      };
    }),
  };
};
