import { beginDiagnostic, diagnosticError, diagnosticLog } from "../utils/diagnostics";

let keywords = [
  "章",
  "节",
  "回",
  "節",
  "卷",
  "部",
  "輯",
  "辑",
  "話",
  "集",
  "话",
  "篇",
  " ",
  "　",
];
let containChars = [];
// let containChars = ["[", "。", "；", ";"];
let startWithChars = [
  "CHAPTER",
  "Chapter",
  "序章",
  "前言",
  "声明",
  "写在前面的话",
  "后记",
  "楔子",
  "后序",
  "章节目录",
  "尾声",
  "聲明",
  "引子",
  "序言",
  "题记",
  "开篇",
  "开篇词",
  "卷首",
  "卷首语",
  "引言",
  "导言",
  "入话",
  "作者的话",
  "写在前面",
  "重要声明",
  "免责声明",
  "版权声明",
  "致读者",
  "特别说明",
  "终章",
  "大结局",
  "完结感言",
  "完结篇",
  "写在后面的话",
  "作者有话说",
  "感言",
  "番外",
  "番外篇",
  "外传",
  "特别篇",
  "特别篇目",
  "附录",
  "小剧场",
  "彩蛋",
  "寫在前面的話",
  "後記",
  "後序",
  "章節目錄",
  "尾聲",
  "題記",
  "開篇",
  "開篇詞",
  "卷首語",
  "導言",
  "入話",
  "作者的話",
  "寫在前面",
  "重要聲明",
  "免責聲明",
  "版權聲明",
  "致讀者",
  "特別說明",
  "終章",
  "大結局",
  "完結感言",
  "完結篇",
  "寫在後面的話",
  "作者有話說",
  "外傳",
  "特別篇",
  "特別篇目",
  "附錄",
  "小劇場",
];
let startWithNumAndChars = [" ", "　", "、", "·", ".", "：", ":"];
export const findLastIndex = (arr: any[], callback: (item: any) => boolean) => {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (callback(arr[i])) {
      return i;
    }
  }
  return -1;
};
export const txtToHtml = (
  text: string,
  parserRegex: string,
  bookLocation?: any,
  traceId?: string
) => {
  const finish = beginDiagnostic("TXT", "txtToHtml", {
    traceId: traceId || "unknown",
    textCharacters: text.length,
    refresh: bookLocation?.refresh === true,
    noTitle: bookLocation?.noTitle === true,
    noFallback: bookLocation?.noFallback === true,
    preserveLeadingBlankLines: bookLocation?.preserveLeadingBlankLines === true,
    chapterSection: bookLocation?.chapterSection === true,
  });
  const splitFinish = beginDiagnostic("TXT", "splitLines", {
    traceId: traceId || "unknown",
    textCharacters: text.length,
  });
  let lines = text.split("\n");
  if (lines.length === 1) {
    lines = text.split("\r");
  }
  splitFinish({ lineCount: lines.length });
  // 普通整书解析只丢弃文件开头的空白行；固定 500 行分块的后续章节
  // 必须保留块首空行，避免切块后丢失原文内容。
  if (bookLocation?.preserveLeadingBlankLines !== true) {
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
  }

  const htmlParts: string[] = []; // Use an array to store HTML parts
  let isRefresh = false;
  let noTitle = false;
  if (bookLocation && bookLocation.refresh) {
    isRefresh = true;
  }
  if (bookLocation && bookLocation.noTitle) {
    noTitle = true;
  }
  const noFallback = bookLocation?.noFallback === true;
  const chapterOffset = Number.isFinite(Number(bookLocation?.chapterOffset))
    ? Number(bookLocation.chapterOffset)
    : 0;
  if (noTitle) {
    diagnosticLog("info", "TXT", "conversionMode", {
      traceId: traceId || "unknown",
      mode: "fixed-500-lines",
      scope: bookLocation?.chapterSection === true ? "chapter" : "book",
      lineCount: lines.length,
    });
    //分章方式改成每500行分一章，且不进行标题识别
    let chapterIndex = 0;
    if (lines.length === 0) {
      // 纯空白行文件，避免生成空 HTML 导致 noTitle 兜底无限递归
      htmlParts.push(`<h1 class="hide">Chapter ${chapterOffset}</h1>`);
      chapterIndex = 1;
    }
    for (let i = 0; i < lines.length; i += 500) {
      const chapterLines = lines.slice(i, i + 500);
      htmlParts.push(`<h1 class="hide">Chapter ${chapterOffset + chapterIndex}</h1>`); // Push chapter title to array
      chapterLines.forEach((line) => {
        if (line.trim() === "") {
          htmlParts.push(`<p class="hide">${line}</p>`); // Push line break for empty lines
        } else {
          htmlParts.push(`<p>${line}</p>`); // Push line content to array
        }
      });
      chapterIndex++;
    }
  } else if (lines.length > 10000 && !isRefresh) {
    diagnosticLog("info", "TXT", "conversionMode", {
      traceId: traceId || "unknown",
      mode: "large-file-window",
      lineCount: lines.length,
    });
    if (!bookLocation || !bookLocation.chapterTitle) {
      bookLocation = {
        text: lines[0],
        chapterTitle: "",
        chapterDocIndex: 0,
      };
    }
    if (!bookLocation.text) {
      bookLocation.text = bookLocation.chapterTitle || "";
    }
    // --- Slicing and Title Identification Logic ---
    const targetLineFinish = beginDiagnostic("TXT", "findCurrentLine", {
      traceId: traceId || "unknown",
      lineCount: lines.length,
    });
    let targetLineIndex = lines.findIndex((item) => {
      // Optimization: cleanText called only once here if needed often
      return cleanText(item) === cleanText(bookLocation.text);
    });
    targetLineFinish({ targetLineIndex });
    if (targetLineIndex === -1) {
      targetLineIndex = 0;
    }

    // Slice the lines array
    const startIndex = Math.max(targetLineIndex - 3000, 0);
    const endIndex = Math.min(targetLineIndex + 3000, lines.length);
    const relevantLines = lines.slice(startIndex, endIndex); // Process only the relevant slice
    // Identify potential titles within the relevant slice
    const titleScanFinish = beginDiagnostic("TXT", "scanChapterTitles", {
      traceId: traceId || "unknown",
      windowLineCount: relevantLines.length,
    });
    const titlesInSlice = relevantLines.filter((item) => {
      return item && isTitle(item, parserRegex);
    });
    titleScanFinish({ detectedTitleCount: titlesInSlice.length });
    diagnosticLog("info", "TXT", "largeFileWindowScanned", {
      traceId: traceId || "unknown",
      startLine: startIndex,
      endLine: endIndex,
      windowLineCount: relevantLines.length,
      detectedTitleCount: titlesInSlice.length,
    });
    if (titlesInSlice.length <= 1) {
      // Fallback to processing the entire file if no titles found in slice
      diagnosticLog("warn", "TXT", "largeFileWindowFallback", {
        traceId: traceId || "unknown",
        reason: "insufficient-chapter-titles",
        detectedTitleCount: titlesInSlice.length,
        lineCount: lines.length,
      });
      finish({ fallback: "fixed-500-lines", lineCount: lines.length });
      return txtToHtml(text, parserRegex, { noTitle: true }, traceId);
    }

    // Create a Set of cleaned titles for fast lookup
    const cleanedTitlesSet = new Set(
      titlesInSlice.map((title) => cleanText(title))
    );

    let targetTitleIndex = findLastIndex(titlesInSlice, (item) => {
      return cleanText(item) === cleanText(bookLocation.chapterTitle);
    });
    if (targetTitleIndex === -1) {
      targetTitleIndex = 0;
    }

    // --- Prepending Logic (if needed) ---
    // This part seems related to chapter indexing, ensure it uses the correct indices based on the slice
    if (targetTitleIndex < parseInt(bookLocation.chapterDocIndex || "0") - 1) {
      let prependLength =
        parseInt(bookLocation.chapterDocIndex || "0") - targetTitleIndex;
      if (prependLength > 0) {
        for (let i = 0; i < prependLength; i++) {
          // Push to array instead of concatenating
          htmlParts.push(`<h1>Prepend ${i}</h1>`);
          htmlParts.push(`<p>Text ${i}</p>`);
        }
      }
    }

    // --- Main Loop for Relevant Lines ---
    for (const item of relevantLines) {
      // Iterate over the sliced array
      const cleanedItem = cleanText(item); // Clean once per line
      // Use the Set for O(1) average lookup
      if (cleanedItem && cleanedTitlesSet.has(cleanedItem)) {
        htmlParts.push(`<h1>${cleanedItem}</h1>`); // Push to array
      } else {
        if (item.trim() === "") {
          htmlParts.push(`<p class="hide">${item}</p>`); // Push line break for empty lines
          continue; // Skip further processing for empty lines
        }
        // Avoid cleaning again if not necessary, use original item for content
        htmlParts.push(`<p>${item}</p>`); // Push to array
      }
    }
  } else {
    diagnosticLog("info", "TXT", "conversionMode", {
      traceId: traceId || "unknown",
      mode: "full-file",
      scope: bookLocation?.chapterSection === true ? "chapter" : "book",
      lineCount: lines.length,
      refresh: isRefresh,
    });
    // --- Loop for Full File (if not large or no bookLocation) ---
    let lastTitleIndex = -1;
    let hasContentSinceTitle = false;
    for (const item of lines) {
      if (item && isTitle(item, parserRegex)) {
        if (lastTitleIndex !== -1 && !hasContentSinceTitle) {
          // 上一个章节只有标题没有正文，降级为正文段落，剔除出目录
          htmlParts[lastTitleIndex] = `<p>${htmlParts[lastTitleIndex].slice(
            4,
            -5
          )}</p>`;
        }
        lastTitleIndex = htmlParts.length;
        htmlParts.push(`<h1>${item}</h1>`); // Push to array
        hasContentSinceTitle = false;
      } else {
        if (item.trim() === "") {
          htmlParts.push(`<p class="hide">${item}</p>`); // Push line break for empty lines
          continue; // Skip further processing for empty lines
        }
        htmlParts.push(`<p>${item}</p>`); // Push to array
        hasContentSinceTitle = true;
      }
    }
    if (lastTitleIndex !== -1 && !hasContentSinceTitle) {
      // 文件末尾最后一个标题只有标题没有正文，降级为正文段落，剔除出目录
      htmlParts[lastTitleIndex] = `<p>${htmlParts[lastTitleIndex].slice(
        4,
        -5
      )}</p>`;
    }
  }

  // Join the array at the end
  const finalHtml = htmlParts.join("");

  if (noFallback || (finalHtml && finalHtml.includes("<h1"))) {
    finish({
      lineCount: lines.length,
      htmlCharacters: finalHtml.length,
      htmlParts: htmlParts.length,
    });
    return finalHtml;
  } else {
    diagnosticLog("warn", "TXT", "conversionFallback", {
      traceId: traceId || "unknown",
      reason: "no-chapter-heading-generated",
      lineCount: lines.length,
    });
    finish({ fallback: "fixed-500-lines", lineCount: lines.length });
    return txtToHtml(text, parserRegex, { noTitle: true }, traceId);
  }
};
export const cleanText = (str) => {
  return str
    .trim()
    .replace(/(\r\n|\n|\r|\t)/gm, "")
    .substring(0, 100)
    .split("")
    .filter(
      (item: string) =>
        item !== "=" && item !== "-" && item !== "_" && item !== "+"
    )
    .join("");
};
export const isTitle = (line: any, parserRegex: string = "") => {
  if (parserRegex) {
    return new RegExp(parserRegex).test(line);
  }
  line = cleanText(line); // Clean once per line
  return (
    line &&
    line.length < 50 &&
    !isContain(line) &&
    (isStartWithChars(line) ||
      (line.startsWith("第") && startWithDI(line)) ||
      (line.startsWith("卷") && startWithJUAN(line)) ||
      (line.indexOf("第") > -1 &&
        line.lastIndexOf("第") < 7 &&
        startWithDI(line.substr(line.indexOf("第")))))
  );
};

