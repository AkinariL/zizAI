let tileDataRuntime;
function getTileDataRuntime() {
  if (tileDataRuntime !== undefined) return tileDataRuntime;
  tileDataRuntime = null;
  const runtime = instantiateNativeRuntime(
    typeof TILE_DATA_WASM_BYTES === 'undefined' ? null : TILE_DATA_WASM_BYTES,
    typeof TILE_DATA_SHARED_WASM_BYTES === 'undefined' ? null : TILE_DATA_SHARED_WASM_BYTES,
    globalThis.GPU_MESH_OPTIONS?.sharedMemory === false,
  );
  if (!runtime) return null;
  const { api, memory } = runtime;
  let current, f32, u32;
  function refresh() {
    if (current !== memory.buffer) {
      current = memory.buffer;
      f32 = new Float32Array(current);
      u32 = new Uint32Array(current);
    }
  }
  const check = ok => {
    if (!ok) throw Error('Tile data workspace capacity/operation error ' + api.td_counter(5));
    refresh();
    return ok;
  };
  function view(Type, at, count) {
    refresh();
    return new Type(current, at, count);
  }
  function writeMaterial(p) {
    refresh();
    f32.set(p, api.td_scratch(0) / 4);
  }
  function writeNumbers(p) {
    refresh();
    const at = api.td_scratch(1) / 4;
    for (let i = 0; i < 9; i++) f32[at + i] = p[i] || 0;
  }
  function counters() {
    return {
      memoryBytes: memory.buffer.byteLength,
      maxMemoryBytes: api.td_max_memory(),
      allocations: api.td_counter(0),
      reusedBlocks: api.td_counter(1),
      memoryGrowths: api.td_counter(2),
      releasedBlocks: api.td_counter(3),
      highWaterBytes: api.td_counter(4),
      fanBatches: api.td_counter(6),
      fanFloats: api.td_counter(7),
      tileBankSwaps: api.td_counter(8),
      liveViews: true,
      retainedCommandObjects: 0,
      fixedPlannerOps: 32768,
      fixedPlannerNodes: 8192,
    };
  }
  function createBank(handle = check(api.td_bank())) {
    const info = key => api.td_info(handle, key);
    const bank = {
      handle,
      get length() {
        return info(1);
      },
      clear() {
        api.td_clear(handle);
      },
      reserve(commands, floats, segments = 256, paints = 256, matrices = 256, stamps = 0) {
        check(api.td_reserve(handle, commands, floats, segments, paints, matrices, stamps));
      },
      path(kind, vertices, count, paint, bounds, convex = false, radius = 0) {
        const at = check(api.td_vertex_space(handle, vertices.length));
        refresh();
        f32.set(vertices, at / 4);
        writeMaterial(paint);
        writeNumbers(bounds);
        f32[api.td_scratch(1) / 4 + 4] = radius;
        check(api.td_path(handle, kind, vertices.length, count, convex ? 1 : 0));
      },
      fans(input, forcePositive, paint, bounds, convex = false) {
        refresh();
        let count = 0,
          floats = 0;
        const pa = api.td_scratch(3) / 4,
          ma = api.td_scratch(4) / 4;
        for (const contour of input) {
          const p = contour.points || contour;
          let n = p.length;
          if (n > 1 && Math.abs(p[0][0] - p[n - 1][0]) < 1e-9 && Math.abs(p[0][1] - p[n - 1][1]) < 1e-9) n--;
          if (n < 3) continue;
          if (count >= 4096 || floats + n * 2 > 131072) return false;
          u32[ma + count * 4] = floats;
          u32[ma + count * 4 + 1] = n;
          count++;
          for (let i = 0; i < n; i++) {
            f32[pa + floats++] = p[i][0];
            f32[pa + floats++] = p[i][1];
          }
        }
        if (!count) return true;
        const output = api.td_fans(handle, count, forcePositive ? 1 : 0);
        refresh();
        if (!output) {
          check(!api.td_counter(5));
          return true;
        }
        writeMaterial(paint);
        writeNumbers(bounds);
        check(api.td_path(handle, 1, output, output / 2, convex ? 1 : 0));
        return true;
      },
      parametric(segments, count, paint, bounds) {
        const first = info(13);
        for (const segment of segments) {
          refresh();
          f32.set(segment.data, api.td_scratch(0) / 4);
          const at = api.td_scratch(2) / 4;
          f32.fill(0, at, at + 8);
          f32.set(segment.matrix, at);
          check(api.td_segment(handle, segment.data[1]));
        }
        writeMaterial(paint);
        writeNumbers(bounds);
        check(api.td_parametric(handle, first, count));
      },
      group(source, sourceRect, destRect, alpha) {
        refresh();
        const at = api.td_scratch(1) / 4;
        f32.set(sourceRect, at);
        f32.set(destRect, at + 4);
        f32[at + 8] = alpha;
        check(api.td_group(handle, source.handle));
      },
      exportPacket(width, height, version, sourceStats) {
        const vertices = view(Float32Array, info(4), info(5)),
          paints = view(Float32Array, info(8), info(9) * 64),
          stamps = view(Float32Array, info(24), info(25) * 32);
        return {
          version,
          width,
          height,
          vertices,
          paints,
          stamps,
          segments: view(Float32Array, info(12), info(13) * 16),
          transforms: view(Float32Array, info(16), info(17) * 8),
          generatedVertexCount: info(20),
          commandBank: handle,
          stats: {
            ...sourceStats,
            retainedCommandObjects: 0,
            commandStorage: 'wasm-contiguous-bank',
            vertexBytes: vertices.byteLength,
            paintBytes: paints.byteLength,
            stampBytes: stamps.byteLength,
          },
        };
      },
    };
    return bank;
  }
  function preprocess(packet, options, identity) {
    const config = tilePreprocessOptions(options),
      info = api.td_plan_info;
    check(
      api.td_plan_begin(
        packet.commandBank,
        packet.width,
        packet.height,
        config.limits.maxTextureDimension2D,
        config.gpuPreparation ? 1 : 0,
        config.convexInstancing ? 1 : 0,
      ),
    );
    const state = { phase: 'walk' };
    return {
      state,
      stepOne() {
        const status = api.td_plan_step(64);
        check(status);
        state.phase = ['none', 'walk', 'pack', 'records', 'geometry', 'geometry', 'ready'][info(0)];
        return status === 2;
      },
      result() {
        if (info(0) !== 6) throw Error('Binary tile plan is incomplete');
        const bank = packet.commandBank,
          bankInfo = key => api.td_info(bank, key);
        packet.vertices = view(Float32Array, bankInfo(4), bankInfo(5));
        packet.paints = view(Float32Array, bankInfo(8), bankInfo(9) * 64);
        packet.segments = view(Float32Array, bankInfo(12), bankInfo(13) * 16);
        packet.transforms = view(Float32Array, bankInfo(16), bankInfo(17) * 8);
        packet.stamps = view(Float32Array, bankInfo(24), bankInfo(25) * 32);
        const opCount = info(1),
          nodeCount = info(2),
          gpuOpCount = info(3),
          stageCount = info(4),
          stats = view(Uint32Array, info(8), 24);
        const p = {
          version: 2,
          storage: 'wasm-index-tables',
          config,
          identity: { era: identity.era, id: identity.id },
          consumed: false,
          packetVersion: packet.version,
          width: packet.width,
          height: packet.height,
          vertexLength: packet.vertices.length,
          paintLength: packet.paints.length,
          segmentLength: packet.segments.length,
          transformLength: packet.transforms.length,
          stampLength: packet.stamps.length,
          generatedVertexCount: packet.generatedVertexCount,
          opCount,
          nodeCount,
          gpuOpCount,
          stageCount,
          gpuPreparation: config.gpuPreparation && gpuOpCount > 0,
          preparedVertexCount: info(6),
          iterations: info(7),
          opData: view(Uint32Array, info(10), opCount * 12),
          opWork: view(Float32Array, info(11), opCount * 2),
          nodeData: view(Uint32Array, info(12), nodeCount * 8),
          nodeOps: view(Uint32Array, info(13), opCount),
          stageData: view(Uint32Array, info(14), stageCount * 6),
          stageNodes: view(Uint32Array, info(15), info(5)),
          nodeGeo: view(Float32Array, info(20), nodeCount * 8),
          recordData: view(Float32Array, info(17), Math.max(16, opCount * 16)),
          prepareData: gpuOpCount ? view(Uint32Array, info(18), Math.max(8, gpuOpCount * 8)) : null,
          taskData: gpuOpCount ? view(Uint32Array, info(19), Math.ceil(packet.segments.length / 16 / 4) * 4) : null,
        };
        packet.segments = view(Float32Array, info(21), packet.segments.length);
        const s = tileDataPlanStats(packet);
        Object.assign(s, {
          paths: stats[0],
          directConvexPaths: stats[1],
          analyticStrokePaths: stats[2],
          analyticSegments: stats[3],
          groups: stats[4],
          fallbackPaths: stats[5],
          fallbackPathVertexCount: stats[6],
          parametricPaths: stats[7],
          trianglePathTriangles: stats[8] - stats[2] * 2,
          renderTriangles: stats[8],
          triangles: stats[8],
          preparedBatches: stats[9],
          preparedBatchPaths: stats[10],
          atlasPages: stats[11],
          atlasPixels: stats[12],
          cachedOperationWorkCount: stats[13],
          stampOps: stats[14],
          stampInstances: stats[15],
          temporaryRecordArraysAvoided: gpuOpCount + stats[13] * 3,
          playback: p.gpuPreparation ? (stats[5] ? 'mixed' : 'compute-indirect') : 'source-only',
          gpuVisibilityOps: gpuOpCount,
          cpuVisibilityPaths: stats[5],
          eliminatedCopyVertexBytes: config.gpuPreparation ? stats[6] * 16 : 0,
          recordBytes: p.recordData.byteLength,
          preparedVertexBytes: p.gpuPreparation ? p.preparedVertexCount * 16 : 0,
          gpuOperationBytes: p.prepareData?.byteLength || 0,
          gpuIndirectBytes: gpuOpCount * 32,
          gpuVisibilityBytes: p.gpuPreparation ? opCount * 4 : 0,
          geometryTaskBytes: p.taskData?.byteLength || 0,
        });
        s.preparationBytes = s.gpuOperationBytes + s.gpuIndirectBytes + s.gpuVisibilityBytes + s.geometryTaskBytes;
        p.stats = s;
        for (const bytes of [
          packet.vertices.byteLength,
          packet.paints.byteLength,
          packet.segments.byteLength,
          packet.transforms.byteLength,
          packet.stamps.byteLength,
          p.recordData.byteLength,
          p.prepareData?.byteLength || 0,
          p.taskData?.byteLength || 0,
          p.preparedVertexCount * 16,
          gpuOpCount * 32,
          opCount * 4,
        ]) {
          if (bytes > config.limits.maxStorageBufferBindingSize || bytes > config.limits.maxBufferSize)
            throw Error('Tile storage buffer exceeds preprocessing binding limit');
        }
        return p;
      },
    };
  }
  function addBankStats(packet, handle) {
    const out = view(Uint32Array, api.td_summary(handle), 16),
      s = packet.stats;
    Object.assign(s, {
      pathCount: out[0],
      groupCount: out[1],
      maxDepth: out[2],
      compactPaths: out[3],
      analyticStrokePaths: out[4],
      analyticSegments: out[5],
      trianglePathTriangles: out[6],
      convexPaths: out[7],
      convexTriangles: out[8],
      stampCommands: out[9],
      stampInstances: out[10],
      compactSegments: packet.segments.length / 16,
      generatedVertexCount: packet.generatedVertexCount,
      renderTriangles: out[6] + out[4] * 2 + packet.generatedVertexCount / 3,
      storageVertexCount: packet.vertices.length / 2,
      vertexCount: packet.vertices.length / 2,
      paintCount: packet.paints.length / 64,
      segmentBytes: packet.segments.byteLength,
      transformBytes: packet.transforms.byteLength,
      stampBytes: packet.stamps.byteLength,
      geometryUploadBytes:
        packet.vertices.byteLength +
        packet.segments.byteLength +
        packet.transforms.byteLength +
        packet.stamps.byteLength,
    });
  }
  function writeTransform(v) {
    refresh();
    const at = api.td_scratch(2) / 4;
    f32.fill(0, at, at + 8);
    f32.set(v, at);
  }
  tileDataRuntime = {
    createBank,
    bankForHandle: handle => createBank(handle),
    addBankStats,
    preprocess,
    memory,
    counters,
    check,
    view,
    refresh,
    writeNumbers,
    writeMaterial,
    writeTransform,
    floatView() {
      refresh();
      return f32;
    },
    prepareTile(canvas) {
      check(api.mc_prepare_tile(canvas._cppHandle));
    },
    resetBanks() {
      api.mc_reset_all();
      api.td_reset();
    },
    api,
    shared: runtime.shared,
    environment: runtime.environment,
  };
  return tileDataRuntime;
}

