import { createIframe, handleLayout } from "../utils/layoutUtil";
import GeneralRender from "./GeneralRender";
import { makeHtmlBook } from "../libs/html";
import GeneralParser from "../utils/generalParser";
import chardet from "chardet";
import { getCache } from "../libs/cache.js";
import {
  beginDiagnostic,
  diagnosticError,
} from "../utils/diagnostics";

class TxtRender extends GeneralRender {
  txtBuffer: ArrayBuffer;
  charset: string;
  parserRegex: string;
  constructor(txtBuffer: ArrayBuffer, config: any) {
    super({ ...config, format: "TXT" });
    this.txtBuffer = txtBuffer;
    this.charset = config.charset;
    this.parserRegex = config.parserRegex;
  }
  async renderTo(element: HTMLElement, bookLocation?: any): Promise<void> {
    const finish = beginDiagnostic("TXT", "renderTo", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
    });
    try {
      this.element = element;
      if (!this.book) {
        await this.parse(bookLocation);
      }
      const parser = new GeneralParser(this.book);
      const chapterFinish = beginDiagnostic("TXT", "buildChapterIndex", {
        traceId: this.diagnosticTraceId,
      });
      this.chapterList = await parser.getChapter(this.book.toc);
      this.chapterDocList = await parser.getChapterDoc();
      chapterFinish({
        chapterCount: this.chapterList.length,
        chapterDocCount: this.chapterDocList.length,
      });
      createIframe(element, this.isAllowScript);
      const doc = this.getDocument();
      if (!doc) {
        throw new Error("TXT reader iframe document is unavailable after creation");
      }
      handleLayout(element, this.readerMode, doc);
      finish({
        chapterCount: this.chapterList.length,
        chapterDocCount: this.chapterDocList.length,
        iframeReady: true,
      });
    } catch (error) {
      diagnosticError("TXT", "renderTo:failed", error, {
        traceId: this.diagnosticTraceId,
      });
      finish({ failed: true });
      throw error;
    }
  }
  async parse(bookLocation?: any) {
    const finish = beginDiagnostic("TXT", "parse", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
      charset: this.charset || "default",
      refresh: bookLocation?.refresh === true,
    });
    try {
      const textDecoder = new TextDecoder(this.charset);
      const bytes = new Uint8Array(this.txtBuffer);
      const decodeFinish = beginDiagnostic("TXT", "decode", {
        traceId: this.diagnosticTraceId,
        bufferBytes: bytes.byteLength,
        charset: this.charset || "default",
      });
      const text = textDecoder.decode(bytes);
      decodeFinish({ textCharacters: text.length });
      this.book = makeHtmlBook(
        text,
        true,
        this.parserRegex,
        bookLocation,
        this.diagnosticTraceId
      );
      finish({ textCharacters: text.length });
    } catch (error) {
      diagnosticError("TXT", "parse:failed", error, {
        traceId: this.diagnosticTraceId,
        bufferBytes: this.txtBuffer.byteLength,
      });
      finish({ failed: true });
      throw error;
    }
  }
  async refreshContent() {
    const finish = beginDiagnostic("TXT", "refreshContent", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
    });
    try {
      await this.parse({ refresh: true });
      const parser = new GeneralParser(this.book);
      this.chapterList = await parser.getChapter(this.book.toc);
      this.chapterDocList = await parser.getChapterDoc();
      await this.record();
      this.chapterSizeCache = null;
      finish({
        chapterCount: this.chapterList.length,
        chapterDocCount: this.chapterDocList.length,
      });
      return this.chapterList;
    } catch (error) {
      diagnosticError("TXT", "refreshContent:failed", error, {
        traceId: this.diagnosticTraceId,
      });
      finish({ failed: true });
      throw error;
    }
  }
  async preCache() {
    const finish = beginDiagnostic("TXT", "preCache", {
      traceId: this.diagnosticTraceId,
      bufferBytes: this.txtBuffer.byteLength,
    });
    try {
      if (!this.book) {
        await this.parse({ refresh: true });
      }
      const cache = await getCache(this.book);
      finish({ cacheCreated: Boolean(cache) });
      return cache;
    } catch (error) {
      diagnosticError("TXT", "preCache:failed", error, {
        traceId: this.diagnosticTraceId,
      });
      finish({ failed: true });
      throw error;
    }
  }

  async getMetadata(txtBuffer: ArrayBuffer) {
    const finish = beginDiagnostic("TXT", "getMetadata", {
      traceId: this.diagnosticTraceId,
      bufferBytes: txtBuffer.byteLength,
    });
    try {
      // Define the size of the chunk to read for detection (e.g., 4KB)
      const CHUNK_SIZE = 4096;
      const bufferLength = txtBuffer.byteLength;

      // Determine the actual size to read (up to CHUNK_SIZE or the file size if smaller)
      const sizeToRead = Math.min(bufferLength, CHUNK_SIZE);

      // Create a Uint8Array from the beginning chunk of the buffer
      const chunkArray = new Uint8Array(txtBuffer, 0, sizeToRead);

      // Detect the charset using only the chunk
      let detectedCharset = chardet.detect(chunkArray);

      // Fallback to utf8 if detection fails or returns null/undefined
      const charset = detectedCharset || "utf8";
      this.charset = charset;
      finish({ charset, bytesSampled: sizeToRead });

      return { charset: charset };
    } catch (error) {
      diagnosticError("TXT", "getMetadata:failed", error, {
        traceId: this.diagnosticTraceId,
        bufferBytes: txtBuffer.byteLength,
      });
      finish({ failed: true, fallbackCharset: "utf8" });
      // Fallback to utf8 in case of error during detection
      this.charset = "utf8";
      return { charset: "utf8" };
    }
  }
}

export default TxtRender;
