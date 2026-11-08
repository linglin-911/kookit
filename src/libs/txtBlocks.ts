/** Rebuildable sparse byte/LF-normalized UTF-16 coordinates. No source text. */
export type TxtCheckpoint = [
    number,
    number
];
export const TXT_BLOCK_BYTES = 8192;
function prefix(bytes: Uint8Array, encoding: string, final: boolean) {
    const stride = encoding.startsWith("utf-16") ? 2 : 1;
    let end = Math.min(TXT_BLOCK_BYTES, bytes.length);
    end -= end % stride;
    // Prefer a paragraph boundary, with a hard limit even for a single long line.
    if (!final || end < bytes.length) {
        for (let i = end - stride; i >= TXT_BLOCK_BYTES / 2; i -= stride) {
            const value = stride === 1 ? bytes[i] : encoding === "utf-16le"
                ? bytes[i] | bytes[i + 1] << 8 : bytes[i] << 8 | bytes[i + 1];
            if (value === 10) {
                end = i + stride;
                break;
            }
        }
    }
    for (let attempts = 0; attempts < 5 && end > 0; attempts++, end -= stride) {
        try {
            const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
            // Never split CRLF, including a CR precisely on the physical block edge.
            if (text.endsWith("\r") && !(final && end === bytes.length)) {
                end -= stride;
                continue;
            }
            return { end, text };
        }
        catch { /* A multibyte character or UTF-16 surrogate pair crosses the edge. */ }
    }
    throw Error("Invalid TXT block encoding");
}
export function buildTxtCheckpoints(bytes: Uint8Array, encoding: string, bomBytes: number): TxtCheckpoint[] {
    const points: TxtCheckpoint[] = [[bomBytes, 0]];
    let offset = bomBytes, count = 0;
    while (offset < bytes.length) {
        const part = prefix(bytes.subarray(offset, Math.min(bytes.length, offset + TXT_BLOCK_BYTES + 4)), encoding, bytes.length - offset <= TXT_BLOCK_BYTES + 4);
        offset += part.end;
        count += part.text.replace(/\r\n?/g, "\n").length;
        points.push([offset, count]);
    }
    return points;
}
/** Buffer size is independent of book, chapter, paragraph and upstream chunk size. */
export async function* checkpointTxtStream(chunks: AsyncIterable<Uint8Array>, encoding: string, bomBytes: number, points: TxtCheckpoint[]) {
    const pending = new Uint8Array(TXT_BLOCK_BYTES + 4);
    let used = 0, offset = bomBytes, count = 0;
    points.push([offset, 0]);
    const take = (final: boolean) => {
        const part = prefix(pending.subarray(0, used), encoding, final);
        const bytes = pending.slice(0, part.end);
        pending.copyWithin(0, part.end, used);
        used -= part.end;
        offset += part.end;
        count += part.text.replace(/\r\n?/g, "\n").length;
        points.push([offset, count]);
        return bytes;
    };
    for await (const chunk of chunks) {
        for (let i = 0; i < chunk.length;) {
            const size = Math.min(pending.length - used, chunk.length - i);
            pending.set(chunk.subarray(i, i + size), used);
            used += size;
            i += size;
            if (used === pending.length)
                yield take(false);
        }
    }
    while (used)
        yield take(true);
}
