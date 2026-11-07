const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/libs/textProcessor.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const compiledModule = new Module(sourcePath, module);
compiledModule.filename = sourcePath;
compiledModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../utils/diagnostics") {
    return {
      beginDiagnostic: () => () => {},
      diagnosticError: () => {},
      diagnosticLog: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  compiledModule._compile(compiled, sourcePath);
} finally {
  Module._load = originalLoad;
}

const { buildTxtChapterIndex, txtToHtml } = compiledModule.exports;

test("builds a complete heading index and keeps preamble as an untitled section", () => {
  const sourceText =
    "导读\n\n第一章 开端\n正文一\n\n第二章 发展\n正文二";
  const result = buildTxtChapterIndex(sourceText);

  assert.equal(result.mode, "chapter-headings");
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.label),
    ["", "第一章 开端", "第二章 发展"]
  );
  assert.equal(
    sourceText.slice(result.chapters[0].start, result.chapters[0].end).trim(),
    "导读"
  );
  assert.match(
    sourceText.slice(result.chapters[1].start, result.chapters[1].end),
    /^第一章/
  );
});

test("demotes consecutive empty headings just like the existing HTML parser", () => {
  const sourceText = "第一章\n第二章\n正文\n第三章";
  const result = buildTxtChapterIndex(sourceText);

  assert.equal(result.mode, "chapter-headings");
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.label),
    ["", "第二章"]
  );
  assert.equal(
    sourceText.slice(result.chapters[0].start, result.chapters[0].end).trim(),
    "第一章"
  );
});

test("preserves the fixed 500-line fallback without building HTML", () => {
  const sourceText = Array.from(
    { length: 501 },
    (_, index) => "普通内容" + index
  ).join("\n");
  const result = buildTxtChapterIndex(sourceText);

  assert.equal(result.mode, "fixed-500-lines");
  assert.equal(result.chapters.length, 2);
  assert.equal(result.chapters[0].label, "Chapter 0");
  assert.equal(result.chapters[1].label, "Chapter 1");
  assert.equal(
    sourceText
      .slice(result.chapters[0].start, result.chapters[0].end)
      .split("\n").length,
    500
  );
});

test("supports custom chapter regular expressions", () => {
  const sourceText = "CHAPTER 1\nbody one\nCHAPTER 2\nbody two";
  const result = buildTxtChapterIndex(
    sourceText,
    "^CHAPTER\\s+\\d+$"
  );

  assert.equal(result.mode, "chapter-headings");
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.label),
    ["CHAPTER 1", "CHAPTER 2"]
  );
});

test("supports CRLF and CR-only line endings", () => {
  const crlf = buildTxtChapterIndex(
    "\r\n第一章\r\n正文一\r\n第二章\r\n正文二"
  );
  const crOnly = buildTxtChapterIndex(
    "第一章\r正文一\r第二章\r正文二"
  );

  assert.deepEqual(
    crlf.chapters.map((chapter) => chapter.label),
    ["第一章", "第二章"]
  );
  assert.deepEqual(
    crOnly.chapters.map((chapter) => chapter.label),
    ["第一章", "第二章"]
  );
});

test("returns one fallback chapter for an empty or all-blank file", () => {
  const empty = buildTxtChapterIndex("");
  const blank = buildTxtChapterIndex("\n \n\t");

  assert.equal(empty.chapters.length, 1);
  assert.equal(empty.chapters[0].label, "Chapter 0");
  assert.equal(blank.chapters.length, 1);
  assert.equal(blank.chapters[0].label, "Chapter 0");
});

test("renders untitled sections without recursively falling back and offsets fallback labels", () => {
  const preambleHtml = txtToHtml(
    "导读正文",
    "",
    { refresh: true, noFallback: true }
  );
  const fallbackHtml = txtToHtml(
    "普通内容",
    "",
    { noTitle: true, noFallback: true, chapterOffset: 7 }
  );

  assert.equal(preambleHtml, "<p>导读正文</p>");
  assert.match(fallbackHtml, /Chapter 7/);
});
