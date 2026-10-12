let meshEpoch = 0,
  meshBusy = false,
  meshInit = null,
  meshEra = 0,
  meshJobId = null,
  meshPreprocess = null,
  meshCancel = null;
let meshDataRuntime = null,
  meshDeliveryPool = null;
const meshResults = [
  { index: 0, canvas: null, lease: null },
  { index: 1, canvas: null, lease: null },
];
let meshResultCount = 1;
const meshOutstanding = () => meshResults.some(slot => slot.lease);
const meshFree = () => meshResults.slice(0, meshResultCount).find(slot => !slot.lease);
function meshReady() {
  meshBuildMountains();
  if (!meshBusy && !meshInit && meshFree())
    meshPost({
      type: 'ready',
      era: meshEra,
      mesh: true,
      resultRegions: meshResultCount,
      availableResults: meshResults
        .slice(0, meshResultCount)
        .filter(slot => !slot.lease)
        .map(slot => slot.index),
      transport: { ...meshTransport },
    });
}
let meshStampField = null,
  meshMountainLease = null,
  meshMountainPending = [];
function meshBuildMountains() {
  if (meshBusy || meshMountainLease || !meshMountainPending.length) return;
  const m = meshMountainPending.shift();
  const rt = getTileDataRuntime(),
    a = rt.api;
  try {
    const begin = performance.now();
    rt.check(a.pt_seed(m.seed >>> 0 || 0));
    rt.check(a.mt_build(m.W, m.H));
    const Pw = a.mt_info(1),
      Ph = a.mt_info(2),
      ptr = a.mt_info(0),
      count = Pw * Ph;
    const packet = {
      Pw,
      Ph,
      s: 0.35,
      Pc: Pw / 0.35,
      cpuPrecision: 'float32',
      buildCPUms: performance.now() - begin,
      dA: rt.view(Float32Array, ptr, count),
      dB: rt.view(Float32Array, ptr + count * 4, count),
    };
    const transfer = serializeNativeData(packet, nativeDataFields(packet, ['dA', 'dB']), {
      token: m.id,
      signalOffset: a.mt_info(3),
      environment: rt.environment,
    });
    if (packet.delivery.shared)
      meshMountainLease = { id: m.id, incarnation: m.incarnation, signalOffset: packet.delivery.signalOffset };
    meshPost({ type: 'mountains', id: m.id, incarnation: m.incarnation, packet }, transfer);
    if (!packet.delivery.shared) a.mt_release();
  } catch (error) {
    a.mt_release();
    meshMountainLease = null;
    meshPost({ type: 'mountains-error', id: m.id, incarnation: m.incarnation, error: String(error.stack || error) });
  }
}
const meshFieldTransport = {
  requests: 0,
  builds: 0,
  buildMs: 0,
  bulkCrossThreadCopyBytes: 0,
  copyMs: 0,
  payloadMessages: 0,
};
const meshTransport = {
  responsePostCPUms: 0,
  publishSyncCPUms: 0,
  releaseMessageMs: 0,
  maxLeaseMs: 0,
  payloadMessages: 0,
  releaseMessages: 0,
  invalidReleases: 0,
  deferredResets: 0,
  bulkCrossThreadCopyBytes: 0,
};
var GPU_MESH_OPTIONS = { gpuGeometry: true };
const meshYieldChannel = (() => {
  try {
    return typeof MessageChannel === 'function' ? new MessageChannel() : null;
  } catch {
    return null;
  }
})();
let meshYieldResume = null;
if (meshYieldChannel)
  meshYieldChannel.port1.onmessage = () => {
    const resume = meshYieldResume;
    meshYieldResume = null;
    resume?.();
  };
const meshSleep = () =>
  new Promise(resolve => {
    if (meshYieldChannel) {
      meshYieldResume = resolve;
      meshYieldChannel.port2.postMessage(null);
    } else setTimeout(resolve, 0);
  });
const meshWasmCounters = () =>
  typeof peekGeometryWasmRuntime === 'function' ? peekGeometryWasmRuntime()?.counters() || null : null;
