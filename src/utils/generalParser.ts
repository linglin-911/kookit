import Chapter from "../model/chapter";
import ChapterDoc from "../model/chapterDoc";
import { beginDiagnostic } from "./diagnostics";
import { flattenChapterTree } from "./chapterMetrics";
const isString = (value: any): boolean => {
  return typeof value === "string" || value instanceof String;
};
const joinMetadataValue = (value: any): string => {
  if (!value) return "";
  if (isString(value)) return String(value);
  if (Array.isArray(value)) {
    return value.map(joinMetadataValue).filter(Boolean).join(",");
  }
  return isString(value.name) ? String(value.name) : "";
};
class GeneralParser {
  book: any;
  chapterList: Chapter[];
  flattenChapters: Chapter[];
  chapterDocList: ChapterDoc[];
  constructor(book: any) {
    this.book = book;
    this.chapterList = [];
    this.flattenChapters = [];
    this.chapterDocList = [];
  }
  unescapeHtml(htmlStr: string): string {
    if (!htmlStr) return "";
    // Plain TXT chapter labels need no DOMParser; retain HTML decoding for markup/entities.
    if (!/[<&]/.test(htmlStr)) return htmlStr;
    const doc = new DOMParser().parseFromString(htmlStr, "text/html");
    return doc.documentElement.textContent || "";
  }
  async getChapter(toc) {
    if (toc) {
      this.chapterList = await Promise.all<Chapter>(
        toc.map(async (item, index) => {
          let chapterIndex = index;
          try {
            if (item.href) {
              const resolved = await this.book.resolveHrefIndex(item.href);
              if (resolved) {
                chapterIndex = resolved.index;
              }
            }
          } catch (error) {
            console.error(error);
          }

          const label = this.unescapeHtml(item.label);
          return {
            label: label || chapterIndex + "",
            href: item.href ? item.href : "title" + chapterIndex,
            index: chapterIndex,
            subitems: item.subitems ? await this.getChapter(item.subitems) : [],
          } as Chapter;
        })
      );
    } else {
      this.chapterList = await Promise.all<Chapter>(
        this.book.sections.map(async (item, index) => {
          const label = item && item.label ? this.unescapeHtml(item.label) : "";
          return {
            label: label || index + "",
            href: item && item.href ? item.href : "title" + index,
            index: index,
            subitems:
              item && item.subitems ? await this.getChapter(item.subitems) : [],
          } as Chapter;
        })
      );
    }
    this.flattenChapters = this.flatChapter(this.chapterList);
    return this.chapterList;
  }
  async getChapterDoc() {
    const finish = beginDiagnostic("Reader", "mapChapterDocuments", {
      sectionCount: this.book.sections.length,
      chapterCount: this.flattenChapters.length,
    });
    const chaptersByIndex = new Map<number, Chapter>();
    for (const chapter of this.flattenChapters) {
      // indexOf previously selected the first TOC entry for a shared section.
      if (!chaptersByIndex.has(chapter.index)) {
        chaptersByIndex.set(chapter.index, chapter);
      }
    }
    const documents = this.book.sections.map((item: ChapterDoc["text"], index: number) => {
      const chapter = chaptersByIndex.get(index);
      return {
        label: chapter?.label ?? "",
        href: chapter?.href ?? "",
        text: item,
      };
    }) as ChapterDoc[];
    finish({ documentCount: documents.length });
    return documents;
  }

  flatChapter(chapters: Chapter[]): Chapter[] {
    return flattenChapterTree(chapters);
  }

  getMetadata() {
    return new Promise<any>(async (resolve, reject) => {
      const metadata = this.book.metadata;
      const author = joinMetadataValue(metadata.author);
      const language = joinMetadataValue(metadata.language) || "en";
      const subject = joinMetadataValue(metadata.subject);
      try {
        const blob = await this.book.getCover();
        var reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          resolve({
            ...metadata,
            name: metadata.title,
            author: author,
            description: metadata.description,
            publisher: metadata.publisher,
            cover: reader.result,
            identifier: joinMetadataValue(metadata.identifier) || "",
            language: language,
            published: joinMetadataValue(metadata.published) || "",
            modified: joinMetadataValue(metadata.modified) || "",
            subject: subject,
            rights: joinMetadataValue(metadata.rights) || "",
            isbn: joinMetadataValue(metadata.isbn) || "",
            layout: joinMetadataValue(metadata.layout) || "",
          });
        };
      } catch (error) {
        console.error(error);
        try {
          resolve({
            ...metadata,
            name: metadata.title,
            author: author,
            description: metadata.description,
            publisher: metadata.publisher,
            cover: "",
            identifier: joinMetadataValue(metadata.identifier) || "",
            language: language,
            published: joinMetadataValue(metadata.published) || "",
            modified: joinMetadataValue(metadata.modified) || "",
            subject: subject,
            rights: joinMetadataValue(metadata.rights) || "",
            isbn: joinMetadataValue(metadata.isbn) || "",
            layout: joinMetadataValue(metadata.layout) || "",
          });
        } catch (error) {
          console.error(error);
          reject(error);
        }
      }
    });
  }
}

export default GeneralParser;