function tileDataPlanStats(packet) {
  return {
    paths: 0,
    directConvexPaths: 0,
    analyticStrokePaths: 0,
    analyticSegments: 0,
    groups: 0,
    storageVertexCount: packet.vertices.length / 2,
    trianglePathTriangles: 0,
    renderTriangles: 0,
    triangles: 0,
    triangleAccounting:
      'triangle path geometry + two triangles per capsule quad; excludes group and stencil-cover quads',
    vertexBytes: packet.vertices.byteLength,
    paintBytes: packet.paints.byteLength,
    segmentBytes: packet.segments?.byteLength || 0,
    transformBytes: packet.transforms?.byteLength || 0,
    stampCommands: packet.stats?.stampCommands || 0,
    stampOps: 0,
    stampInstances: packet.stats?.stampInstances || 0,
    stampBytes: packet.stamps?.byteLength || 0,
    preparedVertexBytes: 0,
    preparationBytes: 0,
    gpuOperationBytes: 0,
    gpuIndirectBytes: 0,
    gpuVisibilityBytes: 0,
    geometryTaskBytes: 0,
    recordBytes: 0,
    uploadedBytes: 0,
    uploadWrites: 0,
    maxSingleUploadBytes: 0,
    maxSingleUploadCPUms: 0,
    parametricPaths: 0,
    fallbackPaths: 0,
    fallbackPathVertexCount: 0,
    fallbackDraws: 0,
    parametricDraws: 0,
    computePasses: 0,
    computedVertices: 0,
    copiedVertices: 0,
    copyDispatches: 0,
    gpuVisibilityOps: 0,
    cpuVisibilityPaths: 0,
    visibilityCandidates: 0,
    indirectDraws: 0,
    preparedBatches: 0,
    preparedBatchPaths: 0,
    temporaryRecordArraysAvoided: 0,
    cachedOperationWorkCount: 0,
    draws: 0,
    passes: 0,
    steps: 0,
    cpuMs: 0,
    renderCPUms: 0,
    allocationCPUms: 0,
    uploadCPUms: 0,
    atlasPages: 0,
    atlasPixels: 0,
    gpuFeedbackSamples: 0,
  };
}