function meshReset() {
  const m = meshInit;
  if (!m) return;
  meshInit = null;
  try {
    GPU_MESH_OPTIONS = { gpuGeometry: true, ...m.meshOptions };
    configureStamps(m.stamps);
    configureNativePaint(m.nativepaint);
    meshDataRuntime =
      GPU_MESH_OPTIONS.binaryRecords && typeof getTileDataRuntime === 'function' ? getTileDataRuntime() : null;
    if (meshDataRuntime) meshDataRuntime.resetBanks();
    if (!meshDeliveryPool && typeof createTileDeliveryPool === 'function')
      meshDeliveryPool = createTileDeliveryPool((m.workerIndex || 0) === 0);
    meshPreprocess =
      m.tilePreprocess && m.tilePreprocess.mode !== 'main' ? tilePreprocessOptions(m.tilePreprocess) : null;
    world.W = m.W;
    world.H = m.H;
    world.kc = m.kc;
    world.hero = m.hero;
    world.first = m.first;
    world.seed = m.seed;
    TILE_GPU = false;
    if (typeof PLANS !== 'undefined') PLANS.clear();
    if (typeof SCRS !== 'undefined') SCRS.clear();
    world.geo = worldGeometry(m.W, m.H, m.s, m.maxTex);
    meshEra = m.era;
    meshResultCount = meshDataRuntime?.shared && m.resultRegions !== 1 ? 2 : 1;
    for (const slot of meshResults) {
      slot.lease = null;
      slot.canvas = null;
    }
    for (let i = 0; i < meshResultCount; i++) meshResults[i].canvas = createMeshCanvas(1, 1, GPU_MESH_OPTIONS);
    meshDataRuntime?.check(meshDataRuntime.api.pt_config(m.W, m.H, m.kc, m.hero, nativeStampMask(), m.objects ? 1 : 0));
    meshDataRuntime?.check(meshDataRuntime.api.pt_seed(m.seed >>> 0 || 0));
    {
      const close = LAYERS[CLOSE].pan * m.H,
        opening = (m.hero - 0.3 * m.W) / close,
        entered = Number.isFinite(m.first);
      meshDataRuntime?.check(
        meshDataRuntime.api.pt_anchors(
          opening * LAYERS[2].pan * m.H + 0.72 * m.W,
          entered ? m.first * close + 0.42 * m.W : -1e9,
          entered ? m.first * close + 0.77 * m.W : -1e9,
        ),
      );
    }
    meshDataRuntime?.check(meshDataRuntime.api.pt_world(m.s, m.maxTex));
    if (meshDataRuntime) meshDataRuntime.api.td_limit(32 * 1024 * 1024);
    meshReady();
  } catch (e) {
    meshPost({ type: 'error', era: m.era, error: 'Mesh initialization: ' + String(e.stack || e) });
  }
}
function meshBuildStampField(m) {
  try {
    if (!Number.isSafeInteger(m.id) || m.id < 1 || !Number.isSafeInteger(m.incarnation) || m.incarnation < 0)
      throw Error('Invalid stamp field request identity');
    const rt = getTileDataRuntime(),
      a = rt?.api;
    if (
      !a ||
      typeof a.stamp_field_build !== 'function' ||
      typeof a.stamp_field_ptr !== 'function' ||
      typeof a.stamp_field_bytes !== 'function'
    )
      throw Error('Native stamp field exports are unavailable');
    meshFieldTransport.requests++;
    if (!meshStampField) {
      const at = performance.now();
      if (a.stamp_field_build() !== 1) throw Error('Native stamp field build failed');
      const buildMs = performance.now() - at,
        ptr = a.stamp_field_ptr(),
        bytes = a.stamp_field_bytes();
      if (bytes !== 1048576 || ptr % 16 || ptr < 0 || ptr + bytes > rt.memory.buffer.byteLength)
        throw Error('Invalid native stamp field range');
      meshStampField = { ptr, bytes, buildMs };
      meshFieldTransport.builds++;
      meshFieldTransport.buildMs += buildMs;
    }
    const source = rt.view(Uint16Array, meshStampField.ptr, meshStampField.bytes / 2),
      shared = rt.shared;
    let buffer = source.buffer,
      byteOffset = source.byteOffset,
      copyMs = 0;
    if (!shared) {
      const at = performance.now(),
        pixels = new Uint16Array(source.length);
      pixels.set(source);
      buffer = pixels.buffer;
      byteOffset = 0;
      copyMs = performance.now() - at;
      meshFieldTransport.bulkCrossThreadCopyBytes += source.byteLength;
      meshFieldTransport.copyMs += copyMs;
    }
    const field = {
      width: 256,
      height: 256,
      layers: 2,
      format: 'rgba16float',
      buffer,
      byteOffset,
      length: source.length,
      shared,
      buildMs: meshStampField.buildMs,
      bulkCrossThreadCopyBytes: shared ? 0 : source.byteLength,
      copyMs,
      transport: { ...meshFieldTransport, payloadMessages: meshFieldTransport.payloadMessages + 1 },
    };
    meshPost({ type: 'stamp-field', id: m.id, incarnation: m.incarnation, field }, shared ? [] : [buffer]);
    meshFieldTransport.payloadMessages++;
  } catch (error) {
    meshPost({ type: 'stamp-field-error', id: m.id, incarnation: m.incarnation, error: String(error.stack || error) });
  }
}
self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'stamp-field') {
    meshBuildStampField(m);
    return;
  }
  if (m.type === 'mountains') {
    meshMountainPending.push(m);
    meshBuildMountains();
    return;
  }
  if (m.type === 'mountain-release') {
    const lease = meshMountainLease;
    if (lease && lease.id === m.id && lease.incarnation === m.incarnation && lease.id === m.token) {
      const rt = getTileDataRuntime(),
        signal = rt.view(Uint32Array, lease.signalOffset, 2);
      if (Atomics.load(signal, 1) === m.token) {
        rt.api.mt_release();
        meshMountainLease = null;
        meshBuildMountains();
      }
    }
    return;
  }
  if (m.type === 'recycle') {
    const slot = meshResults.find(
      slot =>
        slot.lease &&
        slot.lease.token === m.token &&
        slot.lease.era === m.era &&
        slot.lease.id === m.id &&
        slot.index === m.resultSlot,
    );
    if (slot) {
      const lease = slot.lease,
        signal = meshDataRuntime.view(Uint32Array, lease.signalOffset, 2);
      if (Atomics.load(signal, 1) !== lease.token) {
        meshTransport.invalidReleases++;
        return;
      }
      const at = nativeDataClock();
      meshTransport.releaseMessages++;
      meshTransport.maxLeaseMs = Math.max(meshTransport.maxLeaseMs, at - lease.postedAt);
      if (m.returnedAt) meshTransport.releaseMessageMs += Math.max(0, at - m.returnedAt);
      slot.lease = null;
      if (meshInit && !meshBusy && !meshOutstanding()) meshReset();
      else meshReady();
    } else if (m.buffer) {
      meshDeliveryPool?.recycle(m.token, m.buffer);
      meshReady();
    } else meshTransport.invalidReleases++;
    return;
  }
  if (m.type === 'init') {
    meshEpoch++;
    meshInit = m;
    meshDeliveryPool?.wake();
    if (meshOutstanding()) meshTransport.deferredResets++;
    if (!meshBusy && !meshOutstanding()) meshReset();
    return;
  }
  if (m.type === 'cancel') {
    if (meshBusy && !meshInit && m.era === meshEra && m.id === meshJobId && !meshCancel) {
      meshCancel = { era: m.era, id: m.id };
      meshEpoch++;
      meshDeliveryPool?.wake();
    }
    return;
  }
  if (m.type !== 'paint' || m.era !== meshEra) return;
  const result = meshFree();
  if (meshBusy || meshInit || !result) {
    meshPost({
      type: 'error',
      era: m.era,
      id: m.id,
      error: 'A mesh producer received a job without an available result region',
    });
    return;
  }
  meshBusy = true;
  meshJobId = m.id;
  meshCancel = null;
  const epoch = meshEpoch;
  const current = () => epoch === meshEpoch && m.era === meshEra && m.id === meshJobId;
  const wasmBefore = meshWasmCounters();
  const dataBefore = meshDataRuntime?.counters();
  const workerStarted = performance.now();
  let yieldCount = 0,
    yieldWallMs = 0;
  const handOver = async () => {
    const at = performance.now();
    yieldCount++;
    await meshSleep();
    yieldWallMs += performance.now() - at;
  };
  let ms = 0,
    t = performance.now(),
    it = null,
    paintDone = false;
  try {
    const g = world.geo[m.li];
    g.work = result.canvas;
    g.work.width = g.T + 2 * g.pad;
    g.work.height = g.Ht + 2 * g.pad;
    meshDataRuntime.check(meshDataRuntime.api.td_result_slot(result.index));
    meshDataRuntime.check(meshDataRuntime.api.pt_result_slot(result.index));
    it = paintTile(m);
    for (;;) {
      const done = it.next().done;
      if (done) paintDone = true;
      if (!current()) return;
      if (done) break;
      if (performance.now() - t > 8) {
        ms += performance.now() - t;
        await handOver();
        t = performance.now();
        if (!current()) return;
      }
    }
    const paintMs = ms + performance.now() - t,
      exportStart = performance.now();
    const mesh = g.work.exportMesh(),
      exportMs = performance.now() - exportStart;
    const objectCount = meshDataRuntime.api.pt_objects_count();
    if (objectCount) {
      mesh.objects = meshDataRuntime.view(Uint8Array, meshDataRuntime.api.pt_objects_ptr(), objectCount * 32);
    }
    mesh.stats.objectRows = objectCount;
    mesh.stats.objectBytes = objectCount * 32;
    let preprocessMs = 0;
    if (meshPreprocess) {
      t = performance.now();
      const planner = mesh.commandBank
        ? meshDataRuntime.preprocess(mesh, meshPreprocess, { era: m.era, id: m.id })
        : createTilePreprocessor(mesh, meshPreprocess, { era: m.era, id: m.id });
      for (;;) {
        const done = planner.stepOne();
        if (!current()) return;
        if (done) break;
        if (performance.now() - t > 8) {
          preprocessMs += performance.now() - t;
          await handOver();
          t = performance.now();
          if (!current()) return;
        }
      }
      mesh.preprocessed = planner.result();
      if (objectCount)
        mesh.objects = meshDataRuntime.view(Uint8Array, meshDataRuntime.api.pt_objects_ptr(), objectCount * 32);
      delete mesh.commands;
      preprocessMs += performance.now() - t;
    }
    if (!current()) return;
    const deliveryStart = performance.now();
    if (
      mesh.preprocessed &&
      meshDeliveryPool &&
      !(typeof SharedArrayBuffer === 'function' && mesh.vertices.buffer instanceof SharedArrayBuffer)
    ) {
      const bytes = tileDataDeliveryBytes(mesh);
      while (!meshDeliveryPool.canTake(bytes)) {
        await meshDeliveryPool.wait(bytes);
        if (!current()) return;
      }
    }
    const transfer =
      mesh.preprocessed && meshDeliveryPool
        ? serializeTileData(mesh, meshDeliveryPool, result.index)
        : mesh.preprocessed
          ? tilePreprocessedTransferables(mesh)
          : [mesh.vertices.buffer, mesh.paints.buffer];
    if (!mesh.preprocessed && mesh.version === 2) transfer.push(mesh.segments.buffer, mesh.transforms.buffer);
    if (!mesh.preprocessed && mesh.stamps?.byteLength) transfer.push(mesh.stamps.buffer);
    if (mesh.preprocessed && !meshDeliveryPool)
      mesh.preprocessed.transferBytes = transfer.reduce((n, b) => n + b.byteLength, 0);
    const deliveryMs = performance.now() - deliveryStart;
    if (mesh.delivery?.shared)
      result.lease = {
        token: mesh.delivery.token,
        era: m.era,
        id: m.id,
        postedAt: mesh.delivery.postedAt,
        signalOffset: mesh.delivery.signalOffset,
      };
    mesh.workerTimings = {
      paintMs,
      exportMs,
      preprocessMs,
      deliveryMs,
      preprocessMode: meshPreprocess ? 'worker' : 'main',
      wallMs: performance.now() - workerStarted,
      yieldCount,
      yieldWallMs,
      yieldMethod: meshYieldChannel ? 'message-channel' : 'timer',
      workerIndex: m.workerIndex ?? null,
      opening: !!m.opening,
    };
    const wasmAfter = meshWasmCounters(),
      wasmDelta = {};
    if (wasmAfter)
      for (const key of [
        'batches',
        'inputPointBytes',
        'inputMetadataBytes',
        'wasmToCommandCopies',
        'wasmToCommandBytes',
        'commandToExportCopies',
        'commandToExportBytes',
        'outputTriangles',
        'memoryGrowths',
        'oversizeFallbacks',
        'arenaSpaceFallbacks',
        'rangeLimitFallbacks',
        'pressureSweeps',
        'releasedRanges',
        'releasedBytes',
        'gcReleasedRanges',
      ]) {
        wasmDelta[key] = wasmAfter[key] - (wasmBefore?.[key] || 0);
      }
    mesh.workerDiagnostics = {
      scheduling: {
        wallMs: mesh.workerTimings.wallMs,
        yieldCount,
        yieldWallMs,
        yieldMethod: mesh.workerTimings.yieldMethod,
        workerIndex: m.workerIndex ?? null,
        opening: !!m.opening,
      },
      geometryWasm: {
        requested: GPU_MESH_OPTIONS.wasmGeometry !== false,
        requestedPrecision: 'f32',
        runtimePresent: !!wasmAfter,
        currentMemoryBytes: wasmAfter?.memoryBytes || 0,
        retainedAcrossJobs: true,
        cumulative: wasmAfter,
        jobDelta: wasmDelta,
      },
    };
    const dataAfter = meshDataRuntime?.counters();
    mesh.workerDiagnostics.tileData = {
      enabled: !!dataAfter,
      storage: mesh.preprocessed?.storage || 'legacy',
      resultRegion: result.index,
      resultRegions: meshResultCount,
      resultBytes: meshDataRuntime?.api.td_result_bytes(result.index) || 0,
      sameThreadDirectViews: !!dataAfter,
      shared: !!mesh.delivery?.shared,
      cumulative: dataAfter,
      allocations: dataAfter ? dataAfter.allocations - (dataBefore?.allocations || 0) : 0,
      memoryGrowths: dataAfter ? dataAfter.memoryGrowths - (dataBefore?.memoryGrowths || 0) : 0,
      delivery: meshDeliveryPool ? { ...meshDeliveryPool.stats } : null,
      copyMs: mesh.delivery?.copyMs || 0,
      usedBytes: mesh.delivery?.usedBytes || 0,
      bulkCrossThreadCopyBytes: mesh.delivery?.bulkCrossThreadCopyBytes || 0,
      environment: meshDataRuntime?.environment || null,
      transport: { ...meshTransport },
    };
    ms = paintMs + exportMs + preprocessMs;
    const postStart = performance.now();
    try {
      meshPost({ type: 'mesh', era: m.era, id: m.id, ms, paintMs, exportMs, preprocessMs, mesh }, transfer);
    } catch (error) {
      result.lease = null;
      throw error;
    }
    meshTransport.responsePostCPUms += performance.now() - postStart;
    meshTransport.payloadMessages++;
    meshTransport.bulkCrossThreadCopyBytes += mesh.delivery?.bulkCrossThreadCopyBytes || 0;
    meshTransport.publishSyncCPUms += mesh.delivery?.publishSyncCPUms || 0;
  } catch (e) {
    if (epoch === meshEpoch) meshPost({ type: 'error', era: m.era, id: m.id, error: String(e.stack || e) });
  } finally {
    try {
      if (it && !paintDone) it.return?.();
    } finally {
      const cancelled = meshCancel;
      meshCancel = null;
      meshBusy = false;
      meshJobId = null;
      if (meshInit && !meshOutstanding()) meshReset();
      else {
        if (cancelled) meshPost({ type: 'cancelled', era: cancelled.era, id: cancelled.id });
        meshReady();
      }
    }
  }
};