export interface TxtChapterIndexEntry {
  index: number;
  label: string;
  start: number;
  end: number;
  lineCount: number;
  size: number;
  hasTitle: boolean;
  fixedChunk: boolean;
}

export interface TxtChapterIndex {
  chapters: TxtChapterIndexEntry[];
  lineCount: number;
  mode: "chapter-headings" | "fixed-500-lines";
}

/**
 * Build a complete TXT chapter index without creating the full-book HTML or DOM.
 * Offsets use JavaScript string indices so each section can be sliced lazily later.
 */
export const buildTxtChapterIndex = (
  text: string,
  parserRegex: string = ""
): TxtChapterIndex => {
  const finish = beginDiagnostic("TXT", "scanChapterIndex", {
    textCharacters: text.length,
  });

  try {
    // Match txtToHtml's line splitting: prefer LF, and use CR only for CR-only files.
    const separator = text.includes("\n") ? "\n" : "\r";
    const getLineBounds = (start: number) => {
      const separatorIndex = text.indexOf(separator, start);
      return {
        end: separatorIndex === -1 ? text.length : separatorIndex,
        next: separatorIndex === -1 ? -1 : separatorIndex + 1,
      };
    };

    // txtToHtml discards leading blank lines before parsing.
    let contentStart = 0;
    while (contentStart <= text.length) {
      const bounds = getLineBounds(contentStart);
      if (text.slice(contentStart, bounds.end).trim() !== "") {
        break;
      }
      if (bounds.next === -1) {
        contentStart = text.length;
        break;
      }
      contentStart = bounds.next;
    }

    const headings: Array<{
      start: number;
      lineIndex: number;
      title: string;
    }> = [];
    const fallbackLineStarts: number[] = [];
    const titleRegex = parserRegex ? new RegExp(parserRegex) : null;
    const matchesTitle = (line: string): boolean => {
      if (titleRegex) {
        // isTitle() creates a fresh RegExp for each line; reset lastIndex to
        // preserve that behavior even when the configured pattern has g/y flags.
        titleRegex.lastIndex = 0;
        return titleRegex.test(line);
      }
      return isTitle(line);
    };

    let lineStart = contentStart;
    let lineCount = 0;
    let pendingHeading: {
      start: number;
      lineIndex: number;
      title: string;
    } | null = null;
    let hasContentSinceHeading = false;

    // Scan line-by-line without allocating a 300k+ element split("\n") array.
    while (contentStart < text.length && lineStart <= text.length) {
      if (lineCount % 500 === 0) {
        fallbackLineStarts.push(lineStart);
      }

      const bounds = getLineBounds(lineStart);
      const line = text.slice(lineStart, bounds.end);
      if (line && matchesTitle(line)) {
        // A heading with no non-empty body before the next heading is plain text,
        // matching txtToHtml's existing "empty chapter heading" behavior.
        if (pendingHeading && hasContentSinceHeading) {
          headings.push(pendingHeading);
        }
        pendingHeading = {
          start: lineStart,
          lineIndex: lineCount,
          title: line,
        };
        hasContentSinceHeading = false;
      } else if (pendingHeading && line.trim() !== "") {
        hasContentSinceHeading = true;
      }

      lineCount += 1;
      if (bounds.next === -1) {
        break;
      }
      lineStart = bounds.next;
    }

    if (pendingHeading && hasContentSinceHeading) {
      headings.push(pendingHeading);
    }

    const estimateSectionSize = (
      start: number,
      end: number,
      sectionLineCount: number,
      hasTitle: boolean,
      label: string,
      fixedChunk: boolean
    ) => {
      // Estimate the former HTML-based progress weight without retaining generated HTML.
      const textCharacters = Math.max(
        0,
        end - start - Math.max(0, sectionLineCount - 1)
      );
      const headingOverhead = hasTitle ? 2 : 0;
      const fixedHeadingOverhead = fixedChunk ? 22 + label.length : 0;
      return Math.max(
        1,
        textCharacters +
          sectionLineCount * 7 +
          headingOverhead +
          fixedHeadingOverhead
      );
    };

    const chapters: TxtChapterIndexEntry[] = [];

    if (headings.length > 0) {
      const firstHeading = headings[0];
      if (firstHeading.start > contentStart) {
        const start = contentStart;
        const end = Math.max(start, firstHeading.start - 1);
        const preambleLineCount = firstHeading.lineIndex;
        if (text.slice(start, end).trim() !== "") {
          const label = "";
          chapters.push({
            index: chapters.length,
            label,
            start,
            end,
            lineCount: preambleLineCount,
            size: estimateSectionSize(
              start,
              end,
              preambleLineCount,
              false,
              label,
              false
            ),
            hasTitle: false,
            fixedChunk: false,
          });
        }
      }

      headings.forEach((heading, headingIndex) => {
        const nextHeading = headings[headingIndex + 1];
        const start = heading.start;
        const end = nextHeading
          ? Math.max(start, nextHeading.start - 1)
          : text.length;
        const sectionLineCount = nextHeading
          ? nextHeading.lineIndex - heading.lineIndex
          : lineCount - heading.lineIndex;
        const label = heading.title.trim();
        chapters.push({
          index: chapters.length,
          label,
          start,
          end,
          lineCount: sectionLineCount,
          size: estimateSectionSize(
            start,
            end,
            sectionLineCount,
            true,
            label,
            false
          ),
          hasTitle: true,
          fixedChunk: false,
        });
      });

      finish({
        mode: "chapter-headings",
        lineCount,
        chapterCount: chapters.length,
        detectedHeadingCount: headings.length,
        fullBookHtmlGenerated: false,
        fullBookDomParsed: false,
      });
      return {
        chapters,
        lineCount,
        mode: "chapter-headings",
      };
    }

    // Preserve the existing 500-line fallback when no valid heading has body text.
    if (lineCount === 0) {
      const label = "Chapter 0";
      chapters.push({
        index: 0,
        label,
        start: contentStart,
        end: text.length,
        lineCount: 0,
        size: estimateSectionSize(
          contentStart,
          text.length,
          0,
          false,
          label,
          true
        ),
        hasTitle: false,
        fixedChunk: true,
      });
    } else {
      fallbackLineStarts.forEach((start, chunkIndex) => {
        const nextStart = fallbackLineStarts[chunkIndex + 1];
        const end = nextStart
          ? Math.max(start, nextStart - 1)
          : text.length;
        const sectionLineCount = Math.min(
          500,
          lineCount - chunkIndex * 500
        );
        const label = "Chapter " + chunkIndex;
        chapters.push({
          index: chunkIndex,
          label,
          start,
          end,
          lineCount: sectionLineCount,
          size: estimateSectionSize(
            start,
            end,
            sectionLineCount,
            false,
            label,
            true
          ),
          hasTitle: false,
          fixedChunk: true,
        });
      });
    }

    finish({
      mode: "fixed-500-lines",
      lineCount,
      chapterCount: chapters.length,
      detectedHeadingCount: 0,
      fullBookHtmlGenerated: false,
      fullBookDomParsed: false,
    });
    return {
      chapters,
      lineCount,
      mode: "fixed-500-lines",
    };
  } catch (error) {
    diagnosticError("TXT", "scanChapterIndex:failed", error, {
      textCharacters: text.length,
    });
    finish({ failed: true });
    throw error;
  }
};

