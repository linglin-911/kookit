const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const quiet = { beginDiagnostic: () => () => {} };
const load = require("./helpers/load-typescript.cjs")({
  "./diagnostics": quiet,
  "../utils/diagnostics": quiet,
  "../utils/layoutUtil": {},
  "../utils/navigationUtil": {},
  "../libs/cfi": {},
  "../utils/noteUtil": {},
  "../utils/animationUtil": {},
  "rangy/lib/rangy-core.js": {},
  "rangy/lib/rangy-textrange": {},
  "../utils/pdfUtil": {},
  "../utils/touchUtil": {},
  "../utils/speedReadingUtil": {},
  "../utils/readingRulerUtil": {},
  "../utils/paragraphModeUtil": {},
});
const root = path.resolve(__dirname, "../src");
const GeneralParser = load(path.join(root, "utils/generalParser.ts")).default;
const GeneralRender = load(path.join(root, "renders/GeneralRender.ts")).default;
const { cumulativeSumWithPrevious } = load(path.join(root, "utils/common.ts"));
const { getChapterWeights, getChapterStartPercentage, getRecordedPercentage,
  invalidateChapterWeights, flattenChapterTree } = load(path.join(root, "utils/chapterMetrics.ts"));

test("maps sections in order, preserves untitled sections and first shared-section TOC entry", async () => {
  const sections = [{ size: 1 }, { size: 2 }, { size: 3 }];
  const parser = new GeneralParser({ sections });
  parser.flattenChapters = [
    { index: 1, label: "first", href: "one" },
    { index: 1, label: "second", href: "two" },
    { index: 2, label: "last", href: "last" },
  ];
  assert.deepEqual(await parser.getChapterDoc(), [
    { label: "", href: "", text: sections[0] },
    { label: "first", href: "one", text: sections[1] },
    { label: "last", href: "last", text: sections[2] },
  ]);
  assert.deepEqual(await new GeneralParser({ sections: [] }).getChapterDoc(), []);
});

test("large section mapping reads TOC indices linearly", async () => {
  let reads = 0;
  const count = 15400;
  const parser = new GeneralParser({ sections: Array.from({ length: count }, () => ({ size: 1 })) });
  parser.flattenChapters = Array.from({ length: count }, (_, index) => ({
    get index() { reads++; return index; }, label: String(index), href: String(index),
  }));
  assert.equal((await parser.getChapterDoc()).length, count);
  assert.ok(reads <= 2 * count, `index reads: ${reads}`);
});

test("exclusive prefixes preserve numeric results without slicing the input", () => {
  const input = [2, 0, 3.5, -1];
  input.slice = () => { throw new Error("quadratic prefix slicing"); };
  assert.deepEqual(cumulativeSumWithPrevious(input), [0, 2, 2, 5.5]);
  assert.deepEqual(cumulativeSumWithPrevious([]), []);
});

test("progress matches the old formula for every chapter, including zero and missing sizes", () => {
  const chapters = [{ text: { size: 10 } }, { text: { size: 0 } },
    { text: {} }, { text: null }, { text: "plain text" }, { text: { size: 17.25 } }];
  const total = chapters.map(x => x.text ? x.text.size || 1 : 1).reduce((a,b) => a+b, 0);
  chapters.forEach((chapter, index) => {
    const prefix = chapters.slice(0,index).map(x => x.text ? x.text.size || 1 : 1).reduce((a,b) => a+b,0);
    assert.equal(getChapterStartPercentage(chapters,index),prefix/total);
    for (const ratio of [0, 0.25, 0.9, 1]) {
      const expected = prefix/total + ((chapter.text?.size || 0)/total)*ratio;
      assert.equal(getRecordedPercentage(chapters,index,ratio),expected);
    }
  });
  assert.equal(getRecordedPercentage([],0,0),0);
});

test("weights are cached, isolated between books, and invalidated by replacement or explicit mutation", () => {
  let reads = 0;
  const chapters = [{ text: { get size() { reads++; return 10; } } }];
  const first = getChapterWeights(chapters);
  const initialReads = reads;
  assert.equal(getChapterWeights(chapters),first);
  assert.equal(reads,initialReads);
  assert.notEqual(getChapterWeights([...chapters]),first);
  chapters.push({ text: { size: 20 } });
  assert.equal(getChapterWeights(chapters).total,30);
  chapters[1].text.size = 40;
  invalidateChapterWeights(chapters);
  assert.equal(getChapterWeights(chapters).total,50);
  const plain = [{ text: "four" }];
  assert.equal(getChapterWeights(plain).total,1);
  assert.equal(getChapterWeights(plain,"pages").total,4);
});

test("tree flattening keeps parent-first order and handles a deep tree without recursion", () => {
  const leaf = { label: "leaf", subitems: [] };
  const child = { label: "child", subitems: [leaf] };
  const parent = { label: "parent", subitems: [child] };
  assert.deepEqual(flattenChapterTree([parent,leaf]),[parent,child,leaf,leaf]);
  let nested = leaf;
  for (let i=0;i<10000;i++) nested = { subitems: [nested] };
  assert.equal(flattenChapterTree([nested]).length,10001);
});

test("renderer page cache follows chapter snapshot, page size and reader mode", () => {
  const renderer = Object.create(GeneralRender.prototype);
  renderer.chapterDocList = [{ text: { size: 10 } },{ text: { size: 20 } }];
  renderer.estimatedSizePerPage = 10;
  renderer.readerMode = "single";
  renderer.trigger = () => {};
  const first = renderer.getChapterSizes();
  assert.deepEqual(first.pages,[1,2]);
  assert.deepEqual(first.prefix,[0,10]);
  assert.equal(renderer.getChapterSizes(),first);
  renderer.estimatedSizePerPage = 5;
  assert.deepEqual(renderer.getPages(),[1,3]);
  renderer.readerMode = "double";
  assert.deepEqual(renderer.getPages(),[1,5]);
  renderer.chapterDocList = [{ text: { size: 30 } },{ text: { size: 10 } }];
  assert.deepEqual(renderer.getPages(),[1,13]);
  renderer.estimatedSizePerPage = null;
  assert.deepEqual(renderer.getPages(),[]);
});

test("renderer reuses flattened snapshots and replaces them on reparse", () => {
  const renderer = Object.create(GeneralRender.prototype);
  const chapters = [{ subitems: [] }];
  const first = renderer.flatChapter(chapters);
  assert.equal(renderer.flatChapter(chapters),first);
  assert.notEqual(renderer.flatChapter([...chapters]),first);
});
