const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const load = require("./helpers/load-typescript.cjs")();
const { TxtTextLRU, TxtChapterResources } = load(path.join(__dirname,"../src/utils/txtResources.ts"));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
test("UTF-16 byte LRU updates recency, evicts, skips oversize and clears", () => {
  const cache = new TxtTextLRU(12);
  cache.set(1,"😀"); cache.set(2,"ab"); cache.set(3,"cd"); assert.equal(cache.stats.cacheBytes,12);
  cache.get(1); cache.set(4,"ef"); assert.equal(cache.get(2),undefined); assert.equal(cache.get(1),"😀");
  cache.set(4,"a"); assert.equal(cache.stats.cacheBytes,10);
  cache.set(5,"x".repeat(100)); assert.equal(cache.get(5),undefined);
  cache.clear(); assert.equal(cache.stats.cacheBytes,0);
});
test("overlapping section loads share I/O and URL until the last consumer releases", async () => {
  let reads=0; const owner=new TxtChapterResources(async()=>{reads++;return "<p>正文😀</p>";});
  const [a,b]=await Promise.all([owner.load(1),owner.load(1)]);
  assert.equal(a,b); assert.equal(reads,1); assert.equal(owner.stats.consumers,2);
  owner.unload(1); assert.equal(await (await fetch(b)).text(),"<p>正文😀</p>");
  assert.equal(owner.stats.activeURLs,1); owner.unload(1); assert.equal(owner.stats.activeURLs,0);
  await assert.rejects(fetch(a)); owner.destroy(); assert.equal(owner.stats.cacheBytes,0);
});
test("release-before-ready, destroy-during-read and failure never publish late URLs/cache", async () => {
  for(const mode of ["release","destroy","failure"]){
    const gate=deferred(),owner=new TxtChapterResources(()=>gate.promise);
    const pending=owner.load(1); await Promise.resolve();
    const rejected=assert.rejects(pending);
    if(mode==="release")owner.unload(1);else owner.destroy();
    if(mode==="failure")gate.reject(Error("injected read failure"));else gate.resolve("text");
    await rejected; owner.destroy();
    assert.equal(owner.stats.activeURLs,0);assert.equal(owner.stats.consumers,0);
    assert.equal(owner.stats.activeReads,0);assert.equal(owner.stats.pendingReads,0);assert.equal(owner.stats.cacheBytes,0);
  }
});
test("faulted direct reads retry, serial I/O and queue bounds include speculative work", async () => {
  let calls=0,active=0,maximum=0; const gate=deferred();
  const owner=new TxtChapterResources(async index=>{calls++;maximum=Math.max(maximum,++active);try{if(index===0)await gate.promise;return String(index);}finally{active--;}});
  const requests=Array.from({length:32},(_,i)=>owner.text(i));
  await assert.rejects(owner.text(32),/queue is full/);gate.resolve();await Promise.all(requests);
  assert.equal(maximum,1);assert.equal(calls,32);assert.equal(owner.stats.pendingReads,0);owner.destroy();
  let fail=true; const retry=new TxtChapterResources(async()=>{if(fail)throw Error("injected");return "ok";});
  await assert.rejects(retry.load(0),/injected/);fail=false;assert.equal(await retry.text(0),"ok");assert.equal(retry.stats.consumers,0);retry.destroy();
});
test("thousand direct chapter reads retain only the byte budget and create no URLs", async () => {
  const owner=new TxtChapterResources(async index=>String(index)+"x".repeat(2000));
  for(let i=0;i<1000;i++)await owner.text(i);
  assert(owner.stats.cacheBytes<=owner.stats.cacheBudget);assert(owner.stats.cacheEntries<1000);assert.equal(owner.stats.activeURLs,0);
  owner.destroy();await assert.rejects(owner.text(1),/closed/);
});
test("destroy cancels delayed engine event callbacks", async () => {
  const Emitter=load(path.join(__dirname,"../src/utils/EventEmitter.ts")).default,events=new Emitter();let calls=0;
  events.on("rendered",()=>calls++);events.trigger("rendered");events.disposeEvents();
  await new Promise(r=>setTimeout(r,120));assert.equal(calls,0);assert.equal(events.eventTimers.size,0);
});
