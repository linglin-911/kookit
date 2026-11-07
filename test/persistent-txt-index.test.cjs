const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const load = require("./helpers/load-typescript.cjs")({
  "../utils/diagnostics": {
    beginDiagnostic: () => () => {},
    diagnosticError: () => {},
    diagnosticLog: () => {},
  },
});
const { decodeTxtSource, buildPersistentTxtIndex } = load(
  path.join(__dirname, "../src/libs/txtIndex.ts")
);
const normalize = (text) => text.replace(/\r\n?/g, "\n");
const encode = (text, encoding, bom) => {
  let data;
  if (encoding === "utf-8") data = Buffer.from(text);
  else if (encoding === "gbk")
    data = Buffer.from([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 10, 0xd5, 0xfd, 0xce, 0xc4, 13, 10,
      0xb5, 0xda, 0xb6, 0xfe, 0xd5, 0xc2, 13, 0xbd, 0xe1, 0xce, 0xb2,
    ]);
  else {
    data = Buffer.from(text, "utf16le");
    if (encoding === "utf-16be") data.swap16();
  }
  const prefix = bom
    ? encoding === "utf-8"
      ? [0xef, 0xbb, 0xbf]
      : encoding === "utf-16le"
        ? [0xff, 0xfe]
        : [0xfe, 0xff]
    : [];
  return Buffer.concat([Buffer.from(prefix), data]);
};
for (const encoding of ["utf-8", "utf-16le", "utf-16be", "gbk"]) {
  for (const bom of encoding === "gbk" ? [false] : [false, true]) {
    test(`physical and normalized coordinates: ${encoding}, BOM=${bom}`, () => {
      const text =
        encoding === "gbk"
          ? "第一章\n正文\r\n第二章\r结尾"
          : "\r\n导读😀\r第一章 开始\r\n\r\n  😀 甲乙\n结 尾𠀀\r第二章 结束\n\t\n一\n";
      const bytes = encode(text, encoding, bom);
      const source = decodeTxtSource(bytes, encoding);
      assert.equal(source.text, normalize(text));
      const index = buildPersistentTxtIndex(bytes, source);
      assert.equal(index.chapters.length, encoding === "gbk" ? 2 : 3);
      for (const chapter of index.chapters) {
        const decoder = new TextDecoder(encoding, { ignoreBOM: true });
        assert.equal(
          normalize(
            decoder.decode(bytes.subarray(chapter.byteStart, chapter.byteEnd))
          ),
          source.text.slice(chapter.start, chapter.end)
        );
        assert.equal(
          normalize(
            decoder.decode(
              bytes.subarray(chapter.bodyByteStart, chapter.byteEnd)
            )
          ),
          source.text.slice(chapter.bodyStart, chapter.end)
        );
      }
      if (encoding !== "gbk") {
        assert.equal(index.chapters[1].firstChars, "😀甲");
        assert.equal(index.chapters[1].lastChars, "尾𠀀");
        assert.equal(index.chapters[2].firstChars, "一");
        assert.equal(index.chapters[2].lastChars, "一");
      } else {
        assert.equal(index.chapters[0].firstChars, "正文");
        assert.equal(index.chapters[1].lastChars, "结尾");
      }
      assert.ok(index.chapters.every((c) => c.chapterId && c.recognition));
    });
  }
}
test("empty files, BOM-only, whitespace, trailing newline, and fixed chunks preserve boundaries", () => {
  for (const text of [
    "",
    "\n\r\n ",
    "甲\r\n",
    Array.from({ length: 1101 }, (_, i) =>
      i % 500 === 0 ? "" : "普通文字😀"
    ).join("\r\n"),
  ]) {
    for (const encoding of ["utf-8", "utf-16le", "utf-16be"]) {
      const bytes = encode(text, encoding, true),
        source = decodeTxtSource(bytes, encoding);
      const index = buildPersistentTxtIndex(bytes, source);
      assert.ok(index.chapters.length);
      for (const c of index.chapters)
        assert.equal(
          normalize(
            new TextDecoder(encoding, { ignoreBOM: true }).decode(
              bytes.subarray(c.byteStart, c.byteEnd)
            )
          ),
          source.text.slice(c.start, c.end)
        );
    }
  }
});
test("byte newline scans survive code points crossing 4KB/64KB boundaries", () => {
  for (const n of [4094, 4095, 4096, 65534, 65535, 65536]) {
    const bytes = encode(
      "第一章\r\n" + "甲".repeat(n) + "😀\r\n第二章\r尾",
      "utf-8",
      true
    );
    const source = decodeTxtSource(bytes, "gbk"); // BOM wins over stale stored charset.
    const index = buildPersistentTxtIndex(bytes, source);
    assert.equal(index.encoding, "utf-8");
    assert.equal(index.chapters[0].lastChars, "甲😀");
    const c = index.chapters[1];
    assert.equal(
      new TextDecoder().decode(bytes.subarray(c.byteStart, c.byteEnd)),
      "第二章\r尾"
    );
  }
});
test("malformed bytes reject instead of persisting invented offsets", () => {
  assert.throws(() => decodeTxtSource(Uint8Array.from([0xf0, 0x9f]), "utf-8"));
  assert.throws(() => decodeTxtSource(Uint8Array.from([0x00]), "utf-16le"));
});
test("custom patterns and consecutive empty titles retain parser semantics", () => {
  const bytes = Buffer.from("# A\r\n# B\r\n正文\r\n# C\r\n");
  const index = buildPersistentTxtIndex(bytes, decodeTxtSource(bytes), "^# ");
  assert.deepEqual(
    index.chapters.map((c) => c.label),
    ["", "# B"]
  );
});
test("makeHtmlBook uses supplied SQLite index without rescanning; deep load renders only that section", async () => {
  const bytes = Buffer.from("第一章\n甲😀\n第二章\n乙𠀀");
  const source = decodeTxtSource(bytes),
    index = buildPersistentTxtIndex(bytes, source);
  const processor = load(path.join(__dirname, "../src/libs/textProcessor.ts"));
  const { makeHtmlBook } = require("./helpers/load-typescript.cjs")({
    "./textProcessor": {
      ...processor,
      buildTxtChapterIndex: () => {
        throw new Error("Full scan on hot open");
      },
    },
    "../utils/diagnostics": {
      beginDiagnostic: () => () => {},
      diagnosticError: () => {},
    },
  })(path.join(__dirname, "../src/libs/html.ts"));
  const book = makeHtmlBook(source.text, true, "", undefined, "test", index);
  assert.equal(book.sections.length, 2);
  const url = await book.sections[1].load();
  try {
    const html = await (await fetch(url)).text();
    assert.match(html, /乙𠀀/);
    assert.doesNotMatch(html, /甲😀/);
  } finally {
    URL.revokeObjectURL(url);
  }
});
test("TxtRender cold saves once, hot skips builder, refresh explicitly rebuilds", async () => {
  let built = 0,
    saved = 0,
    current = null;
  const actual = load(path.join(__dirname, "../src/libs/txtIndex.ts"));
  const TxtRender = require("./helpers/load-typescript.cjs")({
    "./GeneralRender": class {},
    "../utils/layoutUtil": {},
    "../libs/cache.js": {},
    "../utils/generalParser": {},
    "../libs/html": {
      makeHtmlBook: (text, isTxt, regex, loc, trace, index) => ({
        index,
        text,
      }),
    },
    "../libs/txtIndex": {
      ...actual,
      buildPersistentTxtIndex: (...args) => {
        built++;
        return actual.buildPersistentTxtIndex(...args);
      },
    },
    "../utils/diagnostics": {
      beginDiagnostic: () => () => {},
      diagnosticError: () => {},
    },
  })(path.join(__dirname, "../src/renders/TxtRender.ts")).default;
  const buffer = Uint8Array.from(Buffer.from("第一章\n正文")).buffer;
  const config = {
    charset: "utf-8",
    parserRegex: "",
    txtIndexStore: {
      load: async (force) => (force ? null : current),
      save: async (index) => {
        saved++;
        current = index;
      },
    },
  };
  const first = new TxtRender(buffer, config);
  await first.parse();
  const second = new TxtRender(buffer, config);
  await second.parse();
  assert.equal(built, 1);
  assert.equal(saved, 1);
  assert.deepEqual(second.book.index, first.book.index);
  await second.parse({ refresh: true });
  assert.equal(built, 2);
  assert.equal(saved, 2);
});
