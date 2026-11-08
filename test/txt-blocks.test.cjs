const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const load = require('./helpers/load-typescript.cjs')({ '../utils/diagnostics': { beginDiagnostic: () => () => {}, diagnosticError() {} } });
const { buildTxtCheckpoints, checkpointTxtStream } = load(path.join(__dirname, '../src/libs/txtBlocks.ts'));
for (const encoding of ['utf-8', 'utf-16le', 'utf-16be', 'gbk', 'gb18030']) {
  test(`sparse blocks round-trip paragraph/long-line/CRLF/surrogate edges: ${encoding}`, async () => {
    const text = 'x'.repeat(8191) + '\r\n' + '甲😀𠀀\ufeff'.repeat(10000) + '\r尾\n';
    let bytes;
    if (encoding === 'gbk') bytes = Buffer.concat([Buffer.alloc(8191, 120), Buffer.from([13, 10]), Buffer.from('d5fdcec4'.repeat(20000), 'hex')]);
    else if (encoding === 'gb18030') bytes = Buffer.concat([Buffer.alloc(8191, 120), Buffer.from([13, 10]), Buffer.from('90308130'.repeat(20000), 'hex')]);
    else { bytes = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le'); if (encoding === 'utf-16be') bytes.swap16(); }
    const expected = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, '\n');
    const points = buildTxtCheckpoints(bytes, encoding, 0), streamed = [], pieces = [];
    async function* chunks() { for (let n = 0; n < bytes.length; n += 997) yield bytes.subarray(n, n + 997); }
    for await (const part of checkpointTxtStream(chunks(), encoding, 0, streamed)) pieces.push(new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(part).replace(/\r\n?/g, '\n'));
    assert.deepEqual(points, streamed); assert.equal(pieces.join(''), expected);
    assert.equal(points.at(-1)[1], expected.length);
    points.slice(1).forEach((point, n) => {
      assert.ok(point[0] - points[n][0] <= 8192);
      assert.equal(pieces[n].length, point[1] - points[n][1]);
      assert.ok(!/^[\uDC00-\uDFFF]/.test(pieces[n]));
      assert.ok(!/[\uD800-\uDBFF]$/.test(pieces[n]));
    });
  });
}
test('invalid encoding at block boundary cannot be accepted as a partial block', () => {
  assert.throws(() => buildTxtCheckpoints(Buffer.concat([Buffer.alloc(8191, 120), Buffer.from([0xff])]), 'utf-8', 0));
});