function flattenTileDataPlan(p) {
  if (p.version === 2) return p;
  const opCount = p.ops.length,
    nodeCount = p.nodes.length,
    gpuOpCount = p.gpuOps.length,
    stageCount = p.stages.length;
  const opData = new Uint32Array(opCount * 12),
    opWork = new Float32Array(opCount * 2),
    nodeData = new Uint32Array(nodeCount * 8),
    nodeGeo = new Float32Array(nodeCount * 8),
    nodeOps = new Uint32Array(opCount),
    stageData = new Uint32Array(stageCount * 6),
    stageNodes = new Uint32Array(p.stages.reduce((n, s) => n + s.nodes.length, 0));
  let at = 0;
  for (const n of p.nodes) {
    const k = n.id * 8;
    nodeData.set(
      [
        n.page ? p.stages.indexOf(n.page) : 0xffffffff,
        n.x || 0,
        n.y || 0,
        Math.max(0, Math.ceil(n.crop[2] - n.crop[0])),
        Math.max(0, Math.ceil(n.crop[3] - n.crop[1])),
        at,
        n.ops.length,
        n.depth,
      ],
      k,
    );
    nodeGeo.set(n.bounds, k);
    nodeGeo.set(n.crop, k + 4);
    for (const op of n.ops) nodeOps[at++] = op.index;
  }
  at = 0;
  for (let i = 0; i < stageCount; i++) {
    const s = p.stages[i];
    stageData.set([s.width, s.height, at, s.nodes.length, s.kind === 'tile' ? 1 : 0, 0], i * 6);
    for (const n of s.nodes) stageNodes[at++] = n.id;
  }
  for (const o of p.ops) {
    const k = o.index * 12,
      c = o.command,
      kind =
        o.kind === 'path' ? 1 : o.kind === 'capsuleUnion' ? 2 : o.kind === 'group' ? 3 : o.kind === 'stamp' ? 5 : 0;
    if (!kind) throw Error('Unsupported tile plan operation kind: ' + o.kind);
    if (kind === 5 && (o.gpuIndex !== undefined || o.batchOwner || o.batch?.members > 1 || o.parametric))
      throw Error('Stamp operation cannot enter GPU preparation or path batching');
    opData.set(
      [
        kind,
        (o.skip ? 1 : 0) | (c.convex === true ? 2 : 0) | (o.parametric ? 4 : 0) | (o.batchOwner ? 8 : 0),
        c.first || 0,
        c.count || 0,
        o.node.id,
        o.child?.id ?? 0xffffffff,
        o.gpuIndex ?? 0xffffffff,
        o.batch?.members || 1,
        o.batch?.vertexCount || (o.kind === 'path' ? c.count : 6),
        o.nodeOffset ?? o.node.ops.indexOf(o),
        c.paint || 0,
        o.preparedFirst || 0,
      ],
      k,
    );
    opWork[o.index * 2] = o.work || 0;
    opWork[o.index * 2 + 1] = o.batch?.work ?? o.work ?? 0;
  }
  const { root, nodes, ops, gpuOps, stages, tileStage, ...header } = p;
  return {
    ...header,
    version: 2,
    storage: 'js-index-tables',
    opCount,
    nodeCount,
    gpuOpCount,
    stageCount,
    opData,
    opWork,
    nodeData,
    nodeGeo,
    nodeOps,
    stageData,
    stageNodes,
  };
}

