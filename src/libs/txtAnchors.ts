import type { PersistentTxtChapter } from "./txtIndex";
const escapeHtml=(text:string)=>text.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
/** Each rendered line retains its exact normalized source interval. No Rangy
 * character count is ever reinterpreted as a TXT coordinate. */
export const mappedTxtHtml=(text:string,chapter:PersistentTxtChapter)=>{
  const parts:string[]=[];
  if(chapter.fixedChunk)parts.push(`<h1 class="hide">${escapeHtml(chapter.label)}</h1>`);
  let start=0,line=0;
  while(start<=text.length){const newline=text.indexOf("\n",start),end=newline<0?text.length:newline;
    const original=text.slice(start,end),tag=chapter.hasTitle&&line===0?"h1":"p";
    parts.push(`<${tag} data-txt-start="${start}" data-txt-end="${end}" data-txt-chapter="${escapeHtml(chapter.chapterId)}" data-txt-original="${escapeHtml(original)}"${original.trim()?"":' class="hide"'}>${escapeHtml(original)}</${tag}>`);
    if(newline<0)break;start=newline+1;line++;
  }return parts.join("");
};
const mappedElement=(node:Node):HTMLElement|null=>(node.nodeType===1?node as Element:node.parentElement)?.closest<HTMLElement>("[data-txt-start]")||null;
const textNodes=(element:HTMLElement)=>{
  const result:Text[]=[];const walker=element.ownerDocument.createTreeWalker(element,4,{acceptNode:node=>
    node.parentElement?.closest(".kookit-note-icon,.kookit-note-tooltip")?2:1});
  while(walker.nextNode())result.push(walker.currentNode as Text);return result;
};
const verify=(element:HTMLElement)=>{
  const nodes=textNodes(element),original=element.dataset.txtOriginal||"";
  if(nodes.map(n=>n.data).join("")!==original)throw new Error("Text transformations changed source positions");
  return nodes;
};
const pointOffset=(node:Node,offset:number)=>{
  const element=mappedElement(node);if(!element)throw new Error("Selection is outside TXT source");
  verify(element);const range=element.ownerDocument.createRange();range.selectNodeContents(element);range.setEnd(node,offset);
  return{element,position:Number(element.dataset.txtStart)+range.toString().length};
};
export const selectedTxtAnchor=(doc:Document,chapter:PersistentTxtChapter)=>{
  const selection=doc.getSelection();if(!selection||selection.rangeCount!==1||selection.isCollapsed)throw new Error("Select source text first");
  const range=selection.getRangeAt(0),start=pointOffset(range.startContainer,range.startOffset),end=pointOffset(range.endContainer,range.endOffset);
  if(start.element.dataset.txtChapter!==chapter.chapterId||end.element.dataset.txtChapter!==chapter.chapterId)throw new Error("A text binding must stay within one chapter");
  const body=chapter.bodyStart-chapter.start;
  if(start.position<body||end.position<=start.position)throw new Error("Select chapter body text");
  // Verify every intermediate line, including text-rule transformations inside
  // an otherwise unchanged pair of endpoints.
  for(const element of Array.from(doc.querySelectorAll<HTMLElement>("[data-txt-start]"))){
    if(Number(element.dataset.txtEnd)>=start.position&&Number(element.dataset.txtStart)<=end.position)verify(element);
  }
  return {chapterIndex:chapter.index,chapterId:chapter.chapterId,start:start.position-body,end:end.position-body};
};
export const txtRange=(doc:Document,chapter:PersistentTxtChapter,start:number,end:number)=>{
  const body=chapter.bodyStart-chapter.start;
  const resolve=(position:number)=>{
    const element=Array.from(doc.querySelectorAll<HTMLElement>("[data-txt-start]")).find(el=>el.dataset.txtChapter===chapter.chapterId&&Number(el.dataset.txtStart)<=position&&Number(el.dataset.txtEnd)>=position);
    if(!element)throw new Error("TXT source interval is unavailable");
    const nodes=verify(element);let remaining=position-Number(element.dataset.txtStart);
    for(const node of nodes){if(remaining<=node.length)return{node,offset:remaining};remaining-=node.length;}
    if(remaining===0)return{node:element as Node,offset:0};throw new Error("TXT source point is unavailable");
  };
  const first=resolve(body+start),last=resolve(body+end),range=doc.createRange();range.setStart(first.node,first.offset);range.setEnd(last.node,last.offset);return range;
};
