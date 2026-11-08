/** Retained strings are charged as UTF-16 bytes. Oversize chapters are served
 * to their consumer but never admitted to the cache. No DOM/Range lives here. */
export class TxtTextLRU {
  private entries = new Map<number, string>();
  private bytes = 0;
  constructor(readonly budget: number) {}
  get(key: number) {
    const value = this.entries.get(key);
    if (value !== undefined) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: number, value: string) {
    const previous = this.entries.get(key);
    if (previous !== undefined) { this.bytes -= previous.length * 2; this.entries.delete(key); }
    const bytes = value.length * 2;
    if (bytes > this.budget) return;
    while (this.bytes + bytes > this.budget && this.entries.size) {
      const oldest = this.entries.keys().next().value as number;
      this.bytes -= this.entries.get(oldest)!.length * 2; this.entries.delete(oldest);
    }
    this.entries.set(key, value); this.bytes += bytes;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  get stats() { return { cacheBytes: this.bytes, cacheEntries: this.entries.size, cacheBudget: this.budget }; }
}

/** A book is the sole owner of legacy section URLs. Each load owns one lease
 * until unload; concurrent consumers share a URL, and the last release revokes.
 * Internal consumers use text(), avoiding Blob/fetch altogether. */
export class TxtChapterResources {
  private cache = new TxtTextLRU(2 * 1024 * 1024);
  private pending = new Map<number, Promise<string>>();
  private leases = new Map<number, { refs: number; url?: string }>();
  private tail: Promise<unknown> = Promise.resolve();
  private dead = false;
  private active = 0;
  constructor(private loader: (index: number) => Promise<string>) {}
  text(index: number): Promise<string> {
    if (this.dead) return Promise.reject(Error("TXT book is closed"));
    const cached = this.cache.get(index);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.pending.get(index);
    if (existing) return existing;
    // Bound queued consumers as well as active I/O; never build an unbounded
    // speculative whole-book queue. Normal navigation/search reads serially.
    if (this.pending.size >= 32) return Promise.reject(Error("TXT chapter queue is full"));
    const request = this.tail.then(async () => {
      if (this.dead) throw Error("TXT book is closed");
      this.active++;
      try {
        const text = await this.loader(index);
        if (this.dead) throw Error("TXT book is closed");
        this.cache.set(index, text);
        return text;
      } finally { this.active--; }
    }).finally(() => { if (this.pending.get(index) === request) this.pending.delete(index); });
    this.pending.set(index, request);
    // The serial gate must not retain the last (possibly oversize) HTML result.
    this.tail = request.then(() => undefined, () => undefined);
    return request;
  }
  async load(index: number) {
    if (this.dead) throw Error("TXT book is closed");
    let lease = this.leases.get(index);
    if (!lease) { lease = { refs: 0 }; this.leases.set(index, lease); }
    lease.refs++;
    try {
      const text = await this.text(index);
      if (this.dead || this.leases.get(index) !== lease) throw Error("TXT section was released");
      if (!lease.url) lease.url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
      return lease.url;
    } catch (error) {
      if (this.leases.get(index) === lease) this.unload(index);
      throw error;
    }
  }
  unload(index: number) {
    const lease = this.leases.get(index);
    if (!lease || --lease.refs > 0) return;
    if (lease.url) URL.revokeObjectURL(lease.url);
    this.leases.delete(index);
  }
  destroy() {
    if (this.dead) return;
    this.dead = true;
    for (const lease of this.leases.values()) if (lease.url) URL.revokeObjectURL(lease.url);
    this.leases.clear(); this.cache.clear(); this.pending.clear(); this.tail = Promise.resolve();
    // In-flight I/O drains once; its result cannot publish/cache/create a URL.
    this.loader = async () => { throw Error("TXT book is closed"); };
  }
  get stats() { return { ...this.cache.stats, activeReads: this.active, pendingReads: this.pending.size,
    activeURLs: Array.from(this.leases.values()).filter(lease => lease.url).length,
    consumers: Array.from(this.leases.values()).reduce((n, lease) => n + lease.refs, 0), closed: this.dead }; }
}