function createTileDeliveryPool(primary = true) {
  const free = [],
    outstanding = new Map(),
    waiters = [];
  let serial = 0;
  const limit = (primary ? 16 : 8) * 1024 * 1024;
  const stats = {
    allocations: 0,
    reuse: 0,
    returned: 0,
    invalidReturns: 0,
    allocatedBytes: 0,
    inFlightBytes: 0,
    peakInFlightBytes: 0,
    copies: 0,
    copyBytes: 0,
    copyMs: 0,
    maxCopyMs: 0,
    limitBytes: limit,
    peakAllocatedBytes: 0,
    waits: 0,
  };
  const capacity = bytes => Math.max(4096, Math.ceil(bytes / 65536) * 65536);
  const find = bytes => {
    let best = -1;
    for (let i = 0; i < free.length; i++)
      if (free[i].byteLength >= bytes && (best < 0 || free[i].byteLength < free[best].byteLength)) best = i;
    return best;
  };
  const wake = () => {
    for (const done of waiters.splice(0)) done();
  };
  const canTake = bytes => find(bytes) >= 0 || (outstanding.size < 2 && stats.inFlightBytes + capacity(bytes) <= limit);
  return {
    stats,
    wake,
    canTake,
    wait(bytes) {
      if (bytes > limit) throw Error('Tile delivery exceeds its total memory budget');
      if (canTake(bytes)) return Promise.resolve();
      stats.waits++;
      return new Promise(resolve => waiters.push(resolve));
    },
    take(bytes) {
      if (!canTake(bytes)) throw Error('Tile delivery requires backpressure');
      let best = find(bytes),
        buffer;
      if (best >= 0) {
        buffer = free.splice(best, 1)[0];
        stats.reuse++;
      } else {
        const n = capacity(bytes);
        while (free.length && stats.allocatedBytes + n > limit) stats.allocatedBytes -= free.pop().byteLength;
        buffer = new ArrayBuffer(n);
        stats.allocations++;
        stats.allocatedBytes += n;
        stats.peakAllocatedBytes = Math.max(stats.peakAllocatedBytes, stats.allocatedBytes);
      }
      const token = ++serial;
      outstanding.set(token, buffer.byteLength);
      stats.inFlightBytes += buffer.byteLength;
      stats.peakInFlightBytes = Math.max(stats.peakInFlightBytes, stats.inFlightBytes);
      return { buffer, token };
    },
    recycle(token, buffer) {
      const bytes = outstanding.get(token);
      if (!bytes || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== bytes) {
        stats.invalidReturns++;
        return false;
      }
      outstanding.delete(token);
      stats.inFlightBytes -= bytes;
      stats.returned++;
      free.push(buffer);
      wake();
      return true;
    },
  };
}

