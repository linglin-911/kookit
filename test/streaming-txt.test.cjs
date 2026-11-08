const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const load = require("./helpers/load-typescript.cjs")({ "../utils/diagnostics": { beginDiagnostic: () => () => {}, diagnosticError() {} } });
const { scanTxtStream } = load(path.join(__dirname, "../src/libs/txtStreamIndex.ts"));
const { buildPersistentTxtIndex, decodeTxtSource } = load(path.join(__dirname, "../src/libs/txtIndex.ts"));
async function compare(text, encoding, pattern, chunkSize) {
  let bytes = encoding === "utf-16le" || encoding === "utf-16be" ? Buffer.from(text, "utf16le") : Buffer.from(text);
  if (encoding === "utf-16be") bytes.swap16();
  const source = decodeTxtSource(bytes, encoding), expected = buildPersistentTxtIndex(bytes, source, pattern);
  let chapters = [];
  async function* chunks() { for (let i = source.bomBytes; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize); }
  const header = await scanTxtStream(chunks(), { ...source, byteLength: bytes.length, parserRegex: pattern,
    id: () => "test-id", onHeadings: async () => { chapters = []; }, onChapter: async c => { chapters.push(c); } });
  const strip = c => { const { chapterId, ...rest } = c; return rest; };
  assert.deepEqual(header, Object.fromEntries(Object.entries(expected).filter(([k]) => k !== "chapters")), `${encoding}/${chunkSize} header`);
  assert.deepEqual(chapters.map(strip), expected.chapters.map(strip), `${encoding}/${chunkSize} ${JSON.stringify(text).slice(0, 60)}`);
}
for (const encoding of ["utf-8", "utf-16le", "utf-16be"]) test(`stream matches existing v1 coordinates/weights/features: ${encoding}`, async () => {
  for (const text of ["", "\ufeff", " \r\n\t", "\ufeff前言😀\r\n第一章 空标题\r第二章 正文\n\n甲𠀀\r\n第三章\r尾 \n", "第一章\n\n甲乙\n第二章\n第三章\n丁\n尾章", "Chapter 1\n甲\nChapter 2\n乙", "Chapter" + " ".repeat(1000) + "\n正文", Array.from({ length: 1201 }, (_, i) => i % 5 ? `正文${i}𠀀` : "").join("\r\n")])
    for (const size of [1, 7, 65536]) await compare(text, encoding, "", size);
  await compare("intro\n@@ One\n😀Body\n@@ Two\n𠀀Body\n", encoding, "^@@ ", 3);
});
test("large default-parser lines are summarized without retaining text; oversized custom lines fail clearly", async () => {
  await compare("正文".repeat(100000) + "\n尾", "utf-8", "", 65536);
  await assert.rejects(() => compare("正文".repeat(40000), "utf-8", "^Chapter", 65536), /custom parser line exceeds/);
});

test("GBK/GB18030 byte streams preserve multibyte boundaries and source features", async () => {
  for (const [encoding, hex] of [
    ["gbk", "b5dad2bbd5c20d0ad5fdcec40d0ab5dab6fed5c20ac4a9ceb2"],
    ["gb18030", "b5dad2bbd5c20a903081300ab5dab6fed5c20ad5fdcec4"],
    ["windows-1252", "4348415054455220310a80e90d0a4348415054455220320af1"],
  ]) {
    const bytes = Buffer.from(hex, "hex"), expected = buildPersistentTxtIndex(bytes, decodeTxtSource(bytes, encoding));
    let chapters = [];
    const header = await scanTxtStream((async function* () { for (const b of bytes) yield Buffer.from([b]); })(), {
      encoding, bomBytes: 0, byteLength: bytes.length, id: () => "id",
      onHeadings: async () => chapters = [], onChapter: async row => chapters.push(row),
    });
    const strip = ({ chapterId, ...row }) => row;
    assert.deepEqual({ ...header, chapters: chapters.map(strip) }, { ...expected, chapters: expected.chapters.map(strip) });
  }
});
test("trimmed title probes and feature summaries match v1 across many line/encoding boundaries", async () => {
  let seed = 417;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const lines = ["", " ", "\\t", "前言", "第一章", "Chapter 1", "正文😀 𠀀", "第 二 章", "尾", "Chapter" + " ".repeat(200), "Chapter" + "\\t".repeat(150) + " 2", "正文".repeat(100)];
  for (let i = 0; i < 100; i++) {
    const text = Array.from({ length: 2 + next(25) }, () => lines[next(lines.length)]).join(["\\n", "\\r", "\\r\\n"][next(3)]);
    await compare(text, ["utf-8", "utf-16le", "utf-16be"][next(3)], "", 1 + next(71));
  }
});
