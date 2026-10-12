function createRemoteTilePainter(options = {}) {
  const ports = options.ports || (options.port ? [options.port] : []),
    now = options.now || (() => performance.now());
  if (!ports.length || ports.some(port => !port || typeof port.postMessage !== 'function'))
    throw Error('Remote tile painter requires a message port');
  const stats = {
    mode: 'generation-thread',
    threads: ports.length,
    era: null,
    disposed: false,
    attached: 0,
    ready: false,
    shared: null,
    accepted: 0,
    completed: 0,
    completedByThread: ports.map(() => 0),
    cancelRequests: 0,
    cancelled: 0,
    failed: 0,
    lostThreads: 0,
    replacements: 0,
    staleJobs: 0,
    staleMeshes: 0,
    busyRejections: 0,
    backpressure: 0,
    inFlight: 0,
    peakInFlight: 0,
    outstanding: 0,
    peakOutstanding: 0,
    producerActive: false,
    paintCPUms: 0,
    maxPaintCPUms: 0,
    nativePainterFlowers: 0,
    paintCountByWorldLayer: Array(8).fill(0),
    paintCPUmsByWorldLayer: Array(8).fill(0),
    maxPaintCPUmsByWorldLayer: Array(8).fill(0),
    exportCPUms: 0,
    preprocessCPUms: 0,
    deliveryCPUms: 0,
    copyBytes: 0,
    copyCPUms: 0,
    maxCopyCPUms: 0,
    messageMs: 0,
    maxMessageMs: 0,
    wallMs: 0,
    maxWallMs: 0,
    initWallMs: 0,
    firstReadyMs: 0,
    maxLeaseMs: 0,
    stampFieldRequests: 0,
    stampFieldCompleted: 0,
    stampFieldFailed: 0,
    stampFieldBuildMs: 0,
    stampFieldCopyBytes: 0,
    staleStampFields: 0,
  };
  let config = null,
    active = null,
    disposed = false,
    initAt = 0,
    createdAt = now(),
    lastDelivery = null;
  let fieldCache = null,
    fieldPromise = null,
    fieldRequest = null,
    fieldOwner = null,
    fieldSequence = 0;
  const mountainRequests = new Map();
  let mountainSequence = 0;
  function mountains(W, H, seed) {
    const thread = threads.find(t => !t.lost && !t.retired);
    if (disposed || !thread) return Promise.reject(Error('No live generation thread for mountains'));
    const id = ++mountainSequence;
    return new Promise((resolve, reject) => {
      const pending = {
        thread,
        resolve,
        reject,
        timer: setTimeout(() => {
          mountainRequests.delete(id);
          reject(Error('Mountain generation timed out'));
        }, options.jobTimeout || 60000),
      };
      mountainRequests.set(id, pending);
      if (!thread.postMessage({ type: 'mountains', id, incarnation: thread.incarnation, W, H, seed })) {
        clearTimeout(pending.timer);
        mountainRequests.delete(id);
        reject(Error('Mountain generation could not be sent'));
      }
    });
  }
  function rejectMountains(thread, reason) {
    for (const [id, p] of mountainRequests)
      if (!thread || p.thread === thread) {
        clearTimeout(p.timer);
        p.reject(Error(String(reason)));
        mountainRequests.delete(id);
      }
  }
  const idle = () => ({ advanced: false, done: false, steps: 0, cpuMs: 0 }),
    threads = [];
  const free = () => threads.find(thread => thread.ready && !thread.lost && !thread.retired) || null;
  function update() {
    stats.inFlight = active ? 1 : 0;
    stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
    stats.peakOutstanding = Math.max(stats.peakOutstanding, stats.outstanding);
    stats.producerActive = !!active;
    stats.ready = !!free();
  }
  function capacity() {
    if (disposed || !config || active || !free()) return 0;
    return options.capacity ? Math.max(0, options.capacity() | 0) : 1;
  }
  function signal() {
    update();
    if (!disposed) options.onReady?.({ era: config?.era, room: capacity() });
  }
  function clearTimers(thread) {
    clearTimeout(thread.startTimer);
    clearTimeout(thread.jobTimer);
    thread.startTimer = thread.jobTimer = null;
  }
  function rejectField(reason, thread = null) {
    const pending = fieldRequest;
    if (!pending || (thread && pending.thread !== thread)) return false;
    fieldRequest = null;
    fieldPromise = null;
    clearTimeout(pending.timer);
    stats.stampFieldFailed++;
    pending.reject(reason instanceof Error ? reason : Error(String(reason)));
    return true;
  }
  function clearFieldCache(thread = null) {
    if (thread && fieldOwner !== thread) return false;
    fieldCache = fieldPromise = fieldOwner = null;
    return true;
  }
  function retire(thread) {
    if (!thread) return;
    rejectMountains(thread, 'Mountain generation incarnation retired');
    rejectField('Stamp field generation incarnation retired', thread);
    clearFieldCache(thread);
    thread.retired = true;
    thread.ready = false;
    clearTimers(thread);
    thread.port.onmessage = thread.port.onmessageerror = null;
    try {
      thread.port.close();
    } catch {}
  }
  function makeThread(index, port, incarnation = 0) {
    const thread = {
      index,
      port,
      incarnation,
      ready: false,
      lost: false,
      retired: false,
      everReady: false,
      startTimer: null,
      jobTimer: null,
      meshInfo: { transport: nativeTransportStats() },
    };
    thread.postMessage = (message, transfer) => {
      if (disposed || thread.lost || thread.retired) return false;
      try {
        port.postMessage(message, transfer || []);
        return true;
      } catch (error) {
        lose(index, error, incarnation);
        return false;
      }
    };
    port.onmessage = event => handle(thread, event.data);
    port.onmessageerror = () => lose(index, 'Tile generation message could not be decoded', incarnation);
    return thread;
  }
  function sendInit(thread) {
    if (!config || thread.lost || thread.retired) return;
    thread.ready = false;
    if (!thread.everReady && !thread.startTimer)
      thread.startTimer = setTimeout(
        () => lose(thread.index, 'Tile generation thread did not start', thread.incarnation),
        options.startTimeout || 30000,
      );
    thread.postMessage({
      type: 'init',
      era: config.era,
      W: config.W,
      H: config.H,
      kc: config.kc,
      hero: config.hero,
      first: config.first,
      seed: config.seed,
      s: config.s,
      maxTex: config.maxTex,
      closePan: config.closePan,
      meshOptions: {
        gpuGeometry: config.tilePreprocess?.gpuPreparation !== false,
        wasmGeometry: 'f32',
        binaryRecords: true,
      },
      tilePreprocess: { mode: 'worker', ...(config.tilePreprocess || {}) },
      stamps: config.stamps,
      nativepaint: config.nativepaint,
      objects: !!config.objects,
      resultRegions: config.resultRegions ?? 2,
      workerIndex: thread.index,
    });
  }
  function received(thread, mesh, job, ms) {
    const timings = mesh.workerTimings || {},
      delivery = mesh.delivery || {},
      release = mesh.release,
      at = now();
    stats.completed++;
    stats.completedByThread[thread.index]++;
    stats.outstanding++;
    stats.shared = !!delivery.shared;
    stats.paintCPUms += timings.paintMs || 0;
    stats.exportCPUms += timings.exportMs || 0;
    stats.preprocessCPUms += timings.preprocessMs || 0;
    stats.deliveryCPUms += timings.deliveryMs || 0;
    stats.maxPaintCPUms = Math.max(stats.maxPaintCPUms, timings.paintMs || 0);
    stats.nativePainterFlowers += mesh.stats?.nativePainterFlowers || 0;
    const worldLayer = (job.sc === 'ja' ? 4 : 0) + (job.li | 0);
    if (worldLayer >= 0 && worldLayer < 8) {
      stats.paintCountByWorldLayer[worldLayer]++;
      stats.paintCPUmsByWorldLayer[worldLayer] += timings.paintMs || 0;
      stats.maxPaintCPUmsByWorldLayer[worldLayer] = Math.max(
        stats.maxPaintCPUmsByWorldLayer[worldLayer],
        timings.paintMs || 0,
      );
    }
    stats.copyBytes += delivery.bulkCrossThreadCopyBytes || 0;
    stats.copyCPUms += delivery.copyMs || 0;
    stats.maxCopyCPUms = Math.max(stats.maxCopyCPUms, delivery.copyMs || 0);
    stats.messageMs += delivery.messageReceiveMs || 0;
    stats.maxMessageMs = Math.max(stats.maxMessageMs, delivery.messageReceiveMs || 0);
    stats.wallMs += timings.wallMs || 0;
    stats.maxWallMs = Math.max(stats.maxWallMs, timings.wallMs || 0);
    lastDelivery = mesh.workerDiagnostics?.tileData?.delivery || null;
    let returned = false;
    mesh.release = () => {
      if (returned) return false;
      returned = true;
      stats.outstanding--;
      stats.maxLeaseMs = Math.max(stats.maxLeaseMs, now() - at);
      release?.call(mesh);
      if (!delivery.shared) signal();
      else update();
      return true;
    };
    update();
    try {
      options.onMesh({ job, mesh, ms });
    } catch (error) {
      mesh.release();
      stats.failed++;
      options.onFatal?.(error);
    }
  }
  function handle(thread, m) {
    if (!m || disposed || thread.lost || thread.retired || threads[thread.index] !== thread) return;
    if (m.type === 'mountains' || m.type === 'mountains-error') {
      const pending = mountainRequests.get(m.id);
      if (!pending || pending.thread !== thread || m.incarnation !== thread.incarnation) {
        if (m.type === 'mountains' && m.incarnation === thread.incarnation)
          try {
            ownNativeData(
              m.packet,
              thread,
              { type: 'mountain-release', id: m.id, incarnation: thread.incarnation },
              thread.meshInfo.transport,
            );
            m.packet.releaseData?.();
          } catch {}
        return;
      }
      mountainRequests.delete(m.id);
      clearTimeout(pending.timer);
      if (m.type === 'mountains-error') {
        pending.reject(Error(m.error));
        return;
      }
      try {
        const packet = m.packet;
        ownNativeData(
          packet,
          thread,
          { type: 'mountain-release', id: m.id, incarnation: thread.incarnation },
          thread.meshInfo.transport,
        );
        if (
          !(packet.Pw > 0 && packet.Ph > 0) ||
          packet.dA.length !== packet.Pw * packet.Ph ||
          packet.dB.length !== packet.dA.length
        )
          throw Error('Invalid mountain result');
        packet.release = () => packet.releaseData?.();
        pending.resolve(packet);
      } catch (error) {
        m.packet?.releaseData?.();
        pending.reject(error);
      }
      return;
    }
    if (m.type === 'stamp-field' || m.type === 'stamp-field-error') {
      const pending = fieldRequest;
      if (!pending || pending.thread !== thread || m.id !== pending.id || m.incarnation !== pending.incarnation) {
        stats.staleStampFields++;
        return;
      }
      if (m.type === 'stamp-field-error') {
        rejectField(Error('Native stamp field: ' + m.error), thread);
        return;
      }
      try {
        const f = m.field,
          shared = typeof SharedArrayBuffer === 'function' && f?.buffer instanceof SharedArrayBuffer;
        if (
          !f ||
          f.width !== 256 ||
          f.height !== 256 ||
          f.layers !== 2 ||
          f.format !== 'rgba16float' ||
          f.shared !== shared ||
          (!shared && !(f.buffer instanceof ArrayBuffer)) ||
          !Number.isSafeInteger(f.byteOffset) ||
          f.byteOffset < 0 ||
          f.byteOffset % 2 ||
          f.length !== 524288 ||
          f.byteOffset + 1048576 > f.buffer.byteLength ||
          !Number.isFinite(f.buildMs) ||
          f.buildMs < 0 ||
          f.bulkCrossThreadCopyBytes !== (shared ? 0 : 1048576)
        )
          throw Error('Invalid native stamp field payload');
        fieldCache = {
          width: f.width,
          height: f.height,
          layers: f.layers,
          format: f.format,
          pixels: new Uint16Array(f.buffer, f.byteOffset, f.length),
          buildMs: f.buildMs,
          bulkCrossThreadCopyBytes: f.bulkCrossThreadCopyBytes,
          copyMs: f.copyMs || 0,
          transport: f.transport || null,
        };
        fieldOwner = thread;
        fieldRequest = null;
        clearTimeout(pending.timer);
        stats.stampFieldCompleted++;
        stats.stampFieldBuildMs += f.buildMs;
        stats.stampFieldCopyBytes += f.bulkCrossThreadCopyBytes;
        pending.resolve(fieldCache);
      } catch (error) {
        rejectField(error, thread);
      }
      return;
    }
    if (m.type === 'attached') {
      stats.attached++;
      return;
    }
    if (m.type === 'ready') {
      if (m.transport) thread.generatorTransport = m.transport;
      if (m.era !== config?.era) return;
      if (!stats.firstReadyMs) stats.firstReadyMs = now() - createdAt;
      if (initAt) {
        stats.initWallMs = now() - initAt;
        initAt = 0;
      }
      clearTimeout(thread.startTimer);
      thread.startTimer = null;
      thread.everReady = true;
      thread.ready = true;
      stats.resultRegions = m.resultRegions ?? 1;
      thread.availableResults = m.availableResults || [0];
      signal();
      return;
    }
    const mine = active && active.thread === thread && active.job.era === m.era && active.job.id === m.id;
    if (m.type === 'cancelled') {
      if (!mine) return;
      clearTimeout(thread.jobTimer);
      thread.jobTimer = null;
      active = null;
      stats.cancelled++;
      signal();
      return;
    }
    if (m.type === 'mesh') {
      try {
        ownTileDelivery(m.mesh, thread);
      } catch (error) {
        lose(thread.index, error, thread.incarnation);
        return;
      }
      thread.ready = false;
      if (!mine) {
        stats.staleMeshes++;
        releaseTileDelivery(m.mesh);
        update();
        return;
      }
      const a = active;
      active = null;
      clearTimeout(thread.jobTimer);
      thread.jobTimer = null;
      if (a.cancelled || a.job.era !== config?.era || (options.isCurrent && !options.isCurrent(a.job))) {
        stats.staleMeshes++;
        releaseTileDelivery(m.mesh);
        signal();
        return;
      }
      received(thread, m.mesh, a.job, m.ms);
      signal();
      return;
    }
    if (m.type === 'error') {
      if (m.era !== undefined && m.era !== config?.era) return;
      lose(thread.index, Error('Tile generation thread: ' + m.error), thread.incarnation);
    }
  }
  function lose(index, reason, incarnation) {
    const thread = threads[index];
    if (
      !thread ||
      thread.lost ||
      thread.retired ||
      disposed ||
      (incarnation != null && incarnation !== thread.incarnation)
    )
      return false;
    rejectMountains(thread, reason || 'Mountain generation thread failed');
    rejectField(reason || 'Stamp field generation thread failed', thread);
    clearFieldCache(thread);
    thread.lost = true;
    thread.ready = false;
    clearTimers(thread);
    stats.lostThreads++;
    stats.failed++;
    const job = active?.thread === thread && !active.cancelled ? active.job : null;
    if (active?.thread === thread) active = null;
    update();
    const error = reason instanceof Error ? reason : Error(String(reason || 'Tile generation thread failed'));
    try {
      options.onRebuildRequest?.({ index, job, error, incarnation: thread.incarnation });
    } catch (callbackError) {
      options.onFatal?.(callbackError);
    }
    signal();
    return true;
  }
  function replacePort(index, port, incarnation) {
    const old = threads[index],
      nextIncarnation = incarnation ?? (old?.incarnation || 0) + 1;
    if (disposed || !old || !port || typeof port.postMessage !== 'function' || nextIncarnation <= old.incarnation) {
      try {
        port?.close();
      } catch {}
      return { accepted: false, job: null };
    }
    const job = active?.thread === old && !active.cancelled ? active.job : null;
    if (active?.thread === old) active = null;
    retire(old);
    const next = makeThread(index, port, nextIncarnation);
    threads[index] = next;
    stats.replacements++;
    sendInit(next);
    signal();
    return { accepted: true, job };
  }
  for (let index = 0; index < ports.length; index++)
    threads[index] = makeThread(index, ports[index], options.incarnations?.[index] || 0);
  function stampField() {
    if (disposed) return Promise.reject(Error('Remote tile painter disposed'));
    if (fieldPromise) return fieldPromise;
    const thread = threads.find(t => !t.lost && !t.retired);
    if (!thread) return Promise.reject(Error('No live generation incarnation for stamp field'));
    fieldPromise = new Promise((resolve, reject) => {
      fieldRequest = { id: ++fieldSequence, incarnation: thread.incarnation, thread, resolve, reject, timer: null };
    });
    const promise = fieldPromise,
      pending = fieldRequest;
    stats.stampFieldRequests++;
    pending.timer = setTimeout(
      () => lose(thread.index, 'Stamp field generation timed out', thread.incarnation),
      options.startTimeout || 30000,
    );
    if (!thread.postMessage({ type: 'stamp-field', id: pending.id, incarnation: pending.incarnation }))
      rejectField('Stamp field request could not be sent', thread);
    return promise;
  }
  function init(nextConfig) {
    if (disposed) return false;
    config = { ...nextConfig };
    stats.era = config.era;
    active = null;
    initAt = now();
    for (const thread of threads) {
      clearTimeout(thread.jobTimer);
      thread.jobTimer = null;
      sendInit(thread);
    }
    update();
    return true;
  }
  function paint(job) {
    if (disposed || !config) return { accepted: false, reason: disposed ? 'disposed' : 'uninitialized' };
    if (job.era !== config.era || (options.isCurrent && !options.isCurrent(job))) {
      stats.staleJobs++;
      return { accepted: false, reason: 'stale' };
    }
    const thread = active ? null : free();
    if (!thread) {
      stats.busyRejections++;
      return { accepted: false, reason: 'busy' };
    }
    if (!capacity()) {
      stats.backpressure++;
      return { accepted: false, reason: 'consumer' };
    }
    active = { job, thread, cancelled: false, at: now() };
    stats.accepted++;
    update();
    thread.jobTimer = setTimeout(
      () => lose(thread.index, 'Tile generation job timed out', thread.incarnation),
      options.jobTimeout || 60000,
    );
    const sent = thread.postMessage({
      type: 'paint',
      id: job.id,
      era: job.era,
      sc: job.sc,
      li: job.li,
      k: job.k,
      spread: false,
      cpuBitmap: false,
      workerIndex: thread.index,
      opening: !!job.opening,
    });
    return sent ? { accepted: true, slot: thread.index, token: job.id } : { accepted: false, reason: 'thread-failed' };
  }
  function cancel(era, id) {
    if (!active || active.cancelled || active.job.era !== era || active.job.id !== id) return false;
    active.cancelled = true;
    stats.cancelRequests++;
    active.thread.postMessage({ type: 'cancel', era, id });
    return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stats.disposed = true;
    rejectMountains(null, 'Remote tile painter disposed');
    rejectField('Remote tile painter disposed');
    clearFieldCache();
    active = null;
    for (const thread of threads) retire(thread);
    update();
  }
  function snapshot() {
    update();
    return {
      ...stats,
      completedByThread: [...stats.completedByThread],
      room: capacity(),
      delivery: lastDelivery,
      stampField: {
        ready: !!fieldCache,
        pending: !!fieldRequest,
        buildMs: fieldCache?.buildMs || 0,
        bulkCrossThreadCopyBytes: fieldCache?.bulkCrossThreadCopyBytes || 0,
        transport: fieldCache?.transport || null,
      },
      threadStates: threads.map(thread => ({
        incarnation: thread.incarnation,
        ready: thread.ready,
        lost: thread.lost,
        transport: { ...thread.meshInfo.transport },
        generatorTransport: thread.generatorTransport || null,
      })),
      transport: { ...threads[0].meshInfo.transport },
      generatorTransport: threads[0].generatorTransport || null,
      activeProducer: active
        ? {
            sc: active.job.sc,
            li: active.job.li,
            k: active.job.k,
            pri: active.job.pri,
            era: active.job.era,
            id: active.job.id,
            thread: active.thread.index,
            incarnation: active.thread.incarnation,
            cancelled: active.cancelled,
            ageMs: now() - active.at,
          }
        : null,
    };
  }
  return {
    remote: true,
    init,
    paint,
    stampField,
    mountains,
    step: idle,
    cancel,
    lose,
    replacePort,
    dispose,
    snapshot,
    stats,
    get config() {
      return config;
    },
    get room() {
      return capacity();
    },
    get busy() {
      return !!active;
    },
    get activeJob() {
      return active && !active.cancelled ? active.job : null;
    },
  };
}
