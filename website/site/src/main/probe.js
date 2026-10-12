if (SITE_DEBUG && SITE_CONFIG.debug) {
  const N = 16384,
    F = 8,
    data = new Float64Array(N * F),
    origin = performance.timeOrigin;
  let n = 0,
    dump = null;
  const longtasks = [];
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longtasks.push([origin + entry.startTime, entry.duration]);
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  const channel = new BroadcastChannel('zz-probe');
  channel.onmessage = event => {
    if (event.data?.type === 'dump') dump = event.data;
  };
  const round = value => Math.round(value * 1e6) / 1e6;
  const blockSpec = param('blockmain')?.split(',').map(Number);
  let blockMs = blockSpec?.[0] || 0,
    blockPeriod = blockSpec?.[1] || 2000,
    nextBlock = 0;
  const blocks = [];
  window.__blockmain = {
    step(now) {
      if (!(blockMs > 0) || !comp?.presented || OPENING.up) return;
      if (!nextBlock) {
        nextBlock = now + blockPeriod;
        return;
      }
      if (now < nextBlock) return;
      const start = performance.now(),
        at = origin + start;
      while (performance.now() - start < blockMs) {}
      if (blocks.length < 512) blocks.push([at, origin + performance.now()]);
      nextBlock = performance.now() + blockPeriod;
    },
    configure(ms = 0, period = 2000) {
      blockMs = Math.max(0, Math.min(1000, Number(ms) || 0));
      blockPeriod = Math.max(blockMs + 100, Number(period) || 2000);
      nextBlock = 0;
    },
    snapshot() {
      return { ms: blockMs, periodMs: blockPeriod, blocks: blocks.slice() };
    },
  };
  window.__blockmain.configure(blockMs, blockPeriod);
  window.__probe = {
    begin(now) {
      if (n >= N) return -1;
      const index = n++,
        offset = index * F;
      data.fill(0, offset, offset + F);
      data[offset] = origin + now;
      data[offset + 1] = origin + performance.now();
      return index;
    },
    set(index, column, value) {
      if (index >= 0) data[index * F + column] = value;
    },
    done(index, column, start) {
      if (index >= 0) data[index * F + column] = performance.now() - start;
    },
    reset() {
      n = 0;
      longtasks.length = 0;
      dump = null;
      channel.postMessage('reset');
    },
    request() {
      dump = null;
      channel.postMessage('dump');
    },
    get ready() {
      return !!dump;
    },
    main() {
      return {
        F,
        n,
        data: Array.from(data.subarray(0, n * F), round),
        longtasks: longtasks.map(row => row.map(round)),
      };
    },
    log() {
      return dump ? dump.log : null;
    },
    counts() {
      return dump ? dump.counts : null;
    },
    worker(from, to) {
      return dump
        ? {
            F: dump.F,
            n: dump.n,
            data: Array.from(dump.data.subarray(from * dump.F, Math.min(to, dump.n) * dump.F), round),
          }
        : null;
    },
  };
}
