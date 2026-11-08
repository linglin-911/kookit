const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path");
const createLoader = require("./helpers/load-typescript.cjs");
const silent = {
  beginDiagnostic: () => () => {},
  diagnosticError: () => {},
  diagnosticLog: () => {},
};
const load = createLoader({ "../utils/diagnostics": silent });
const actual = load(path.join(__dirname, "../src/libs/txtIndex.ts"));
const TxtRender = createLoader({
  "./GeneralRender": class {
    removeContent() {}
  },
  "../utils/layoutUtil": {},
  "../libs/cache.js": {},
  "../utils/generalParser": {},
  "../utils/diagnostics": silent,
})(path.join(__dirname, "../src/renders/TxtRender.ts")).default;
function fixture(text) {
  const bytes = Buffer.from(text),
    reads = [];
  let cached = null,
    scans = 0,
    closed = 0;
  const store = {
    load: async (force) => (force ? null : cached),
    save: async (index) => {
      cached = index;
    },
    readSource: async () => {
      scans++;
      return bytes;
    },
    readChapter: async (chapter) => {
      reads.push(chapter.index);
      return new TextDecoder("utf-8", { ignoreBOM: true, fatal: true })
        .decode(bytes.subarray(chapter.byteStart, chapter.byteEnd))
        .replace(/\r\n?/g, "\n");
    },
    close: async () => {
      closed++;
    },
  };
  return { bytes, reads, store, scans: () => scans, closed: () => closed };
}
test("cold prepare returns metadata only; hot prepare does not read/decode original bytes", async () => {
  const f = fixture("第一章\r\n正文😀\r\n第二章\r末尾𠀀");
  const cold = await actual.prepareTxtIndex(f.store, "utf-8");
  assert.equal(f.scans(), 1);
  assert.equal(f.reads.length, 0);
  f.store.readSource = async () => {
    throw new Error("Whole-file read on hot open");
  };
  assert.equal(await actual.prepareTxtIndex(f.store, "utf-8"), cold);
  assert.ok(!("text" in cold) && !("buffer" in cold));
  assert.ok(
    cold.chapters.every(
      (c) => !Object.hasOwn(c, "body") && !Object.hasOwn(c, "text")
    )
  );
});
test("random TxtRender retains zero source bytes and deep jump reads only the target chapter", async () => {
  const f = fixture(
    Array.from(
      { length: 7700 },
      (_, i) => `Chapter ${i + 1}\r\n正文${i + 1}😀\r\n`
    ).join("")
  );
  const config = {
    charset: "utf-8",
    parserRegex: "^Chapter ",
    txtIndexStore: f.store,
  };
  const cold = new TxtRender(Uint8Array.from(f.bytes).buffer, config);
  await cold.parse();
  assert.equal(cold.txtBuffer.byteLength, 0);
  assert.equal(f.scans(), 1);
  assert.deepEqual(f.reads, []);
  for (const chapter of [1, 1600, 6800]) {
    const url = await cold.book.sections[chapter - 1].load();
    const html = await (await fetch(url)).text();
    assert.ok(html.includes(`正文${chapter}😀`));
  }
  assert.deepEqual(f.reads, [0, 1599, 6799]);
  const hot = new TxtRender(new ArrayBuffer(0), config);
  await hot.parse();
  assert.equal(f.scans(), 1);
  assert.equal(hot.txtBuffer.byteLength, 0);
  assert.equal(hot.book.sections.length, 7700);
  cold.removeContent();
  hot.removeContent();
  assert.equal(f.closed(), 2);
  assert.equal(cold.book, null);
});
test("explicit refresh rebuilds while a failed rebuild keeps the previous rendered book", async () => {
  const f = fixture("第一章\n正文");
  const reader = new TxtRender(new ArrayBuffer(0), {
    charset: "utf-8",
    parserRegex: "",
    txtIndexStore: f.store,
  });
  await reader.parse();
  await reader.parse({ refresh: true });
  assert.equal(f.scans(), 2);
  const previous = reader.book;
  f.store.save = async () => {
    throw new Error("source changed");
  };
  await assert.rejects(() => reader.parse({ refresh: true }), /source changed/);
  assert.equal(reader.book, previous);
  assert.equal(reader.txtBuffer.byteLength, 0);
  reader.removeContent();
});
test("random HTML adapter rejects incompatible normalized coordinates", async () => {
  const f = fixture("第一章\n正文");
  f.store.readChapter = async () => "wrong";
  const reader = new TxtRender(new ArrayBuffer(0), {
    charset: "utf-8",
    parserRegex: "",
    txtIndexStore: f.store,
  });
  await reader.parse();
  await assert.rejects(() => reader.book.sections[0].load(), /UTF-16 length/);
  reader.removeContent();
});

test("TXT directory and ID navigation never load intermediate bodies", async () => {
  const f = fixture("第一章\n正文甲\n第二章\n正文乙");
  const reader = new TxtRender(new ArrayBuffer(0), { charset: "utf-8", txtIndexStore: f.store });
  await reader.parse();
  const volatile = await reader.getTxtDirectory();
  assert.equal(volatile.chapters.length, 2);
  assert.deepEqual(f.reads, []);
  const fromDatabase = { generation: "pinned", chapters: volatile.chapters };
  f.store.readDirectory = async () => fromDatabase;
  assert.equal(await reader.getTxtDirectory(), fromDatabase);
  const targets = [];
  reader.goToChapterDocIndex = async (index) => targets.push(index);
  await reader.goToTxtChapter(volatile.chapters[1].chapterId, 1);
  await assert.rejects(() => reader.goToTxtChapter("other-generation", 1), /different index generation/);
  await assert.rejects(() => reader.goToTxtChapter(volatile.chapters[1].chapterId, -1));
  assert.deepEqual(targets, [1]);
  assert.deepEqual(f.reads, []);
  reader.removeContent();
});