function tileDataDeliveryBytes(packet) {
  return nativeDataSize(
    nativeDataFields(
      packet,
      ['vertices', 'paints', 'segments', 'transforms', 'stamps', 'objects'],
      [
        'recordData',
        'prepareData',
        'taskData',
        'opData',
        'opWork',
        'nodeData',
        'nodeGeo',
        'nodeOps',
        'stageData',
        'stageNodes',
      ],
    ),
  ).usedBytes;
}

function serializeTileData(packet, pool, resultSlot = 0) {
  const p = (packet.preprocessed = flattenTileDataPlan(packet.preprocessed)),
    rt = getTileDataRuntime();
  const fields = nativeDataFields(
    packet,
    ['vertices', 'paints', 'segments', 'transforms', 'stamps', 'objects'],
    [
      'recordData',
      'prepareData',
      'taskData',
      'opData',
      'opWork',
      'nodeData',
      'nodeGeo',
      'nodeOps',
      'stageData',
      'stageNodes',
    ],
  );
  const transfer = serializeNativeData(packet, fields, {
    pool,
    token: p.identity.id,
    signalOffset: rt?.api.td_lease_control(),
    environment: rt?.environment,
  });
  packet.delivery.resultSlot = resultSlot;
  delete packet.commandBank;
  delete packet.commands;
  p.transferBytes = packet.delivery.shared ? 0 : packet.delivery.payloadBytes;
  return transfer;
}

function ownTileDelivery(mesh, worker) {
  if (!mesh?.delivery) return;
  ownNativeData(
    mesh,
    worker,
    {
      type: 'recycle',
      era: mesh.preprocessed.identity.era,
      id: mesh.preprocessed.identity.id,
      resultSlot: mesh.delivery.resultSlot ?? 0,
    },
    worker.meshInfo?.transport,
  );
  mesh.release = () => {
    mesh.releaseData?.();
    delete mesh.releaseData;
    delete mesh.release;
  };
}
function releaseTileDelivery(mesh) {
  mesh?.release?.();
}