const isContain = (line: string) => {
  return containChars.filter((item) => line.indexOf(item) > -1).length > 0;
};
const isStartWithChars = (line: string) => {
  return startWithChars.filter((item) => line.startsWith(item)).length > 0;
};
//过于敏感已弃用
const isStartWithNumAndChars = (line: string) => {
  return (
    startWithNumAndChars.filter(
      (item) =>
        line.indexOf(item) > -1 &&
        (/^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u842c\u96f6]+$/.test(
          line.substring(0, line.indexOf(item))
        ) ||
          /^\d+$/.test(line.substring(0, line.indexOf(item))))
    ).length > 0
  );
};
const startWithDI = (line) => {
  let flag = false;
  for (let i = 0; i < keywords.length; i++) {
    if (
      /^[\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4ebf\u5146\u5eff\u5345\u62fe\u4f70\u4edf\u58f9\u8d30\u53c1\u8086\u4f0d\u9646\u67d2\u634c\u7396\u4e24\u842c\u5169]+$/.test(
        line.substring(1, line.indexOf(keywords[i])).trim()
      ) ||
      /^\d+$/.test(line.substring(1, line.indexOf(keywords[i])).trim())
    ) {
      flag = true;
    }
    if (flag) break;
  }
  return flag;
};
const startWithJUAN = (line) => {
  let regExp =
    /^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u842c\u96f6]+$/;
  if (
    regExp.test(line.substring(1, line.indexOf(" "))) ||
    /^\d+$/.test(line.substring(1, line.indexOf(" ")))
  )
    return true;
  if (
    regExp.test(line.substring(1, line.indexOf("　"))) ||
    /^\d+$/.test(line.substring(1, line.indexOf("　")))
  )
    return true;
  if (
    regExp.test(line.substring(1, line.indexOf("·"))) ||
    /^\d+$/.test(line.substring(1, line.indexOf("·")))
  )
    return true;
  if (regExp.test(line.substring(1)) || /^\d+$/.test(line.substring(1)))
    return true;
  return false;
};
