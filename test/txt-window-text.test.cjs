const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const load=require('./helpers/load-typescript.cjs')();
const {resolveLegacyTxtPosition,searchTxtWindow}=load(path.join(__dirname,'../src/utils/txtWindowText.ts'));
function fixture(text,size=7,fixedChunk=false){
 const chapter={index:0,chapterId:'id',label:'Chapter 1',start:0,end:text.length,bodyStart:10,hasTitle:!fixedChunk,fixedChunk};let reads=0;
 const manager={async*readBlocks(){for(let start=0;start<text.length;start+=size){reads++;yield{chapter:0,start,end:Math.min(text.length,start+size),text:text.slice(start,start+size)};}}};
 return{chapter,manager,reads:()=>reads};
}
test('legacy DOM paragraph ordinals and XPath resolve normalized source with bounded cross-block probes',async()=>{
 const text='Chapter 1\nfirst\nsecond\nchosen 😀 line\nlast',f=fixture(text);
 for(const saved of [{count:'3',text:'chosen 😀 line'},{xpath:'/body/DocFragment[1]/p[3]'}])assert.equal(await resolveLegacyTxtPosition(f.manager,f.chapter,saved,()=>true),text.indexOf('chosen'));
 assert.equal(await resolveLegacyTxtPosition(f.manager,f.chapter,{cfi:'epubcfi(/4/8/1:7)'},()=>true),text.indexOf('chosen')+7);
 assert.equal(await resolveLegacyTxtPosition(f.manager,f.chapter,{count:'0'},()=>true),0);
 const long=fixture('Chapter 1\n'+'x'.repeat(300000)+'\nend',8192);
 assert.equal(await resolveLegacyTxtPosition(long.manager,long.chapter,{count:'2',text:'end'},()=>true),300011);
});
test('fixed chunk hidden title remains part of the legacy DOM ordinal',async()=>{
 const f=fixture('first\nchosen\nlast',5,true);
 assert.equal(await resolveLegacyTxtPosition(f.manager,f.chapter,{count:'2',text:'chosen'},()=>true),6);
});
test('streaming search finds physical-block crossings once and saves exact UTF-16 chapter coordinates',async()=>{
 const text='Chapter 1\n甲😀Needle甲needle\n',f=fixture(text,3);
 const result=await searchTxtWindow(f.manager,[f.chapter],'generation','needle',()=>true);
 assert.equal(result.records.length,2);assert.equal(result.hasMore,false);
 assert.deepEqual(result.records.map(row=>JSON.parse(row.cfi).txtWindow.offset),[text.indexOf('Needle'),text.indexOf('needle')]);
 assert.ok(result.records.every(row=>JSON.parse(row.cfi).txtWindow.generation==='generation'));
});
test('literal metacharacter search, capped materialization and cancellation do not turn into book-sized arrays',async()=>{
 const f=fixture('Chapter 1\n'+'.*?'.repeat(1000),20),result=await searchTxtWindow(f.manager,[f.chapter],'g','.*?',()=>true);
 assert.equal(result.records.length,200);assert.equal(result.hasMore,true);assert.ok(f.reads()<40);
 const cancelled=await searchTxtWindow(f.manager,[f.chapter],'g','.*?',()=>false);assert.deepEqual(cancelled.records,[]);
});
