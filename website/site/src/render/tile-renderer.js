function gpuTileRasterPlan(width, height, pad, requestedScale) {
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(pad) ||
    pad < 0 ||
    !Number.isSafeInteger(width + pad * 2) ||
    !Number.isSafeInteger(height + pad * 2)
  )
    throw Error('Invalid logical tile raster dimensions');
  const scale = Number.isFinite(requestedScale) && requestedScale >= 0.5 && requestedScale <= 1 ? requestedScale : 1;
  const outputWidth = Math.max(1, Math.round(width * scale)),
    outputHeight = Math.max(1, Math.round(height * scale));
  const sx = outputWidth / width,
    sy = outputHeight / height;
  const padX = Math.ceil(pad * sx),
    padY = Math.ceil(pad * sy);
  return {
    outputWidth,
    outputHeight,
    stageWidth: outputWidth + padX * 2,
    stageHeight: outputHeight + padY * 2,
    padX,
    padY,
    sx,
    sy,
    scale,
    viewport: {
      x: padX - pad * sx,
      y: padY - pad * sy,
      width: (width + pad * 2) * sx,
      height: (height + pad * 2) * sy,
    },
  };
}
function gpuTileClockResolution(now = () => performance.now()) {
  const first = now();
  let previous = first,
    minimum = Infinity,
    positive = 0,
    reads = 0;
  for (; reads < 8192; reads++) {
    const value = now(),
      delta = value - previous;
    previous = value;
    if (delta > 0 && Number.isFinite(delta)) {
      minimum = Math.min(minimum, delta);
      positive++;
    }
    if (minimum < 0.5 || (positive >= 4 && value - first >= 4)) {
      reads++;
      break;
    }
  }
  const observedMinimumStepMs = Number.isFinite(minimum) ? minimum : null;
  const confirmed = minimum < 0.5 || positive >= 4;
  return {
    minimumStepMs: confirmed ? observedMinimumStepMs : null,
    observedMinimumStepMs,
    reads,
    positiveSteps: positive,
  };
}
async function createGPUTileRenderer(device, options = {}) {
  const format = options.format || 'rgba8unorm';
  if (format !== 'rgba8unorm') throw Error('Tile output must be premultiplied rgba8unorm');
  const BU = GPUBufferUsage,
    TU = GPUTextureUsage,
    SS = GPUShaderStage;
  const gpuPreparation = options.gpuPreparation !== false;
  const rasterScaling = options.rasterScaling === true;
  const antialias = options.antialias !== false,
    sampleCount = antialias ? 4 : 1;
  const coverageRasterScaling = rasterScaling && antialias,
    sampleLabel = antialias ? '4x' : '1x';
  const reuseResources = gpuPreparation && options.reuseResources !== false;
  const maxDimension = device.limits.maxTextureDimension2D;
  const requestedComputeGroups = options.computeMaxGroups ?? 512,
    computeMaxVertices = options.computeMaxVertices ?? 32768;
  if (
    !Number.isSafeInteger(requestedComputeGroups) ||
    requestedComputeGroups < 1 ||
    !Number.isSafeInteger(computeMaxVertices) ||
    computeMaxVertices < 768
  )
    throw Error('Invalid tile compute slice limits');
  const deviceComputeGroups = device.limits.maxComputeWorkgroupsPerDimension ?? 65535;
  const computeMaxGroups = Math.min(requestedComputeGroups, deviceComputeGroups),
    computePrepareMaxOperations = Math.min(4096, deviceComputeGroups * 64);
  const preprocessConfig = tilePreprocessOptions({
    limits: device.limits,
    gpuPreparation,
    convexInstancing: options.convexInstancing !== false,
  });
  const computeRangeScratch = gpuPreparation ? new Uint32Array(4) : null;
  const emptyFloats = new Float32Array(0),
    selectionScratch = new Uint32Array(32768 * 8),
    selectionWork = new Float32Array(32768);
  const blend = {
    color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };
  const metadata = {
    backend: gpuPreparation ? 'mesh-packet-v2-compute-indirect-mixed' : 'mesh-packet-v1-legacy',
    antialias,
    sampleCount,
    aa: antialias ? '4x-msaa-paths-and-analytic-capsule-union' : 'off-single-sample-hard-capsule-union',
    byteCount: 0,
    peakBytes: 0,
    bufferBytes: 0,
    colorBytes: 0,
    sampleBytes: 0,
    stencilBytes: 0,
    outputBytes: 0,
    jobsStarted: 0,
    jobsCompleted: 0,
    jobsCancelled: 0,
    steps: 0,
    uploadedBytes: 0,
    maxUploadChunkBytes: 262144,
    warnings: [],
    lastJob: null,
    gpuMsPerWork: null,
    gpuMsPerComputeWork: null,
    gpuMsPerComputeWorkByMode: { copy: null, expand: null },
    computeBudgetSamples: 0,
    ignoredComputeBudgetSamples: 0,
    minComputeBudgetVertices: 4096,
    computeMaxGroups,
    computeMaxVertices,
    computePrepareMaxOperations,
    openingComputeMaxGroups: deviceComputeGroups,
    openingPrepareMaxOperations: deviceComputeGroups * 64,
    openingUnbounded: false,
    budgetMode: 'play',
    lastBudget: null,
    openingCPUBudgetSamplesIgnored: 0,
    openingGPUBudgetSamplesIgnored: 0,
    pipelineCreationPolicy:
      'parallel independent pipelines inside one tile validation scope; all started promises settle before scope pop',
    deviceLimits: {
      maxTextureDimension2D: maxDimension,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxBufferSize: device.limits.maxBufferSize ?? device.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupsPerDimension: deviceComputeGroups,
      maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage ?? null,
    },
    shaderErrors: [],
    cpuMsPerDraw: 0.6 / 512,
    adaptiveDrawLimit: 512,
    currentDrawLimit: 512,
    renderCPUTargetMs: 0.6,
    cpuBudgetSamples: 0,
    cpuBudgetPendingDraws: 0,
    cpuBudgetPendingSlices: 0,
    cpuBudgetPendingElapsedMs: 0,
    cpuBudgetFeedbackPolicy:
      'aggregate eligible slices including zeros; coarse clocks require four observed clock steps before learning',
    lastRenderCPUms: 0,
    maxRenderCPUms: 0,
    lastAllocationCPUms: 0,
    lastUploadCPUms: 0,
    lastStartCPUms: 0,
    maxStartCPUms: 0,
    lastCancelCPUms: 0,
    maxCancelCPUms: 0,
    lastCPUBreakdown: null,
    maxAllocationOperationCPUms: 0,
    maxBindingOperationCPUms: 0,
    allocationOperations: 0,
    bindingChanges: 0,
    pipelineChanges: 0,
    directConvexPaths: 0,
    analyticStrokePaths: 0,
    analyticSegments: 0,
    stampDraws: 0,
    stampInstances: 0,
    stampDrawInstances: 0,
    stampBytes: 0,
    stampFieldBytes: 0,
    stampFieldUploads: 0,
    stampFieldUploadBytes: 0,
    stampField: null,
    convexInstancing: options.convexInstancing !== false,
    instanceBatchMax: 32,
    instancePaddingLimit: 1.5,
    instancedDraws: 0,
    instancedPaths: 0,
    instancedVertexInvocations: 0,
    instancedUsefulVertices: 0,
    gpuPreparation,
    computePasses: 0,
    computedVertices: 0,
    indirectDraws: 0,
    visibilityCandidates: 0,
    commandPreprocessing: 'worker plan adoption; shared incremental main fallback',
    workerPreprocessedJobs: 0,
    mainPreprocessedJobs: 0,
    workerPreprocessMs: 0,
    mainPreprocessCPUms: 0,
    lastAdoptCPUms: 0,
    mainPreprocessStagesSkipped: 0,
    cpuArrayReuse: {
      computeRangeScratchBytes: gpuPreparation ? 16 : 0,
      perJobComputeRangeAllocations: 0,
      uploadPolicy: 'existing E ArrayBuffer/byteOffset/byteLength; no temporary upload subarray',
      tablePolicy: 'one owned record/prepare/task buffer per job, transferred once; no detached-array pool',
      selectionRecordAllocations: 0,
      selectionRecordCapacity: 32768,
      selectionWorkspaceBytes: selectionScratch.byteLength + selectionWork.byteLength,
      preallocated: true,
    },
    lastWorkerDiagnostics: null,
    geometryPlayback: gpuPreparation
      ? 'source vertices for fallback paths; compute expands parametric paths only'
      : 'source vertices',
    visibilityCoverage: gpuPreparation
      ? 'GPU: parametric paths, capsule unions and groups; CPU crop/scissor: fallback paths'
      : 'CPU crop/scissor',
    fallbackDraws: 0,
    fallbackPaths: 0,
    parametricDraws: 0,
    copyDispatches: 0,
    fallbackBindingDummyBytes: gpuPreparation ? 52 : 0,
    preparedBatches: 0,
    preparedBatchPaths: 0,
    preparedBatchMax: 32,
    preparedBatchWorkMax: 4000,
    reusedBuffers: 0,
    reusedTextures: 0,
    reusedBindings: 0,
    createdBindings: 0,
    reusedTextureViews: 0,
    createdTextureViews: 0,
    pooledBytes: 0,
    poolLimitBytes: reuseResources ? Math.max(0, options.poolLimitBytes ?? 2 * 1024 * 1024) : 0,
    bufferPoolLimitBytes: reuseResources ? Math.max(0, options.bufferPoolLimitBytes ?? 16 * 1024 * 1024) : 0,
    pooledBufferBytes: 0,
    pooledTextureBytes: 0,
    createdBuffers: 0,
    destroyedBuffers: 0,
    capsuleCoverage: antialias
      ? 'min segment distance; 1-device-pixel linear coverage ramp, thin-line maximum min(1,2*radius); one premul paint on a 4x target'
      : 'hard edge: min segment distance <= logical radius; full premul paint once; no coverage ramp or thin-line cap',
    rasterScaling,
    coverageRasterScaling,
    rasterScaleRange: [0.5, 1],
    rasterScalingScope:
      'root target, optional root AA coverage, axis-scaled Gaussian, crop and output only; original packet and group atlases',
    scaledCapsuleCoverage: coverageRasterScaling
      ? 'one per-job f32 uniform max(1/sx,1/sy) from rounded root viewport; thin-line maximum min(1,2*radius/pixelWidth); no fragment derivatives'
      : null,
    rasterCoverageUniformBytesPerJob: coverageRasterScaling ? 16 : 0,
    limitations: [
      antialias
        ? 'Round-line capsule-union analytic coverage is implemented on a 4x target and still requires GPU/Canvas comparison; general nonzero path analytic AA is not implemented. CPU overlap counterexample only rejects independent alpha fringes.'
        : 'Antialias is disabled: one sample and hard capsule union; existing artwork Gaussian blur and group linear sampling remain.',
      'A path winding/fill pair is atomic; a single unusually large path may exceed the estimated slice GPU budget.',
      'GPU slice budgets are estimates until timestamp feedback is supplied; upload bytes are hard limited.',
      'Upload timing is CPU queue.writeBuffer call time; render-pass GPU timestamps do not measure pure upload slices.',
      'CPU allocation and binding calls are indivisible; their observed maximum is recorded and a slow call can exceed the CPU deadline.',
      'Compute visibility is conservative and suppresses indirect draws; its exact survivor count is not read back.',
      'Packet v2 uses uniform bounded curve subdivisions and vertex affine transforms; visual differences require GPU comparison.',
      'Root raster scaling keeps all logical geometry, subdivisions, buffer uploads and group atlas dimensions; group image minification remains linear sampling and needs visual acceptance.',
      'byteCount is explicit logical resource accounting, not driver memory or physical retirement.',
    ],
  };
  const resources = new Map(),
    retired = [],
    pool = new Map(),
    bindingCache = new Map();
  let resourceSequence = 0;
  let disposed = false,
    active = null,
    needsSubmission = false,
    sequence = 0;
  let msPerDraw = 0.6 / 512,
    liveDrawLimit = 512;
  const newGPUCost = () => ({
    fixed: 0,
    rate: 3 / 100000,
    samples: [],
    fitted: false,
    everFitted: false,
    typicalWork: 0,
    count: 0,
  });
  const gpuCost = { render: newGPUCost(), post: newGPUCost() };
  const gpuPassKind = label => (/Gaussian/.test(label || '') ? 'post' : 'render');
  function gpuWorkBudget(kind, gpuMs) {
    const cost = gpuCost[kind],
      samples = cost.samples;
    let work = Math.max(gpuMs - cost.fixed, cost.fixed) / cost.rate;
    if (samples.length) {
      let largest = 0;
      for (const sample of samples) if (sample[0] > largest) largest = sample[0];
      if (!cost.everFitted) work = Math.max(work, cost.typicalWork * 4);
      else if (!cost.fitted && cost.count % 8 === 0) work = Math.max(work, cost.typicalWork * 2);
      work = Math.min(work, Math.max(4096, largest * 4));
    }
    return Math.max(2048, work);
  }
  function fitGPUCost(kind, work, gpuMs) {
    const cost = gpuCost[kind],
      samples = cost.samples;
    samples.push([work, gpuMs]);
    if (samples.length > 16) samples.shift();
    const byWork = samples.slice().sort((a, b) => a[0] - b[0]),
      count = byWork.length,
      group = Math.max(1, count >> 3);
    const middle = rows => rows.map(row => row[1]).sort((a, b) => a - b)[(rows.length - 1) >> 1];
    const small = byWork.slice(0, group),
      large = byWork.slice(count - group);
    const smallWork = small[(group - 1) >> 1][0],
      largeWork = large[(group - 1) >> 1][0],
      smallMs = middle(small),
      largeMs = middle(large);
    cost.typicalWork = byWork[count >> 1][0];
    cost.count++;
    cost.fitted = count >= 8 && largeWork >= smallWork * 1.5;
    if (cost.fitted) {
      cost.everFitted = true;
      cost.rate = Math.max(1e-7, (largeMs - smallMs) / (largeWork - smallWork));
    }
    cost.fixed = Math.max(
      0,
      (cost.fitted ? smallMs : middle(byWork)) - cost.rate * (cost.fitted ? smallWork : cost.typicalWork),
    );
  }
  let cpuFeedbackDraws = 0,
    cpuFeedbackElapsed = 0,
    cpuFeedbackSlices = 0;
  const computeCosts = { prepare: 3 / 65536, copy: 3 / 32768, expand: 3 / 32768 };
  const clock = () => performance.now();
  const clockResolution = gpuTileClockResolution(clock);
  const coarseClock =
    options.coarseClockBudget !== false &&
    (clockResolution.minimumStepMs === null || clockResolution.minimumStepMs >= 0.5);
  const cpuFeedbackMinimumMs = coarseClock ? 4 * Math.max(0.5, clockResolution.minimumStepMs ?? 1) : 0;
  metadata.cpuClock = {
    ...clockResolution,
    countingEnabled: options.coarseClockBudget !== false,
    mode: coarseClock ? 'estimated-draw-count' : 'deadline',
    feedbackMinimumMs: cpuFeedbackMinimumMs,
    unresolved: clockResolution.minimumStepMs === null,
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const align4 = n => Math.max(4, Math.ceil(n / 4) * 4);
  function retain(resource, bytes, kind, poolKey = null) {
    resources.set(resource, { bytes, kind, poolKey, id: ++resourceSequence, owner: null, pooled: false });
    metadata.byteCount += bytes;
    metadata[kind] += bytes;
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
    if (Number.isFinite(options.maxBytes) && metadata.byteCount > options.maxBytes) {
      release(resource);
      throw Error('Tile explicit resource limit exceeded');
    }
    return resource;
  }
  function release(resource) {
    const item = resources.get(resource);
    if (!item) return;
    if (item.pooled) {
      const list = pool.get(item.poolKey);
      const at = list?.indexOf(resource) ?? -1;
      if (at >= 0) list.splice(at, 1);
      metadata.pooledBytes -= item.bytes;
      metadata[item.kind === 'bufferBytes' ? 'pooledBufferBytes' : 'pooledTextureBytes'] -= item.bytes;
    }
    for (const [key, value] of bindingCache) if (value.resources.includes(resource)) bindingCache.delete(key);
    resources.delete(resource);
    resource.destroy();
    metadata.byteCount -= item.bytes;
    metadata[item.kind] -= item.bytes;
    if (item.kind === 'bufferBytes') metadata.destroyedBuffers++;
  }
  function borrow(key, bytes, isTexture = false) {
    const list = pool.get(key);
    if (!list) return null;
    let at = -1;
    for (let i = 0; i < list.length; i++) {
      const n = resources.get(list[i])?.bytes;
      if (n >= bytes && (at < 0 || n < resources.get(list[at]).bytes)) at = i;
    }
    if (at < 0) return null;
    const resource = list.splice(at, 1)[0],
      item = resources.get(resource);
    item.pooled = false;
    metadata.pooledBytes -= item.bytes;
    metadata[isTexture ? 'pooledTextureBytes' : 'pooledBufferBytes'] -= item.bytes;
    metadata[isTexture ? 'reusedTextures' : 'reusedBuffers']++;
    return resource;
  }
  function retire(resource) {
    const item = resources.get(resource);
    if (!item) return;
    const bufferItem = item.kind === 'bufferBytes',
      bytesKey = bufferItem ? 'pooledBufferBytes' : 'pooledTextureBytes',
      limit = bufferItem ? metadata.bufferPoolLimitBytes : metadata.poolLimitBytes;
    if (!item.poolKey || item.bytes > limit) {
      release(resource);
      return;
    }
    if (bufferItem) {
      for (const old of [...(pool.get(item.poolKey) || [])]) {
        if (resources.get(old).bytes >= item.bytes) {
          release(resource);
          return;
        }
        release(old);
      }
      for (const [old, entry] of resources) {
        if (metadata[bytesKey] + item.bytes <= limit) break;
        if (entry.pooled && entry.kind === 'bufferBytes') release(old);
      }
    }
    if (metadata[bytesKey] + item.bytes > limit) {
      release(resource);
      return;
    }
    item.owner = null;
    item.pooled = true;
    metadata.pooledBytes += item.bytes;
    metadata[bytesKey] += item.bytes;
    const list = pool.get(item.poolKey) || [];
    list.push(resource);
    pool.set(item.poolKey, list);
  }
  function later(resource) {
    if (resource && resources.has(resource) && !retired.includes(resource)) retired.push(resource);
  }
  function buffer(label, bytes, usage) {
    const size = align4(bytes),
      key = reuseResources ? 'buffer:' + label + ':' + usage : null;
    const existing = key && borrow(key, size);
    if (existing) return existing;
    const capacity = key ? Math.ceil(size / 256) * 256 : size;
    metadata.createdBuffers++;
    return retain(device.createBuffer({ label, size: capacity, usage }), capacity, 'bufferBytes', key);
  }
  function texture(label, w, h, kind = 'colorBytes', sampleCount = 1, stencil = false) {
    if (!(w > 0 && h > 0 && w <= maxDimension && h <= maxDimension))
      throw Error('Tile texture exceeds device dimensions: ' + w + 'x' + h);
    const bytes = w * h * (stencil ? 1 : 4) * sampleCount;
    const key =
      reuseResources && kind !== 'outputBytes' && label !== 'tile no group source'
        ? 'texture:' + label + ':' + w + ':' + h + ':' + sampleCount + ':' + (stencil ? 'stencil8' : format)
        : null;
    return (
      (key && borrow(key, bytes, true)) ||
      retain(
        device.createTexture({
          label,
          size: [w, h],
          format: stencil ? 'stencil8' : format,
          sampleCount,
          usage:
            stencil || sampleCount > 1
              ? TU.RENDER_ATTACHMENT
              : TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | TU.COPY_SRC | TU.COPY_DST,
        }),
        bytes,
        kind,
        key,
      )
    );
  }
  function textureView(resource) {
    const item = resources.get(resource);
    if (item.view) {
      metadata.reusedTextureViews++;
      return item.view;
    }
    metadata.createdTextureViews++;
    return (item.view = resource.createView());
  }
  async function checkedModule(label, code) {
    const module = device.createShaderModule({ label, code }),
      info = await module.getCompilationInfo();
    const errors = info.messages.filter(m => m.type === 'error');
    metadata.warnings.push(...info.messages.filter(m => m.type === 'warning').map(m => label + ': ' + m.message));
    if (errors.length) {
      metadata.shaderErrors.push(
        ...errors.map(m => ({ label, line: m.lineNum, column: m.linePos, message: m.message })),
      );
      throw Error(label + ': ' + errors.map(m => m.lineNum + ':' + m.linePos + ' ' + m.message).join('\n'));
    }
    return module;
  }
  const pipelineRequests = [];
  function requestPipeline(method, descriptor) {
    const request = device[method](descriptor);
    request.catch(() => {});
    pipelineRequests.push(request);
    return request;
  }
  async function settlePipelines(requests) {
    const settled = await Promise.allSettled(requests),
      failed = settled.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    return settled.map(item => item.value);
  }
  const stampFieldBegin = clock();
  if (typeof options.stampField !== 'function') throw Error('Tile stamp field provider is required');
  let stampField = await options.stampField();
  if (
    stampField?.width !== 256 ||
    stampField.height !== 256 ||
    stampField.layers !== 2 ||
    stampField.format !== 'rgba16float' ||
    !(stampField.pixels instanceof Uint16Array) ||
    stampField.pixels.length !== 256 * 256 * 2 * 4
  )
    throw Error('Invalid tile stamp field');
  metadata.stampField = {
    width: 256,
    height: 256,
    layers: 2,
    format: 'rgba16float',
    bytes: stampField.pixels.byteLength,
    buildMs: Number.isFinite(stampField.buildMs) ? stampField.buildMs : null,
    requestWallMs: clock() - stampFieldBegin,
    bulkCrossThreadCopyBytes: stampField.bulkCrossThreadCopyBytes || 0,
    persistent: true,
  };
  device.pushErrorScope('validation');
  let pipelines,
    layout,
    stampLayout,
    stampSampler,
    stampShapes,
    stampShapesView,
    sampler,
    dummy,
    dummyView,
    dummyPoints,
    dummyPrepared,
    dummyTransforms,
    dummyVisible,
    initError;
  try {
    layout = device.createBindGroupLayout({
      label: 'tile packet buffers and group source',
      entries: [
        { binding: 0, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ...(gpuPreparation
          ? [
              { binding: 5, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
              { binding: 6, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
              { binding: 7, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
            ]
          : []),
        ...(coverageRasterScaling
          ? [{ binding: 8, visibility: SS.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 16 } }]
          : []),
      ],
    });
    const module = await checkedModule(
      'tile nonzero path and paint',
      `
struct TileRecord { rect: vec4f, viewport: vec4f, uv: vec4f, settings: vec4f }
@group(0) @binding(0) var<storage, read> tilePaint: array<f32>;
@group(0) @binding(1) var<storage, read> tileRecords: array<TileRecord>;
@group(0) @binding(2) var tileLinear: sampler;
@group(0) @binding(3) var tileGroupImage: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> tilePoints: array<vec2f>;${
        coverageRasterScaling
          ? `
struct TileRasterCoverage { values: vec4f }
@group(0) @binding(8) var<uniform> tileRasterCoverage: TileRasterCoverage;`
          : ''
      }
${
  gpuPreparation
    ? `
struct TilePreparedVertex { p: vec2f, owner: u32, transform: u32 }
@group(0) @binding(5) var<storage, read> tilePrepared: array<TilePreparedVertex>;
@group(0) @binding(6) var<storage, read> tileTransforms: array<vec4f>;
@group(0) @binding(7) var<storage, read> tileVisible: array<u32>;
`
    : ''
}
struct TileVertex { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) uv: vec2f, @location(2) @interpolate(flat) record: u32 }
fn tilePosition(p: vec2f, r: TileRecord) -> vec4f { let q = p + r.viewport.zw; return vec4f(q.x / r.viewport.x * 2.0 - 1.0, 1.0 - q.y / r.viewport.y * 2.0, 0.0, 1.0); }
@vertex fn tilePathVertex(@location(0) p: vec2f, @builtin(instance_index) id: u32) -> TileVertex {
  var o: TileVertex; o.position = tilePosition(p, tileRecords[id]); o.local = p; o.uv = vec2f(0); o.record = id; return o;
}
@vertex fn tileInstancedVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) id: u32) -> TileVertex {
  let r = tileRecords[id]; let first = u32(r.settings.z); let count = u32(r.settings.w);
  let offset = select(0u,vertex,vertex < count); let p = tilePoints[first + offset];
  var o: TileVertex; o.position = tilePosition(p,r); o.local = p; o.uv = vec2f(0); o.record = id; return o;
}
@vertex fn tileQuadVertex(@builtin(vertex_index) i: u32, @builtin(instance_index) id: u32) -> TileVertex {
  let cs = array<vec2f, 6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let r = tileRecords[id]; let c = cs[i]; let p = r.rect.xy + c * r.rect.zw;
  var o: TileVertex; o.position = tilePosition(p, r); o.local = p; o.uv = r.uv.xy + c * r.uv.zw; o.record = id; return o;
}
${
  gpuPreparation
    ? `
fn tilePreparedPosition(p: vec2f, id: u32) -> vec4f {
  if (tileVisible[id] == 0u) { return vec4f(-2.0,-2.0,0.0,1.0); }
  return tilePosition(p,tileRecords[id]);
}
@vertex fn tileComputedVertex(@builtin(vertex_index) vertex: u32) -> TileVertex {
  let v = tilePrepared[vertex]; var p = v.p;
  if (v.transform != 0xffffffffu) {
    let a = tileTransforms[v.transform*2u]; let b = tileTransforms[v.transform*2u+1u];
    p = vec2f(a.x*p.x+a.z*p.y+b.x,a.y*p.x+a.w*p.y+b.y);
  }
  var o: TileVertex; o.position = tilePreparedPosition(p,v.owner); o.local = p; o.uv = vec2f(0); o.record = v.owner; return o;
}
@vertex fn tilePreparedQuadVertex(@builtin(vertex_index) vertex: u32) -> TileVertex {
  let cs = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let id = vertex/6u; let r = tileRecords[id]; let c = cs[vertex%6u]; let p = r.rect.xy+c*r.rect.zw;
  var o: TileVertex; o.position = tilePreparedPosition(p,id); o.local = p; o.uv = r.uv.xy+c*r.uv.zw; o.record = id; return o;
}
`
    : ''
}
fn tileStop(base: u32, index: u32) -> vec4f {
  let k = base + 16u + index * 5u; let a = tilePaint[k+4u]; return vec4f(tilePaint[k+1u],tilePaint[k+2u],tilePaint[k+3u],a);
}
fn tilePaintAt(id: u32, p: vec2f) -> vec4f {
  let b = id * 64u; let kind = u32(tilePaint[b]); let count = clamp(u32(tilePaint[b+2u]), 1u, 9u);
  var t = 0.0;
  if (kind != 0u) {
    let q = vec2f(tilePaint[b+4u]*p.x + tilePaint[b+6u]*p.y + tilePaint[b+8u], tilePaint[b+5u]*p.x + tilePaint[b+7u]*p.y + tilePaint[b+9u]);
    let a = vec2f(tilePaint[b+10u],tilePaint[b+11u]); let d = vec2f(tilePaint[b+12u],tilePaint[b+13u]) - a; let v = q - a;
    if (kind == 1u) { let dd = dot(d,d); if (dd < 1e-12) { return vec4f(0); } t = dot(v,d) / dd; }
    else {
      let r0 = tilePaint[b+14u]; let dr = tilePaint[b+15u] - r0;
      let aa = dot(d,d) - dr*dr; let bb = -2.0*(dot(v,d) + r0*dr); let cc = dot(v,v) - r0*r0;
      if (abs(aa) < 1e-8) { if (abs(bb) < 1e-8) { return vec4f(0); } t = -cc/bb; if (r0 + t*dr < 0.0) { return vec4f(0); } }
      else {
        let disc = bb*bb - 4.0*aa*cc; if (disc < 0.0) { return vec4f(0); }
        let root = sqrt(max(0.0,disc)); let ta = (-bb-root)/(2.0*aa); let tb = (-bb+root)/(2.0*aa);
        let va = r0+ta*dr >= 0.0; let vb = r0+tb*dr >= 0.0; if (!va && !vb) { return vec4f(0); }
        t = select(tb,ta,va); if (va && vb) { t = max(ta,tb); }
      }
    }
  }
  var c = tileStop(b,0u);
  for (var j = 1u; j < count; j++) {
    let hi = tilePaint[b+16u+j*5u]; let lo = tilePaint[b+16u+(j-1u)*5u];
    let right = tileStop(b,j);
    if (t < hi) { let f = clamp((t-lo)/max(hi-lo,1e-8),0.0,1.0); c = mix(c,right,f); break; }
    c = right;
  }
  let alpha = c.a * tilePaint[b+1u]; return vec4f(c.rgb * alpha,alpha);
}
@fragment fn tileStencilFragment() -> @location(0) vec4f { return vec4f(0); }
@fragment fn tilePaintFragment(i: TileVertex) -> @location(0) vec4f { return tilePaintAt(u32(tileRecords[i.record].settings.x),i.local); }
@fragment fn tileGroupFragment(i: TileVertex) -> @location(0) vec4f { return textureSample(tileGroupImage,tileLinear,i.uv) * tileRecords[i.record].settings.y; }
@fragment fn tileCapsuleFragment(i: TileVertex) -> @location(0) vec4f {
  let r = tileRecords[i.record]; let first = u32(r.settings.z); let count = u32(r.settings.w);
  var distanceToLine = 1e20;
  for (var segment = 0u; segment < 32u; segment++) { if (segment < count) {
    let a = tilePoints[first + segment*2u]; let b = tilePoints[first + segment*2u+1u]; let d = b-a;
    let t = clamp(dot(i.local-a,d)/max(dot(d,d),1e-12),0.0,1.0);
    distanceToLine = min(distanceToLine,length(i.local-(a+d*t)));
  } }
  let radius = r.settings.y;
${
  antialias
    ? `  let coverage = clamp(radius + 0.5 - distanceToLine,0.0,min(1.0,2.0*radius));
  if (coverage <= 0.0) { discard; }
  return tilePaintAt(u32(r.settings.x),i.local)*coverage;`
    : `  if (distanceToLine > radius) { discard; }
  return tilePaintAt(u32(r.settings.x),i.local);`
}
}
${
  coverageRasterScaling
    ? `
@fragment fn tileScaledCapsuleFragment(i: TileVertex) -> @location(0) vec4f {
  let pixelWidth = tileRasterCoverage.values.x;
  let r = tileRecords[i.record]; let first = u32(r.settings.z); let count = u32(r.settings.w);
  var distanceToLine = 1e20;
  for (var segment = 0u; segment < 32u; segment++) { if (segment < count) {
    let a = tilePoints[first + segment*2u]; let b = tilePoints[first + segment*2u+1u]; let d = b-a;
    let t = clamp(dot(i.local-a,d)/max(dot(d,d),1e-12),0.0,1.0);
    distanceToLine = min(distanceToLine,length(i.local-(a+d*t)));
  } }
  let radius = r.settings.y;
  let coverage = clamp((radius-distanceToLine)/pixelWidth + 0.5,0.0,min(1.0,2.0*radius/pixelWidth));
  if (coverage <= 0.0) { discard; }
  return tilePaintAt(u32(r.settings.x),i.local)*coverage;
}
`
    : ''
}
`,
    );
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const common = {
      layout: pipelineLayout,
      primitive: { topology: 'triangle-list' },
      multisample: { count: sampleCount },
    };
    const stencilFace = { compare: 'always', failOp: 'keep', depthFailOp: 'keep' };
    const quad = { module, entryPoint: 'tileQuadVertex' };
    const stencilPromise = requestPipeline('createRenderPipelineAsync', {
      ...common,
      label: 'tile winding ' + sampleLabel,
      vertex: {
        module,
        entryPoint: 'tilePathVertex',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module, entryPoint: 'tileStencilFragment', targets: [{ format, writeMask: 0 }] },
      depthStencil: {
        format: 'stencil8',
        stencilFront: { ...stencilFace, passOp: 'increment-wrap' },
        stencilBack: { ...stencilFace, passOp: 'decrement-wrap' },
        stencilReadMask: 255,
        stencilWriteMask: 255,
      },
    });
    const clearFace = { compare: 'not-equal', failOp: 'zero', depthFailOp: 'zero', passOp: 'zero' };
    const paintPromise = requestPipeline('createRenderPipelineAsync', {
      ...common,
      label: 'tile single fill and winding reset ' + sampleLabel,
      vertex: quad,
      fragment: { module, entryPoint: 'tilePaintFragment', targets: [{ format, blend }] },
      depthStencil: {
        format: 'stencil8',
        stencilFront: clearFace,
        stencilBack: clearFace,
        stencilReadMask: 255,
        stencilWriteMask: 255,
      },
    });
    const groupPromise = requestPipeline('createRenderPipelineAsync', {
      ...common,
      label: 'tile isolated group ' + sampleLabel,
      vertex: quad,
      fragment: { module, entryPoint: 'tileGroupFragment', targets: [{ format, blend }] },
      depthStencil: { format: 'stencil8', stencilReadMask: 255, stencilWriteMask: 0 },
    });
    const directPromise = requestPipeline('createRenderPipelineAsync', {
      ...common,
      label: 'tile direct convex ' + sampleLabel,
      vertex: {
        module,
        entryPoint: 'tilePathVertex',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module, entryPoint: 'tilePaintFragment', targets: [{ format, blend }] },
      depthStencil: {
        format: 'stencil8',
        stencilFront: { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep', failOp: 'keep', depthFailOp: 'keep' },
        stencilReadMask: 255,
        stencilWriteMask: 0,
      },
    });
    const instancedPromise = requestPipeline('createRenderPipelineAsync', {
      ...common,
      label: 'tile instanced convex ' + sampleLabel,
      vertex: { module, entryPoint: 'tileInstancedVertex' },
      fragment: { module, entryPoint: 'tilePaintFragment', targets: [{ format, blend }] },
      depthStencil: { format: 'stencil8', stencilWriteMask: 0 },
    });
    const capsulePromise = requestPipeline('createRenderPipelineAsync', {
      ...common,
      label: antialias ? 'tile analytic capsule union 4x target' : 'tile hard capsule union 1x target',
      vertex: quad,
      fragment: { module, entryPoint: 'tileCapsuleFragment', targets: [{ format, blend }] },
      depthStencil: { format: 'stencil8', stencilWriteMask: 0 },
    });
    const scaledCapsulePromise = coverageRasterScaling
      ? requestPipeline('createRenderPipelineAsync', {
          ...common,
          label: 'tile scaled root capsule union 4x target',
          vertex: quad,
          fragment: { module, entryPoint: 'tileScaledCapsuleFragment', targets: [{ format, blend }] },
          depthStencil: { format: 'stencil8', stencilWriteMask: 0 },
        })
      : null;
    stampLayout = device.createBindGroupLayout({
      label: 'tile stamp records and instances',
      entries: [
        { binding: 0, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: SS.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      ],
    });
    const stampModule = await checkedModule(
      'tile blob stamp shapes',
      GPU_STAMP_SHAPES_WGSL +
        `
struct TileRecord { rect: vec4f, viewport: vec4f, uv: vec4f, settings: vec4f }
@group(0) @binding(0) var<storage, read> tileRecords: array<TileRecord>;
@group(0) @binding(1) var<storage, read> tileStamps: array<Stamp>;
@group(0) @binding(2) var stampSampler: sampler;
@group(0) @binding(3) var stampShapes: texture_2d_array<f32>;
struct StampVertex { @builtin(position) position: vec4f, @location(0) p: vec2f, @location(1) @interpolate(flat) id: u32, @location(2) @interpolate(flat) clipRect: vec4f }
@vertex fn stampVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) id: u32) -> StampVertex {
  let quad = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
  let s = tileStamps[id]; let r = tileRecords[u32(s.head.y)];
  var p: vec2f;
  if (u32(s.head.x) == 5u) {
    let len = s.v[1].x;
    let width = s.v[1].y * (1.0 + abs(s.v[1].w));
    let bend = s.v[1].z * len;
    let lo = vec2f(-1.5, min(0.0, bend) - width - 1.5);
    let hi = vec2f(len + 1.5, max(0.0, bend) + width + 1.5);
    let local = mix(lo, hi, quad[vi] * 0.5 + vec2f(0.5));
    let dir = s.v[0].zw;
    p = s.v[0].xy + dir * local.x + vec2f(-dir.y, dir.x) * local.y;
  } else {
    p = clamp(s.box.xy + quad[vi] * s.box.zw, r.rect.xy, r.rect.xy + r.rect.zw);
  }
  let q = p + r.viewport.zw;
  var o: StampVertex; o.position = vec4f(q.x / r.viewport.x * 2.0 - 1.0, 1.0 - q.y / r.viewport.y * 2.0, 0.0, 1.0);
  o.p = p; o.id = id; o.clipRect = vec4f(r.rect.xy, r.rect.xy + r.rect.zw); return o;
}
@fragment fn stampFragment(i: StampVertex) -> @location(0) vec4f {
  let unit = max(abs(dpdx(i.p.x)), abs(dpdy(i.p.y)));
  let s = tileStamps[i.id];
  if (u32(s.head.x) == 5u && (any(i.p < i.clipRect.xy) || any(i.p >= i.clipRect.zw))) { return vec4f(0); }
  return stampColor(s, i.p, unit);
}
`,
    );
    const stampPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [stampLayout] });
    const stampCommon = {
      ...common,
      layout: stampPipelineLayout,
      vertex: { module: stampModule, entryPoint: 'stampVertex' },
      fragment: { module: stampModule, entryPoint: 'stampFragment', targets: [{ format, blend }] },
      depthStencil: {
        format: 'stencil8',
        stencilFront: { ...stencilFace, passOp: 'keep' },
        stencilBack: { ...stencilFace, passOp: 'keep' },
        stencilReadMask: 255,
        stencilWriteMask: 0,
      },
    };
    const stampSinglePromise = requestPipeline('createRenderPipelineAsync', {
      ...stampCommon,
      label: 'tile blob stamp 1x',
      multisample: { count: 1 },
    });
    const stampMSAAPromise = requestPipeline('createRenderPipelineAsync', {
      ...stampCommon,
      label: 'tile blob stamp 4x',
      multisample: { count: 4 },
    });
    stampSampler = device.createSampler({
      label: 'tile stamp shapes linear clamp',
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    stampShapes = retain(
      device.createTexture({
        label: 'tile stamp shape distance field',
        size: [256, 256, 2],
        format: 'rgba16float',
        usage: TU.TEXTURE_BINDING | TU.COPY_DST,
      }),
      stampField.pixels.byteLength,
      'stampFieldBytes',
    );
    stampShapesView = stampShapes.createView({ dimension: '2d-array' });
    resources.get(stampShapes).view = stampShapesView;
    metadata.createdTextureViews++;
    device.queue.writeTexture(
      { texture: stampShapes },
      stampField.pixels,
      { bytesPerRow: 256 * 8, rowsPerImage: 256 },
      [256, 256, 2],
    );
    metadata.stampFieldUploads++;
    metadata.stampFieldUploadBytes += stampField.pixels.byteLength;
    metadata.uploadedBytes += stampField.pixels.byteLength;
    stampField = null;
    const postModule = await checkedModule(
      'tile Gaussian crop and Y flip',
      `
struct TilePost { dims: vec4f, values: vec4f }
@group(0) @binding(0) var<uniform> tilePost: TilePost;
@group(0) @binding(1) var tileInput: texture_2d<f32>;
@vertex fn tilePostVertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
fn tilePixel(p: vec2i) -> vec4f { if (any(p < vec2i(0)) || any(p >= vec2i(tilePost.dims.xy))) { return vec4f(0); } return textureLoad(tileInput,p,0); }
@fragment fn tilePostFragment(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let finalPass = tilePost.values.z > 0.5; let sigma = tilePost.values.y;
  var p = vec2i(pos.xy);
  if (finalPass) { p = vec2i(i32(tilePost.values.x)+p.x,i32(tilePost.values.w+tilePost.dims.w)-1-p.y); }
  if (sigma <= 0.01) { return tilePixel(p); }
  let radius = i32(ceil(3.0*sigma)); var sum = vec4f(0); var weight = 0.0;
  for (var k = -64; k <= 64; k++) { if (abs(k) <= radius) {
    let f = f32(k); let w = exp(-0.5*f*f/(sigma*sigma)); let d = select(vec2i(k,0),vec2i(0,k),finalPass);
    sum += tilePixel(p+d)*w; weight += w;
  } }
  return sum/max(weight,1e-8);
}
`,
    );
    const postPromise = requestPipeline('createRenderPipelineAsync', {
      label: 'tile Gaussian crop premul output',
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'tilePostVertex' },
      fragment: { module: postModule, entryPoint: 'tilePostFragment', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const [stencil, paint, direct, instanced, capsule, group, post, stampSingle, stampMSAA, scaledCapsule] =
      await settlePipelines([
        stencilPromise,
        paintPromise,
        directPromise,
        instancedPromise,
        capsulePromise,
        groupPromise,
        postPromise,
        stampSinglePromise,
        stampMSAAPromise,
        ...(scaledCapsulePromise ? [scaledCapsulePromise] : []),
      ]);
    pipelines = {
      stencil,
      paint,
      direct,
      instanced,
      capsule,
      group,
      post,
      scaledCapsule,
      stamp: antialias ? stampMSAA : stampSingle,
    };
    if (gpuPreparation) {
      const computed = { module, entryPoint: 'tileComputedVertex' },
        preparedQuad = { module, entryPoint: 'tilePreparedQuadVertex' };
      const computedStencilPromise = requestPipeline('createRenderPipelineAsync', {
        ...common,
        label: 'tile computed winding ' + sampleLabel,
        vertex: computed,
        fragment: { module, entryPoint: 'tileStencilFragment', targets: [{ format, writeMask: 0 }] },
        depthStencil: stencil.depthStencil || {
          format: 'stencil8',
          stencilFront: { ...stencilFace, passOp: 'increment-wrap' },
          stencilBack: { ...stencilFace, passOp: 'decrement-wrap' },
          stencilReadMask: 255,
          stencilWriteMask: 255,
        },
      });
      const computedDirectPromise = requestPipeline('createRenderPipelineAsync', {
        ...common,
        label: 'tile computed direct convex ' + sampleLabel,
        vertex: computed,
        fragment: { module, entryPoint: 'tilePaintFragment', targets: [{ format, blend }] },
        depthStencil: { format: 'stencil8', stencilWriteMask: 0 },
      });
      const preparedPaintPromise = requestPipeline('createRenderPipelineAsync', {
        ...common,
        label: 'tile prepared single fill and winding reset ' + sampleLabel,
        vertex: preparedQuad,
        fragment: { module, entryPoint: 'tilePaintFragment', targets: [{ format, blend }] },
        depthStencil: {
          format: 'stencil8',
          stencilFront: clearFace,
          stencilBack: clearFace,
          stencilReadMask: 255,
          stencilWriteMask: 255,
        },
      });
      const preparedCapsulePromise = requestPipeline('createRenderPipelineAsync', {
        ...common,
        label: antialias ? 'tile prepared capsule union 4x target' : 'tile prepared hard capsule union 1x target',
        vertex: preparedQuad,
        fragment: { module, entryPoint: 'tileCapsuleFragment', targets: [{ format, blend }] },
        depthStencil: { format: 'stencil8', stencilWriteMask: 0 },
      });
      const preparedScaledCapsulePromise = coverageRasterScaling
        ? requestPipeline('createRenderPipelineAsync', {
            ...common,
            label: 'tile prepared scaled root capsule union 4x target',
            vertex: preparedQuad,
            fragment: { module, entryPoint: 'tileScaledCapsuleFragment', targets: [{ format, blend }] },
            depthStencil: { format: 'stencil8', stencilWriteMask: 0 },
          })
        : null;
      const preparedGroupPromise = requestPipeline('createRenderPipelineAsync', {
        ...common,
        label: 'tile prepared isolated group ' + sampleLabel,
        vertex: preparedQuad,
        fragment: { module, entryPoint: 'tileGroupFragment', targets: [{ format, blend }] },
        depthStencil: { format: 'stencil8', stencilReadMask: 255, stencilWriteMask: 0 },
      });
      const variants = await settlePipelines([
        computedStencilPromise,
        computedDirectPromise,
        preparedPaintPromise,
        preparedCapsulePromise,
        preparedGroupPromise,
        ...(preparedScaledCapsulePromise ? [preparedScaledCapsulePromise] : []),
      ]);
      [
        'computedStencil',
        'computedDirect',
        'preparedPaint',
        'preparedCapsule',
        'preparedGroup',
        ...(coverageRasterScaling ? ['preparedScaledCapsule'] : []),
      ].forEach((key, index) => {
        pipelines[key] = variants[index];
      });
      const computeModule = await checkedModule(
        'tile bounded geometry visibility and indirect arguments',
        `
struct TileRecord { rect: vec4f, viewport: vec4f, uv: vec4f, settings: vec4f }
struct TilePrepareOp { data: vec4u, extra: vec4u }
struct TilePreparedVertex { p: vec2f, owner: u32, transform: u32 }
struct TileComputeRange { first: u32, count: u32, unused: u32, ownerSlots: u32 }
@group(0) @binding(0) var<storage,read> tileSource: array<vec2f>;
@group(0) @binding(1) var<storage,read> tileRecords: array<TileRecord>;
@group(0) @binding(2) var<storage,read> tileOps: array<TilePrepareOp>;
@group(0) @binding(3) var<storage,read> tileSegments: array<f32>;
@group(0) @binding(4) var<storage,read> tileTasks: array<u32>;
@group(0) @binding(5) var<storage,read_write> tilePrepared: array<TilePreparedVertex>;
@group(0) @binding(6) var<storage,read_write> tileIndirect: array<u32>;
@group(0) @binding(7) var<storage,read_write> tileVisible: array<u32>;
@group(0) @binding(8) var<uniform> tileRange: TileComputeRange;
fn tileIsVisible(id: u32) -> bool {
  let r = tileRecords[id]; let lo = r.rect.xy+r.viewport.zw; let hi = lo+r.rect.zw;
  return all(r.rect.zw > vec2f(0)) && all(hi > vec2f(0)) && all(lo < r.viewport.xy);
}
@compute @workgroup_size(64) fn tilePrepare(@builtin(global_invocation_id) invocation: vec3u) {
  if (invocation.x >= tileRange.count) { return; }
  let slot = tileRange.first+invocation.x; let op = tileOps[slot]; let id = op.extra.x;
  tileVisible[id] = select(0u,1u,tileIsVisible(id));
  let members = max(1u,op.extra.z); var anyVisible = false;
  for (var j = 0u; j < 32u; j++) { if (j < members) { anyVisible = anyVisible || tileIsVisible(id+j); } }
  let path = op.data.x == 4u; let base = slot*8u;
  tileIndirect[base] = select(6u*members,op.extra.w,path);
  tileIndirect[base+1u] = select(0u,1u,anyVisible);
  tileIndirect[base+2u] = select(id*6u,op.data.w,path);
  tileIndirect[base+3u] = 0u;
  tileIndirect[base+4u] = 6u*members; tileIndirect[base+5u] = select(0u,1u,anyVisible);
  tileIndirect[base+6u] = id*6u; tileIndirect[base+7u] = 0u;
}
fn tileCurvePoint(k: u32, t: f32) -> vec2f {
  let kind = u32(tileSegments[k]); let p0 = vec2f(tileSegments[k+6u],tileSegments[k+7u]);
  let p1 = vec2f(tileSegments[k+8u],tileSegments[k+9u]); let p2 = vec2f(tileSegments[k+10u],tileSegments[k+11u]);
  let p3 = vec2f(tileSegments[k+12u],tileSegments[k+13u]); let a = 1.0-t;
  if (kind == 1u) { return mix(p0,p1,t); }
  if (kind == 2u) { return a*a*p0+2.0*a*t*p1+t*t*p2; }
  if (kind == 3u) { return a*a*a*p0+3.0*a*a*t*p1+3.0*a*t*t*p2+t*t*t*p3; }
  let angle = tileSegments[k+14u]+t*tileSegments[k+15u]; return p0+cos(angle)*p1+sin(angle)*p2;
}
fn tilePetalPoint(k: u32, sample: u32) -> vec2f {
  var prefix = 0u;
  for (var part = 0u; part < 6u; part++) {
    let n = u32(tileSegments[k+8u+part]);
    if (sample <= prefix+n || part == 5u) {
      let t = f32(sample-prefix)/f32(n); let a = 1.0-t;
      if (part == 0u) { return 3.0*a*a*t*vec2f(0.22,-0.2)+3.0*a*t*t*vec2f(0.5,-0.56)+t*t*t*vec2f(0.84,-0.42); }
      if (part == 1u) { return a*a*vec2f(0.84,-0.42)+2.0*a*t*vec2f(1.02,-0.33)+t*t*vec2f(0.99,-0.1); }
      if (part == 2u) { return mix(vec2f(0.99,-0.1),vec2f(0.86,-0.01),t); }
      if (part == 3u) { return mix(vec2f(0.86,-0.01),vec2f(0.99,0.09),t); }
      if (part == 4u) { return a*a*vec2f(0.99,0.09)+2.0*a*t*vec2f(1.02,0.33)+t*t*vec2f(0.84,0.42); }
      return a*a*a*vec2f(0.84,0.42)+3.0*a*a*t*vec2f(0.5,0.56)+3.0*a*t*t*vec2f(0.22,0.2);
    }
    prefix += n;
  }
  return vec2f(0);
}
@compute @workgroup_size(64) fn tileExpand(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) invocation: vec3u) {
  if (group.x >= tileRange.count) { return; }
  let segment = tileRange.first+group.x; let slot = tileTasks[segment]; if (slot == 0xffffffffu) { return; }
  let k = segment*16u; let op = tileOps[slot]; let owner = op.extra.x; let steps = u32(tileSegments[k+1u]);
  let dest = op.data.w+u32(tileSegments[k+2u])-op.data.y; let transform = u32(tileSegments[k+3u]);
  let anchor = vec2f(tileSegments[k+4u],tileSegments[k+5u]);
  for (var i = invocation.x; i < steps*3u; i += 64u) {
    var p = vec2f(0);
    if (tileVisible[owner] != 0u) {
      let corner = i%3u; let triangle = i/3u;
      if (corner == 0u) { p = anchor; }
      else { let sample = triangle+select(0u,1u,corner == 2u);
        if (u32(tileSegments[k]) == 5u) { p = tilePetalPoint(k,sample); }
        else { p = tileCurvePoint(k,f32(sample)/f32(steps)); }
      }
    }
    tilePrepared[dest+i] = TilePreparedVertex(p,owner,transform);
  }
}
`,
      );
      const computeLayout = device.createBindGroupLayout({
        label: 'tile compute baseline storage bindings',
        entries: [
          ...Array.from({ length: 8 }, (_, binding) => ({
            binding,
            visibility: SS.COMPUTE,
            buffer: { type: binding < 5 ? 'read-only-storage' : 'storage' },
          })),
          { binding: 8, visibility: SS.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      const computePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [computeLayout] });
      pipelines.computeLayout = computeLayout;
      const computeEntries = [
        ['prepare', 'tilePrepare'],
        ['expand', 'tileExpand'],
      ];
      const computePipelines = await settlePipelines(
        computeEntries.map(([key, entryPoint]) =>
          requestPipeline('createComputePipelineAsync', {
            label: 'tile bounded ' + key,
            layout: computePipelineLayout,
            compute: { module: computeModule, entryPoint },
          }),
        ),
      );
      computeEntries.forEach(([key], index) => {
        pipelines[key] = computePipelines[index];
      });
    }
    sampler = device.createSampler({ label: 'tile group linear sampler', minFilter: 'linear', magFilter: 'linear' });
    dummy = texture('tile no group source', 1, 1);
    dummyView = dummy.createView();
    if (gpuPreparation) {
      dummyPoints = buffer('tile empty source points', 8, BU.STORAGE);
      dummyPrepared = buffer('tile empty generated geometry', 16, BU.STORAGE);
      dummyTransforms = buffer('tile empty affine transforms', 32, BU.STORAGE);
      dummyVisible = buffer('tile empty visibility', 4, BU.STORAGE);
    }
  } catch (e) {
    initError = e;
  }
  await Promise.allSettled(pipelineRequests);
  let validation;
  try {
    validation = await device.popErrorScope();
  } catch (e) {
    initError ||= e;
  }
  if (initError || validation) {
    for (const r of [...resources.keys()]) release(r);
    throw initError || Error('Tile validation: ' + validation.message);
  }

  function jobResources(job) {
    return job.owned;
  }
  function own(job, resource) {
    job.owned.push(resource);
    resources.get(resource).owner = job;
    return resource;
  }
  function finishStats(job) {
    metadata.lastJob = { ...job.stats, phase: job.phase, byteCount: metadata.byteCount };
    return metadata.lastJob;
  }
  function adoptIndexedPlan(job, plan) {
    if (plan.version === 1) job.legacyPlan = plan;
    const p = flattenTileDataPlan(plan);
    for (const key of [
      'opCount',
      'nodeCount',
      'gpuOpCount',
      'stageCount',
      'opData',
      'opWork',
      'nodeData',
      'nodeOps',
      'nodeGeo',
      'stageData',
      'stageNodes',
      'gpuPreparation',
      'preparedVertexCount',
      'recordData',
      'prepareData',
      'taskData',
      'iterations',
    ])
      job[key] = p[key];
    job.stages = [];
    for (let i = 0; i < p.stageCount; i++) {
      const k = i * 6;
      job.stages.push({
        width: p.stageData[k],
        height: p.stageData[k + 1],
        nodeFirst: p.stageData[k + 2],
        nodeCount: p.stageData[k + 3],
        nodeIndex: 0,
        opIndex: 0,
        kind: p.stageData[k + 4] ? 'tile' : 'atlas',
      });
    }
    job.tileStage = job.stages.at(-1);
    job.segmentOwners = p.taskData;
    job.stats.commandStorage = p.storage;
    job.stats.foregroundPathObjects = 0;
    job.stats.foregroundAtlasObjects = p.stageCount;
  }
  function cancel() {
    if (!active) {
      metadata.lastCancelCPUms = 0;
      return;
    }
    const begin = clock();
    const job = active;
    if (job.phase !== 'done') metadata.jobsCancelled++;
    for (const r of jobResources(job)) if (resources.get(r)?.owner === job) release(r);
    retired.length = 0;
    active = null;
    needsSubmission = false;
    metadata.lastCancelCPUms = clock() - begin;
    metadata.maxCancelCPUms = Math.max(metadata.maxCancelCPUms, metadata.lastCancelCPUms);
  }
  function start(packet, settings = {}) {
    if (disposed) throw Error('Tile renderer disposed');
    if (needsSubmission) throw Error('Tile submitted() is required before starting the next job');
    const startBegin = clock();
    cancel();
    const begin = clock(),
      prepared = packet?.preprocessed;
    if (
      ![1, 2].includes(packet?.version) ||
      !(packet.vertices instanceof Float32Array) ||
      !(packet.paints instanceof Float32Array) ||
      (!prepared && !Array.isArray(packet.commands))
    )
      throw Error('Invalid tile mesh packet v1/v2');
    if (packet.vertices.length % 6 || packet.paints.length % 64) throw Error('Invalid tile vertex or paint stride');
    if (
      packet.version === 2 &&
      (!gpuPreparation ||
        !(packet.segments instanceof Float32Array) ||
        packet.segments.length % 16 ||
        !(packet.transforms instanceof Float32Array) ||
        packet.transforms.length % 8 ||
        !Number.isInteger(packet.generatedVertexCount) ||
        packet.generatedVertexCount < 0)
    )
      throw Error('Invalid tile compact packet v2 or GPU preparation disabled');
    const width = Math.round(settings.width ?? packet.width),
      height = Math.round(settings.height ?? packet.height),
      pad = Math.round(settings.pad || 0),
      sigma = Number(settings.sigma || 0);
    if (!(
      width > 0 &&
      height > 0 &&
      pad >= 0 &&
      sigma >= 0 &&
      sigma <= 64 / 3 &&
      packet.width === width + pad * 2 &&
      packet.height === height + pad * 2
    ))
      throw Error('Tile crop/blur dimensions do not match packet');
    if (packet.width > maxDimension || packet.height > maxDimension)
      throw Error('Tile packet exceeds texture dimension limit');
    const raster = gpuTileRasterPlan(width, height, pad, settings.rasterScale);
    if (raster.scale < 1 && !rasterScaling)
      throw Error('Tile rasterScale below 1 requires createGPUTileRenderer({ rasterScaling: true })');
    const rasterCoverageData = coverageRasterScaling
      ? new Float32Array([Math.max(1 / raster.sx, 1 / raster.sy), 0, 0, 0])
      : null;
    const identity = { era: settings.era, id: settings.jobId };
    const plan = prepared ? validateTilePreprocessed(packet, preprocessConfig, identity) : null;
    const preprocessor = plan ? null : createTilePreprocessor(packet, preprocessConfig, identity);
    const job = plan ? { stats: { ...plan.stats }, phase: 'allocate' } : preprocessor.state;
    if (plan) adoptIndexedPlan(job, plan);
    Object.assign(job, {
      id: ++sequence,
      packet,
      settings: { width, height, pad, sigma, rasterScale: raster.scale },
      raster,
      rasterCoverageData,
      owned: [],
      preprocessor,
      computeMode: 'prepare',
      computeIndex: 0,
      uploads: [],
      uploadIndex: 0,
      stageIndex: 0,
      postRow: 0,
      output: null,
      inputAllocationIndex: 0,
      bindings: new Map(),
    });
    const workerTimings = packet.workerTimings || plan?.timings;
    Object.assign(job.stats, {
      id: sequence,
      preprocessMode: plan ? 'worker' : 'main',
      mainPreprocessCPUms: 0,
      workerPreprocessMs: workerTimings?.preprocessMs || 0,
      workerPaintMs: workerTimings?.paintMs || 0,
      workerExportMs: workerTimings?.exportMs || 0,
      preprocessIterations: plan?.iterations || 0,
      mainPreprocessStagesSkipped: plan ? (job.gpuPreparation ? 4 : 3) : 0,
      preprocessedTransferBytes: plan?.transferBytes || 0,
      recursiveCommandsTransferred: Array.isArray(packet.commands),
      workerDiagnostics: packet.workerDiagnostics || null,
      startCPUms: 0,
      bindingCPUms: 0,
      computePrepareCPUms: 0,
      inputAllocationCPUms: 0,
      stageAllocationCPUms: 0,
      postAllocationCPUms: 0,
      selectionCPUms: 0,
      drawCommandCPUms: 0,
      computeCommandCPUms: 0,
      postCommandCPUms: 0,
      allocationOperations: 0,
      maxAllocationOperationCPUms: 0,
      maxBindingOperationCPUms: 0,
      bindingChanges: 0,
      pipelineChanges: 0,
    });
    job.stats.stampInstances ??= (packet.stamps?.length || 0) / 32;
    job.stats.stampBytes = packet.stamps?.byteLength || 0;
    job.stats.stampDraws = 0;
    job.stats.stampDrawInstances = 0;
    job.stats.raster = {
      scale: raster.scale,
      sx: raster.sx,
      sy: raster.sy,
      logicalWidth: width,
      logicalHeight: height,
      logicalPad: pad,
      logicalStageWidth: packet.width,
      logicalStageHeight: packet.height,
      outputWidth: raster.outputWidth,
      outputHeight: raster.outputHeight,
      stageWidth: raster.stageWidth,
      stageHeight: raster.stageHeight,
      padX: raster.padX,
      padY: raster.padY,
      viewport: { ...raster.viewport },
      sigmaX: sigma * raster.sx,
      sigmaY: sigma * raster.sy,
      antialias,
      sampleCount,
      coveragePixelWidth: antialias ? (coverageRasterScaling ? rasterCoverageData[0] : 1) : null,
      coverageUniformBytes: coverageRasterScaling ? 16 : 0,
      rootOnly: true,
      groupAtlasScaled: false,
      geometryScaled: false,
      packetChanged: false,
    };
    metadata.lastWorkerDiagnostics = job.stats.workerDiagnostics;
    if (plan) {
      plan.consumed = true;
      delete packet.preprocessed;
      metadata.workerPreprocessedJobs++;
      metadata.workerPreprocessMs += job.stats.workerPreprocessMs;
      metadata.mainPreprocessStagesSkipped += job.stats.mainPreprocessStagesSkipped;
    } else metadata.mainPreprocessedJobs++;
    metadata.lastAdoptCPUms = job.stats.adoptCPUms = clock() - begin;
    active = job;
    metadata.jobsStarted++;
    metadata.stampInstances += job.stats.stampInstances;
    metadata.stampBytes += job.stats.stampBytes;
    finishStats(job);
    metadata.lastStartCPUms = job.stats.startCPUms = job.pendingStartCPUms = clock() - startBegin;
    metadata.lastJob.startCPUms = job.stats.startCPUms;
    metadata.maxStartCPUms = Math.max(metadata.maxStartCPUms, job.stats.startCPUms);
    return job;
  }
  function noteAllocation(result, phase, elapsed) {
    result.allocationCPUms += elapsed;
    result[phase + 'AllocationCPUms'] += elapsed;
    result.allocationOperations++;
    result.maxAllocationOperationCPUms = Math.max(result.maxAllocationOperationCPUms, elapsed);
  }
  function allocateInputs(job, result) {
    const allocationStart = clock();
    if (!job.inputAllocations) {
      const storage = BU.STORAGE | BU.COPY_DST;
      job.inputAllocations = [
        [
          'vertexBuffer',
          'tile vertices',
          Math.max(8, job.packet.vertices.byteLength),
          BU.VERTEX | storage,
          job.packet.vertices,
        ],
        ['paintBuffer', 'tile paints', job.packet.paints.byteLength, storage, job.packet.paints],
        ['recordBuffer', 'tile command records', job.recordData.byteLength, storage, job.recordData],
      ];
      if (job.packet.stamps?.length)
        job.inputAllocations.push([
          'stampBuffer',
          'tile stamps',
          job.packet.stamps.byteLength,
          storage,
          job.packet.stamps,
        ]);
      if (coverageRasterScaling)
        job.inputAllocations.push([
          'rasterCoverageUniform',
          'tile root raster coverage',
          16,
          BU.UNIFORM | BU.COPY_DST,
          job.rasterCoverageData,
        ]);
      if (job.gpuPreparation) {
        const segmentData = job.packet.segments || emptyFloats,
          transforms = job.packet.transforms || emptyFloats;
        job.segmentOwners = job.taskData;
        job.computeRangeData = computeRangeScratch;
        job.inputAllocations.push(
          ['prepareBuffer', 'tile GPU operation parameters', job.prepareData.byteLength, storage, job.prepareData],
          ['segmentBuffer', 'tile curve parameters', Math.max(64, segmentData.byteLength), storage, segmentData],
          ['transformBuffer', 'tile curve affine transforms', Math.max(32, transforms.byteLength), storage, transforms],
          ['taskBuffer', 'tile geometry tasks', Math.max(4, job.taskData.byteLength), storage, job.taskData],
          ['preparedBuffer', 'tile GPU generated geometry', Math.max(16, job.preparedVertexCount * 16), storage],
          [
            'indirectBuffer',
            'tile GPU indirect parameters',
            Math.max(32, job.gpuOpCount * 32),
            BU.STORAGE | BU.INDIRECT,
          ],
          ['visibleBuffer', 'tile GPU visibility', Math.max(4, job.opCount * 4), BU.STORAGE],
          ['computeUniform', 'tile compute slice range', 16, BU.UNIFORM | BU.COPY_DST],
        );
      }
    }
    const [key, label, bytes, usage, data] = job.inputAllocations[job.inputAllocationIndex];
    const size = align4(bytes),
      limit = Math.min(
        device.limits.maxStorageBufferBindingSize,
        device.limits.maxBufferSize ?? device.limits.maxStorageBufferBindingSize,
      );
    if (!Number.isSafeInteger(size) || size > limit) throw Error('Tile storage buffer exceeds binding limit');
    const resource = (job[key] = own(job, buffer(label, bytes, usage)));
    if (resource.size > limit) throw Error('Tile storage buffer exceeds binding limit');
    if (key === 'vertexBuffer' && job.gpuPreparation) job.sourceVertexBuffer = resource;
    if (data) job.uploads.push({ buffer: resource, data, offset: 0 });
    noteAllocation(result, 'input', clock() - allocationStart);
    if (++job.inputAllocationIndex === job.inputAllocations.length) {
      job.inputAllocations = null;
      job.phase = 'upload';
    }
  }
  function cachedBinding(key, members, descriptor, result) {
    const begin = clock();
    if (reuseResources && bindingCache.has(key)) {
      metadata.reusedBindings++;
      if (result) {
        result.bindingCPUms += clock() - begin;
        result.bindingReuses++;
      }
      return bindingCache.get(key).group;
    }
    const group = device.createBindGroup(descriptor());
    metadata.createdBindings++;
    if (reuseResources) {
      if (bindingCache.size >= 64) bindingCache.delete(bindingCache.keys().next().value);
      bindingCache.set(key, { group, resources: members });
    }
    if (result) {
      const elapsed = clock() - begin;
      result.bindingCPUms += elapsed;
      result.bindingCreates++;
      result.maxBindingOperationCPUms = Math.max(result.maxBindingOperationCPUms, elapsed);
    }
    return group;
  }
  function bind(job, image, result) {
    const key = image || dummy;
    const existing = job.bindings.get(key);
    if (existing) return existing;
    const prepared = job.preparedBuffer || dummyPrepared,
      transforms = job.transformBuffer || dummyTransforms,
      visible = job.visibleBuffer || dummyVisible;
    const members = [
      job.paintBuffer,
      job.recordBuffer,
      job.vertexBuffer,
      key,
      ...(gpuPreparation ? [prepared, transforms, visible] : []),
      ...(coverageRasterScaling ? [job.rasterCoverageUniform] : []),
    ];
    const cacheKey = 'draw:' + members.map(r => resources.get(r).id).join(':');
    job.bindings.set(
      key,
      cachedBinding(
        cacheKey,
        members,
        () => ({
          label: 'tile paint or isolated group',
          layout,
          entries: [
            { binding: 0, resource: { buffer: job.paintBuffer } },
            { binding: 1, resource: { buffer: job.recordBuffer } },
            { binding: 2, resource: sampler },
            { binding: 3, resource: image ? textureView(image) : dummyView },
            { binding: 4, resource: { buffer: job.vertexBuffer } },
            ...(gpuPreparation
              ? [
                  { binding: 5, resource: { buffer: prepared } },
                  { binding: 6, resource: { buffer: transforms } },
                  { binding: 7, resource: { buffer: visible } },
                ]
              : []),
            ...(coverageRasterScaling ? [{ binding: 8, resource: { buffer: job.rasterCoverageUniform } }] : []),
          ],
        }),
        result,
      ),
    );
    return job.bindings.get(key);
  }
  function bindStamps(job, result) {
    if (job.stampBinding) return job.stampBinding;
    const members = [job.recordBuffer, job.stampBuffer, stampShapes];
    return (job.stampBinding = cachedBinding(
      'stamp:' + members.map(r => resources.get(r).id).join(':'),
      members,
      () => ({
        label: 'tile stamp records and instances',
        layout: stampLayout,
        entries: [
          { binding: 0, resource: { buffer: job.recordBuffer } },
          { binding: 1, resource: { buffer: job.stampBuffer } },
          { binding: 2, resource: stampSampler },
          { binding: 3, resource: stampShapesView },
        ],
      }),
      result,
    ));
  }
  function allocateStage(job, stage, result) {
    const begin = clock();
    const w = stage === job.tileStage ? job.raster.stageWidth : stage.width,
      h = stage === job.tileStage ? job.raster.stageHeight : stage.height;
    if (!stage.image) {
      stage.image = own(job, texture('tile ' + stage.kind + ' resolved', w, h));
      stage.imageView = textureView(stage.image);
    } else if (antialias && !stage.samples) {
      stage.samples = own(job, texture('tile ' + stage.kind + ' 4x samples', w, h, 'sampleBytes', sampleCount));
      stage.sampleView = textureView(stage.samples);
    } else {
      stage.stencil = own(job, texture('tile ' + stage.kind + ' winding', w, h, 'stencilBytes', sampleCount, true));
      stage.stencilView = textureView(stage.stencil);
    }
    noteAllocation(result, 'stage', clock() - begin);
  }
  function computeSlice(job, encoder, budget, result, deadline) {
    if (budget.uploadBytes - result.uploadedBytes < 16) return;
    if (deadline - clock() < 0.025) return;
    const prepareStart = clock();
    let mode = job.computeMode,
      total = mode === 'prepare' ? job.gpuOpCount : (job.packet.segments?.length || 0) / 16;
    while (job.computeIndex === total) {
      if (mode === 'expand') {
        prepareRender(job, false);
        result.computePrepareCPUms += clock() - prepareStart;
        return;
      }
      mode = job.computeMode = 'expand';
      job.computeIndex = 0;
      total = (job.packet.segments?.length || 0) / 16;
    }
    let count = 0,
      work = 0,
      vertices = 0;
    const computeWork = Math.max(1, budget.gpuTargetMs / computeCosts[mode]);
    const maxGroups = budget.opening
      ? mode === 'prepare'
        ? deviceComputeGroups * 64
        : deviceComputeGroups
      : mode === 'prepare'
        ? computePrepareMaxOperations
        : computeMaxGroups;
    const vertexLimit = budget.opening
      ? Infinity
      : Math.max(768, Math.min(computeMaxVertices, Math.floor(computeWork)));
    if (mode === 'prepare') {
      count = Math.min(total - job.computeIndex, maxGroups, Math.max(1, Math.floor(computeWork / 16)));
      work = count * 16;
    }
    while (mode !== 'prepare' && job.computeIndex + count < total && count < maxGroups) {
      const index = job.computeIndex + count;
      const add = job.packet.segments[index * 16 + 1] * 3;
      if (
        count &&
        (work + add > computeWork || vertices + add > vertexLimit || (count % 32 === 0 && deadline - clock() < 0.04))
      )
        break;
      work += add;
      vertices += add;
      count++;
    }
    result.computePrepareCPUms += clock() - prepareStart;
    if (!count) return;
    if (!job.computeBinding) {
      const members = [
        job.vertexBuffer,
        job.recordBuffer,
        job.prepareBuffer,
        job.segmentBuffer,
        job.taskBuffer,
        job.preparedBuffer,
        job.indirectBuffer,
        job.visibleBuffer,
        job.computeUniform,
      ];
      job.computeBinding = cachedBinding(
        'compute:' + members.map(r => resources.get(r).id).join(':'),
        members,
        () => ({
          label: 'tile bounded compute resources',
          layout: pipelines.computeLayout,
          entries: members.map((resource, binding) => ({ binding, resource: { buffer: resource } })),
        }),
        result,
      );
    }
    if (deadline - clock() < 0.025) return;
    job.computeRangeData[0] = job.computeIndex;
    job.computeRangeData[1] = count;
    job.computeRangeData[2] = 0;
    job.computeRangeData[3] = job.segmentOwners.length;
    const uploadStart = clock();
    device.queue.writeBuffer(job.computeUniform, 0, job.computeRangeData);
    noteUpload(result, 16, clock() - uploadStart);
    result.uploadedBytes += 16;
    const encodeStart = clock(),
      gpuPassLabel = 'tile ' + mode + ' bounded slice';
    const pass = encoder.beginComputePass({
      label: gpuPassLabel,
      ...(budget.timestampWrites ? { timestampWrites: budget.timestampWrites } : {}),
    });
    pass.setPipeline(pipelines[mode]);
    pass.setBindGroup(0, job.computeBinding);
    pass.dispatchWorkgroups(mode === 'prepare' ? Math.ceil(count / 64) : count);
    pass.end();
    const encodeCPUms = clock() - encodeStart;
    result.encodeCPUms += encodeCPUms;
    result.computeCommandCPUms += encodeCPUms;
    result.computePasses++;
    result.computedVertices += vertices;
    result.passes++;
    result.work += work;
    result.encoded = true;
    result.timestampEncoded = true;
    result.gpuWorkKind = 'compute-' + mode;
    result.gpuPassLabel = gpuPassLabel;
    needsSubmission = true;
    job.computeIndex += count;
    metadata.computePasses++;
    metadata.computedVertices += vertices;
    if (mode === 'prepare') {
      result.visibilityCandidates += count;
      metadata.visibilityCandidates += count;
    }
    if (job.computeIndex === total && mode === 'expand') prepareRender(job, true);
  }
  function prepareRender(job, encoded) {
    job.phase = 'render';
    if (!job.stats.analyticStrokePaths && !job.stats.fallbackPaths) {
      const source = job.vertexBuffer;
      job.vertexBuffer = dummyPoints;
      if (encoded) later(source);
      else retire(source);
    }
  }
  function learnCPU(draws, elapsed, drawLimit) {
    const minimumDraws = Math.max(1, Math.min(16, Math.floor(drawLimit * 0.5)));
    if (!(draws >= minimumDraws && Number.isFinite(elapsed) && elapsed >= 0)) return;
    cpuFeedbackDraws += draws;
    cpuFeedbackElapsed += elapsed;
    cpuFeedbackSlices++;
    metadata.cpuBudgetPendingDraws = cpuFeedbackDraws;
    metadata.cpuBudgetPendingSlices = cpuFeedbackSlices;
    metadata.cpuBudgetPendingElapsedMs = cpuFeedbackElapsed;
    if (cpuFeedbackDraws < 64 && cpuFeedbackSlices < 8) return;
    if (cpuFeedbackElapsed < cpuFeedbackMinimumMs) return;
    const measured = Math.max(0.00001, cpuFeedbackElapsed / cpuFeedbackDraws);
    cpuFeedbackDraws = cpuFeedbackElapsed = cpuFeedbackSlices = 0;
    metadata.cpuBudgetPendingDraws = metadata.cpuBudgetPendingSlices = 0;
    metadata.cpuBudgetPendingElapsedMs = 0;
    msPerDraw = measured > msPerDraw ? measured : msPerDraw * 0.88 + measured * 0.12;
    const wanted = clamp(Math.floor(0.6 / Math.max(msPerDraw, 0.00001)), 2, 8192);
    liveDrawLimit = wanted < liveDrawLimit ? wanted : Math.min(wanted, Math.floor(liveDrawLimit * 1.125) + 2);
    metadata.cpuMsPerDraw = msPerDraw;
    metadata.adaptiveDrawLimit = liveDrawLimit;
    metadata.cpuBudgetSamples++;
  }
  function renderSlice(job, encoder, budget, result, deadline) {
    if (budget.explicitDrawLimit < 1) return;
    const stage = job.stages[job.stageIndex];
    if (!stage) {
      job.phase = 'post';
      return;
    }
    while (!stage.stencilView && clock() < deadline) allocateStage(job, stage, result);
    if (!stage.stencilView) return;
    bind(job, null, result);
    if (job.stampBuffer) bindStamps(job, result);
    const renderStart = clock(),
      remaining = deadline - renderStart;
    if (remaining <= 0.025) return;
    const cpuTarget = Math.min(budget.renderCPUms, remaining - 0.015);
    const cpuEnd = Math.min(deadline - 0.015, renderStart + cpuTarget);
    const adaptiveLimit = budget.opening
      ? Math.max(2, job.opCount * 2)
      : Math.max(2, Math.floor((liveDrawLimit * cpuTarget) / 0.6));
    const drawLimit = Math.min(budget.explicitDrawLimit, adaptiveLimit);
    result.currentDrawLimit = drawLimit;
    result.renderCPUTargetMs = budget.opening ? 0 : cpuTarget;
    result.renderCPUUnbounded = budget.opening;
    metadata.currentDrawLimit = drawLimit;
    metadata.renderCPUTargetMs = result.renderCPUTargetMs;
    const countBudget = coarseClock && !budget.opening;
    result.renderCPUBudgetMode = countBudget ? 'estimated-draw-count' : 'deadline';
    let chosenCount = 0,
      work = 0,
      draws = 0,
      inspected = 0;
    const od = job.opData,
      nd = job.nodeData,
      rows = job.nodeOps,
      ow = job.opWork,
      sn = job.stageNodes;
    const bindingBeforeSelection = result.bindingCPUms;
    const inspectionLimit = countBudget ? Math.max(64, drawLimit * 8) : Infinity;
    while (
      stage.nodeIndex < stage.nodeCount &&
      chosenCount < 32768 &&
      inspected < inspectionLimit &&
      (inspected++ === 0 || countBudget || clock() < cpuEnd)
    ) {
      const node = sn[stage.nodeFirst + stage.nodeIndex],
        nk = node * 8;
      if (stage.opIndex === nd[nk + 6]) {
        stage.nodeIndex++;
        stage.opIndex = 0;
        continue;
      }
      const index = rows[nd[nk + 5] + stage.opIndex],
        k = index * 12,
        kind = od[k],
        flags = od[k + 1],
        gpuIndex = od[k + 6];
      if (flags & 1) {
        stage.opIndex++;
        continue;
      }
      const addDraws = kind === 5 ? 1 : kind === 1 && !(flags & 2) ? 2 : 1;
      let addWork = ow[index * 2],
        members = 1,
        vertexCount = kind === 1 ? od[k + 3] : 6,
        usefulVertices = vertexCount;
      if (kind !== 5 && gpuIndex !== 0xffffffff) {
        members = od[k + 7];
        vertexCount = usefulVertices = od[k + 8];
        addWork = ow[index * 2 + 1];
      }
      if (metadata.convexInstancing && kind === 1 && !(flags & 4) && flags & 2) {
        let rawWork = addWork;
        while (members < 32 && stage.opIndex + members < nd[nk + 6] && (countBudget || clock() < cpuEnd)) {
          const next = rows[nd[nk + 5] + stage.opIndex + members],
            q = next * 12;
          if (od[q + 1] & 5 || od[q] !== 1 || !(od[q + 1] & 2) || next !== index + members) break;
          const nextMax = Math.max(vertexCount, od[q + 3]),
            nextUseful = usefulVertices + od[q + 3];
          if (nextMax * (members + 1) > nextUseful * 1.5) break;
          const nextRaw = rawWork + ow[next * 2],
            nextWork = nextRaw + nextMax * (members + 1) - nextUseful;
          if (work + nextWork > budget.work) break;
          vertexCount = nextMax;
          usefulVertices = nextUseful;
          rawWork = nextRaw;
          addWork = nextWork;
          members++;
        }
      }
      if (draws + addDraws > drawLimit) break;
      if (
        chosenCount &&
        (work + addWork > budget.work ||
          (countBudget
            ? (draws + addDraws) * msPerDraw >= cpuTarget
            : clock() + (draws + addDraws) * msPerDraw * 0.65 >= cpuEnd))
      )
        break;
      if (kind === 3) {
        const bindingBefore = result.bindingCPUms,
          createsBefore = result.bindingCreates;
        bind(job, job.stages[nd[od[k + 5] * 8]].image, result);
        if (countBudget && result.bindingCreates > createsBefore && result.bindingCPUms - bindingBefore >= cpuTarget) {
          if (chosenCount) {
            stage.nodeIndex = selectionScratch[0];
            stage.opIndex = selectionScratch[1];
          }
          const end = clock();
          result.selectionCPUms += Math.max(0, end - renderStart - (result.bindingCPUms - bindingBeforeSelection));
          result.renderCPUms += end - renderStart;
          return;
        }
      }
      const sk = chosenCount * 8;
      selectionScratch[sk] = stage.nodeIndex;
      selectionScratch[sk + 1] = stage.opIndex;
      selectionScratch[sk + 2] = addDraws;
      selectionScratch[sk + 3] = members;
      selectionScratch[sk + 4] = vertexCount;
      selectionScratch[sk + 5] = usefulVertices;
      selectionScratch[sk + 6] = index;
      selectionScratch[sk + 7] = node;
      selectionWork[chosenCount] = addWork;
      chosenCount++;
      draws += addDraws;
      work += addWork;
      stage.opIndex += members;
    }
    const plannedComplete = stage.nodeIndex === stage.nodeCount;
    const selectionEnd = clock();
    result.selectionCPUms += Math.max(0, selectionEnd - renderStart - (result.bindingCPUms - bindingBeforeSelection));
    if ((!chosenCount && !plannedComplete) || (!countBudget && deadline - selectionEnd < 0.025)) {
      if (chosenCount) {
        stage.nodeIndex = selectionScratch[0];
        stage.opIndex = selectionScratch[1];
      }
      result.renderCPUms += selectionEnd - renderStart;
      return;
    }
    const encodeStart = clock(),
      finalSlice = antialias && plannedComplete;
    const gpuPassLabel = 'tile ' + stage.kind + ' slice';
    const pass = encoder.beginRenderPass({
      label: gpuPassLabel,
      ...(budget.timestampWrites ? { timestampWrites: budget.timestampWrites } : {}),
      colorAttachments: [
        {
          view: antialias ? stage.sampleView : stage.imageView,
          ...(antialias ? { resolveTarget: plannedComplete ? stage.imageView : undefined } : {}),
          loadOp: stage.started ? 'load' : 'clear',
          storeOp: finalSlice ? 'discard' : 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
      depthStencilAttachment: {
        view: stage.stencilView,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
        stencilClearValue: 0,
      },
    });
    const scaledRoot = stage === job.tileStage && job.raster.scale < 1;
    const scaledCapsule = scaledRoot && coverageRasterScaling;
    if (scaledRoot) {
      const v = job.raster.viewport;
      pass.setViewport(v.x, v.y, v.width, v.height, 0, 1);
    }
    pass.setStencilReference(0);
    if (!gpuPreparation || job.stats.fallbackPaths) pass.setVertexBuffer(0, job.vertexBuffer);
    let previousNode = -1,
      previousBindingImage,
      previousPipeline = null,
      encodedDraws = 0,
      encodedWork = 0;
    const setPipeline = pipeline => {
      if (pipeline !== previousPipeline) {
        pass.setPipeline(pipeline);
        previousPipeline = pipeline;
        result.pipelineChanges++;
      }
    };
    for (let chosenIndex = 0; chosenIndex < chosenCount; chosenIndex++) {
      const sk = chosenIndex * 8,
        itemDraws = selectionScratch[sk + 2],
        members = selectionScratch[sk + 3],
        vertexCount = selectionScratch[sk + 4],
        usefulVertices = selectionScratch[sk + 5];
      if (!countBudget && !finalSlice && encodedDraws && clock() + itemDraws * msPerDraw * 0.65 >= cpuEnd) {
        stage.nodeIndex = selectionScratch[sk];
        stage.opIndex = selectionScratch[sk + 1];
        break;
      }
      const index = selectionScratch[sk + 6],
        k = index * 12,
        node = selectionScratch[sk + 7],
        nk = node * 8,
        kind = od[k],
        flags = od[k + 1],
        gpuIndex = od[k + 6];
      if (node !== previousNode) {
        if (scaledRoot) pass.setScissorRect(0, 0, job.raster.stageWidth, job.raster.stageHeight);
        else pass.setScissorRect(nd[nk + 1], nd[nk + 2], nd[nk + 3], nd[nk + 4]);
        previousNode = node;
      }
      if (kind === 5) {
        setPipeline(pipelines.stamp);
        pass.setBindGroup(0, job.stampBinding);
        result.bindingChanges++;
        pass.draw(6, od[k + 3], 0, od[k + 2]);
        previousBindingImage = undefined;
        result.stampDraws++;
        result.stampDrawInstances += od[k + 3];
        metadata.stampDraws++;
        metadata.stampDrawInstances += od[k + 3];
      } else {
        const bindingImage = kind === 3 ? job.stages[nd[od[k + 5] * 8]].image : dummy;
        if (bindingImage !== previousBindingImage) {
          pass.setBindGroup(0, job.bindings.get(bindingImage));
          previousBindingImage = bindingImage;
          result.bindingChanges++;
        }
        if (gpuIndex !== 0xffffffff) {
          const offset = gpuIndex * 32;
          if (kind === 1) {
            if (flags & 2) {
              setPipeline(pipelines.computedDirect);
              pass.drawIndirect(job.indirectBuffer, offset);
              metadata.directConvexPaths += members;
            } else {
              setPipeline(pipelines.computedStencil);
              pass.drawIndirect(job.indirectBuffer, offset);
              setPipeline(pipelines.preparedPaint);
              pass.drawIndirect(job.indirectBuffer, offset + 16);
            }
            result.parametricDraws += itemDraws;
            metadata.parametricDraws += itemDraws;
          } else if (kind === 2) {
            setPipeline(scaledCapsule ? pipelines.preparedScaledCapsule : pipelines.preparedCapsule);
            pass.drawIndirect(job.indirectBuffer, offset);
            metadata.analyticStrokePaths += members;
            result.analyticStrokePaths += members;
            for (let j = 0; j < members; j++)
              metadata.analyticSegments += od[rows[nd[nk + 5] + selectionScratch[sk + 1] + j] * 12 + 3];
          } else {
            setPipeline(pipelines.preparedGroup);
            pass.drawIndirect(job.indirectBuffer, offset);
          }
          result.indirectDraws += itemDraws;
          metadata.indirectDraws += itemDraws;
          if (members > 1) {
            result.preparedBatches++;
            result.preparedBatchPaths += members;
            metadata.preparedBatches++;
            metadata.preparedBatchPaths += members;
          }
        } else if (kind === 1) {
          if (members > 1) {
            setPipeline(pipelines.instanced);
            pass.draw(vertexCount, members, 0, index);
            metadata.instancedDraws++;
            metadata.instancedPaths += members;
            metadata.instancedVertexInvocations += vertexCount * members;
            metadata.instancedUsefulVertices += usefulVertices;
            result.instancedDraws++;
            result.instancedPaths += members;
            result.instancedVertexInvocations += vertexCount * members;
            metadata.directConvexPaths += members;
          } else if (flags & 2) {
            setPipeline(pipelines.direct);
            pass.draw(od[k + 3], 1, od[k + 2], index);
            metadata.directConvexPaths++;
          } else {
            setPipeline(pipelines.stencil);
            pass.draw(od[k + 3], 1, od[k + 2], index);
            setPipeline(pipelines.paint);
            pass.draw(6, 1, 0, index);
          }
          result.fallbackDraws += itemDraws;
          metadata.fallbackDraws += itemDraws;
          metadata.fallbackPaths += members;
        } else if (kind === 2) {
          setPipeline(scaledCapsule ? pipelines.scaledCapsule : pipelines.capsule);
          pass.draw(6, 1, 0, index);
          metadata.analyticStrokePaths++;
          metadata.analyticSegments += od[k + 3];
          result.analyticStrokePaths++;
        } else {
          setPipeline(pipelines.group);
          pass.draw(6, 1, 0, index);
        }
      }
      encodedDraws += itemDraws;
      encodedWork += selectionWork[chosenIndex];
    }
    pass.end();
    needsSubmission = true;
    stage.started = true;
    result.draws += encodedDraws;
    result.work += encodedWork;
    result.passes++;
    result.encoded = true;
    result.timestampEncoded = true;
    result.gpuPassLabel = gpuPassLabel;
    const end = clock(),
      elapsed = end - renderStart;
    result.estimatedRenderCPUms = countBudget ? encodedDraws * msPerDraw : null;
    result.encodeCPUms += end - encodeStart;
    result.drawCommandCPUms += end - encodeStart;
    result.renderCPUms += elapsed;
    metadata.lastRenderCPUms = elapsed;
    metadata.maxRenderCPUms = Math.max(metadata.maxRenderCPUms, elapsed);
    if (budget.opening) metadata.openingCPUBudgetSamplesIgnored++;
    else learnCPU(encodedDraws, elapsed, drawLimit);
    const complete = stage.nodeIndex === stage.nodeCount;
    if (complete) {
      later(stage.samples);
      later(stage.stencil);
      job.stageIndex++;
      if (stage.kind === 'tile') {
        for (const page of job.stages) if (page !== stage) later(page.image);
        if (job.vertexBuffer !== dummyPoints) later(job.vertexBuffer);
        later(job.paintBuffer);
        later(job.recordBuffer);
        later(job.stampBuffer);
        if (coverageRasterScaling) later(job.rasterCoverageUniform);
        if (job.gpuPreparation)
          for (const key of [
            'prepareBuffer',
            'segmentBuffer',
            'transformBuffer',
            'taskBuffer',
            'preparedBuffer',
            'indirectBuffer',
            'visibleBuffer',
            'computeUniform',
          ])
            later(job[key]);
        job.bindings?.clear();
        job.stampBinding = null;
        job.recordData = null;
        job.uploads = [];
        job.phase = 'post';
      }
    }
  }
  function preparePost(job, result) {
    const begin = clock(),
      bindingBefore = result.bindingCPUms;
    const { sigma } = job.settings,
      { outputWidth: width, outputHeight: height, stageWidth: W, stageHeight: H, padX, padY, sx, sy } = job.raster;
    if (!job.output) {
      job.output = own(job, texture('tile complete flipped output', width, height, 'outputBytes'));
      textureView(job.output);
    } else if (sigma > 0.01 && !job.blur) {
      job.blur = own(job, texture('tile horizontal Gaussian', W, H));
      textureView(job.blur);
    } else {
      if (!job.posts) {
        const make = (input, output, w, h, finalPass) => {
          const parameters = new Float32Array([
            W,
            H,
            w,
            h,
            padX,
            sigma * (finalPass ? sy : sx),
            finalPass ? 1 : 0,
            padY,
          ]);
          return {
            input,
            output,
            outputView: textureView(output),
            width: w,
            height: h,
            sigma: parameters[5],
            parameters,
            started: false,
            uploaded: false,
            row: 0,
          };
        };
        job.posts =
          sigma > 0.01
            ? [make(job.tileStage.image, job.blur, W, H, false), make(job.blur, job.output, width, height, true)]
            : [make(job.tileStage.image, job.output, width, height, true)];
        job.postIndex = 0;
        job.postPrepareIndex = 0;
      }
      const post = job.posts[job.postPrepareIndex];
      if (!post.uniform) post.uniform = own(job, buffer('tile Gaussian parameters', 32, BU.UNIFORM | BU.COPY_DST));
      else {
        const members = [post.uniform, post.input];
        post.group = cachedBinding(
          'post:' + members.map(r => resources.get(r).id).join(':'),
          members,
          () => ({
            label: 'tile Gaussian input',
            layout: pipelines.post.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: post.uniform } },
              { binding: 1, resource: textureView(post.input) },
            ],
          }),
          result,
        );
        if (++job.postPrepareIndex === job.posts.length) job.postPrepared = true;
      }
    }
    noteAllocation(result, 'post', Math.max(0, clock() - begin - (result.bindingCPUms - bindingBefore)));
  }
  function noteUpload(result, bytes, cpuMs) {
    result.uploadCPUms += cpuMs;
    result.uploadWrites++;
    result.maxSingleUploadBytes = Math.max(result.maxSingleUploadBytes, bytes);
    result.maxSingleUploadCPUms = Math.max(result.maxSingleUploadCPUms, cpuMs);
  }
  function postSlice(job, encoder, budget, result, deadline) {
    if (budget.explicitDrawLimit < 1) return;
    while (!job.postPrepared && clock() < deadline) preparePost(job, result);
    if (!job.postPrepared || deadline - clock() < 0.025) return;
    const post = job.posts[job.postIndex],
      taps = post.sigma > 0.01 ? Math.ceil(Math.fround(3 * post.sigma)) * 2 + 1 : 1;
    if (!post.uploaded) {
      if (budget.uploadBytes - result.uploadedBytes < post.parameters.byteLength) return;
      const uploadStart = clock();
      device.queue.writeBuffer(post.uniform, 0, post.parameters);
      noteUpload(result, post.parameters.byteLength, clock() - uploadStart);
      result.uploadedBytes += post.parameters.byteLength;
      post.uploaded = true;
    }
    const encodeStart = clock();
    const rows = Math.min(
      post.height - post.row,
      Math.max(1, Math.floor(budget.postWork / Math.max(1, post.width * taps * 0.1))),
    );
    const gpuPassLabel = 'tile Gaussian/crop rows';
    const pass = encoder.beginRenderPass({
      label: gpuPassLabel,
      ...(budget.timestampWrites ? { timestampWrites: budget.timestampWrites } : {}),
      colorAttachments: [
        { view: post.outputView, loadOp: post.started ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipelines.post);
    pass.setBindGroup(0, post.group);
    pass.setScissorRect(0, post.row, post.width, rows);
    pass.draw(3);
    pass.end();
    const encodeCPUms = clock() - encodeStart;
    result.encodeCPUms += encodeCPUms;
    result.postCommandCPUms += encodeCPUms;
    needsSubmission = true;
    post.started = true;
    post.row += rows;
    result.draws++;
    result.passes++;
    result.encoded = true;
    result.timestampEncoded = true;
    result.gpuPassLabel = gpuPassLabel;
    result.work += rows * post.width * taps * 0.1;
    if (post.row === post.height) {
      later(post.uniform);
      later(post.input);
      job.postIndex++;
      if (job.postIndex === job.posts.length) {
        job.phase = 'done';
        metadata.jobsCompleted++;
      }
    }
  }
  function step(encoder, config = {}) {
    if (disposed) throw Error('Tile renderer disposed');
    if (needsSubmission) throw Error('Tile submitted() is required after submitting the previous slice');
    if (!active)
      return {
        done: false,
        idle: true,
        texture: null,
        width: 0,
        height: 0,
        uploadedBytes: 0,
        draws: 0,
        cpuMs: 0,
        encoded: false,
        gpuPassLabel: null,
      };
    const job = active,
      begin = clock(),
      opening = config.opening === true;
    const cpuBudget = opening ? Infinity : Math.max(0.05, config.maxCPUms ?? 0.65);
    const startCPUms = job.pendingStartCPUms || 0;
    job.pendingStartCPUms = 0;
    const deadline = opening
      ? Infinity
      : Math.min(
          begin + Math.max(0, cpuBudget - startCPUms),
          Number.isFinite(config.frameDeadline) ? config.frameDeadline : Infinity,
        );
    const maxUpload = opening
      ? Infinity
      : Math.max(0, Math.min(786432, Math.floor((config.maxUploadBytes ?? 786432) / 4) * 4));
    metadata.openingUnbounded = opening;
    metadata.budgetMode = opening ? 'opening-unbounded' : 'play';
    metadata.lastBudget = {
      opening,
      cpuLimited: !opening,
      estimatedGPULimited: !opening,
      uploadTotalLimited: !opening,
      ...(opening
        ? {}
        : { cpuLimitMs: cpuBudget, estimatedGPULimitMs: config.maxGPUms ?? 3, maxUploadBytes: maxUpload }),
      maxSingleUploadBytes: 262144,
      computeDispatchLimit: opening ? deviceComputeGroups : computeMaxGroups,
    };
    const budget = {
      opening,
      explicitDrawLimit: config.maxDraws === undefined ? Infinity : Math.max(0, Math.floor(config.maxDraws)),
      renderCPUms: opening ? Infinity : Math.min(config.maxRenderCPUms ?? 0.6, cpuBudget * 0.85),
      gpuTargetMs: opening ? Infinity : (config.maxGPUms ?? 3),
      work: opening ? Infinity : gpuWorkBudget('render', config.maxGPUms ?? 3),
      postWork: opening ? Infinity : gpuWorkBudget('post', config.maxGPUms ?? 3),
      timestampWrites: config.timestampWrites,
      uploadBytes: maxUpload,
    };
    const result = {
      id: job.id,
      openingBudget: opening,
      budgetMode: metadata.budgetMode,
      done: false,
      texture: null,
      uploadedBytes: 0,
      vertexUploadBytes: 0,
      draws: 0,
      passes: 0,
      work: 0,
      cpuMs: 0,
      startCPUms,
      selectionCPUms: 0,
      encodeCPUms: 0,
      renderCPUms: 0,
      allocationCPUms: 0,
      uploadCPUms: 0,
      mainPreprocessCPUms: 0,
      currentDrawLimit: 0,
      renderCPUTargetMs: 0,
      inputAllocationCPUms: 0,
      stageAllocationCPUms: 0,
      postAllocationCPUms: 0,
      bindingCPUms: 0,
      computePrepareCPUms: 0,
      drawCommandCPUms: 0,
      computeCommandCPUms: 0,
      postCommandCPUms: 0,
      allocationOperations: 0,
      maxAllocationOperationCPUms: 0,
      maxBindingOperationCPUms: 0,
      bindingCreates: 0,
      bindingReuses: 0,
      bindingChanges: 0,
      pipelineChanges: 0,
      instancedDraws: 0,
      instancedPaths: 0,
      instancedVertexInvocations: 0,
      analyticStrokePaths: 0,
      stampDraws: 0,
      stampDrawInstances: 0,
      computePasses: 0,
      computedVertices: 0,
      visibilityCandidates: 0,
      indirectDraws: 0,
      preparedBatches: 0,
      preparedBatchPaths: 0,
      fallbackDraws: 0,
      parametricDraws: 0,
      copiedVertices: 0,
      copyDispatches: 0,
      uploadWrites: 0,
      maxSingleUploadBytes: 0,
      maxSingleUploadCPUms: 0,
      encoded: false,
      hasCommands: false,
      timestampEncoded: false,
      gpuWorkKind: 'render',
      gpuPassLabel: null,
    };
    try {
      let preprocessBegin = null;
      while (['walk', 'pack', 'records', 'geometry', 'allocate', 'upload'].includes(job.phase) && clock() < deadline) {
        if (job.preprocessor) {
          if (preprocessBegin === null) preprocessBegin = clock();
          if (job.preprocessor.stepOne()) {
            result.mainPreprocessCPUms += clock() - preprocessBegin;
            preprocessBegin = null;
            const readyPlan = job.preprocessor.result();
            job.preprocessor = null;
            job.walk = [];
            job.levels = [];
            adoptIndexedPlan(job, readyPlan);
            job.phase = 'allocate';
          }
          job.stats.preprocessIterations = job.iterations;
        } else if (job.phase === 'allocate') allocateInputs(job, result);
        else {
          const upload = job.uploads[job.uploadIndex];
          if (!upload) {
            job.phase = job.gpuPreparation ? 'compute' : 'render';
            break;
          }
          if (upload.offset === upload.data.byteLength) {
            job.uploadIndex++;
            continue;
          }
          const bytes = Math.min(upload.data.byteLength - upload.offset, maxUpload - result.uploadedBytes, 262144);
          if (bytes < 4) break;
          const uploadStart = clock();
          device.queue.writeBuffer(
            upload.buffer,
            upload.offset,
            upload.data.buffer,
            upload.data.byteOffset + upload.offset,
            bytes,
          );
          noteUpload(result, bytes, clock() - uploadStart);
          upload.offset += bytes;
          result.uploadedBytes += bytes;
          if (upload.buffer === job.vertexBuffer) result.vertexUploadBytes += bytes;
        }
      }
      if (preprocessBegin !== null) result.mainPreprocessCPUms += clock() - preprocessBegin;
      if (job.phase === 'compute' && clock() < deadline) {
        computeSlice(job, encoder, budget, result, deadline);
        if (!result.encoded && job.phase === 'render' && clock() < deadline)
          renderSlice(job, encoder, budget, result, deadline);
      } else if (job.phase === 'render' && clock() < deadline) renderSlice(job, encoder, budget, result, deadline);
      else if (job.phase === 'post' && clock() < deadline) postSlice(job, encoder, budget, result, deadline);
      result.done = job.phase === 'done';
      result.texture = result.done ? job.output : null;
      result.phase = job.phase;
      result.width = job.raster.outputWidth;
      result.height = job.raster.outputHeight;
      result.rasterScale = job.raster.scale;
      result.logicalWidth = job.settings.width;
      result.logicalHeight = job.settings.height;
      result.cpuMs = clock() - begin;
      result.cpuBreakdown = {
        startCPUms,
        inputAllocationCPUms: result.inputAllocationCPUms,
        stageAllocationCPUms: result.stageAllocationCPUms,
        postAllocationCPUms: result.postAllocationCPUms,
        bindingCPUms: result.bindingCPUms,
        computePrepareCPUms: result.computePrepareCPUms,
        selectionCPUms: result.selectionCPUms,
        drawCommandCPUms: result.drawCommandCPUms,
        computeCommandCPUms: result.computeCommandCPUms,
        postCommandCPUms: result.postCommandCPUms,
        uploadCPUms: result.uploadCPUms,
        mainPreprocessCPUms: result.mainPreprocessCPUms,
      };
      result.cpuBreakdown.otherCPUms = Math.max(
        0,
        result.cpuMs -
          result.allocationCPUms -
          result.bindingCPUms -
          result.computePrepareCPUms -
          result.selectionCPUms -
          result.encodeCPUms -
          result.uploadCPUms -
          result.mainPreprocessCPUms,
      );
      result.uploads = result.uploadedBytes;
      result.estimatedGPUms = result.computePasses
        ? result.work * computeCosts[result.gpuWorkKind.slice(8)]
        : result.passes
          ? gpuCost[gpuPassKind(result.gpuPassLabel)].fixed * result.passes +
            gpuCost[gpuPassKind(result.gpuPassLabel)].rate * result.work
          : 0;
      result.hasCommands = result.encoded;
      job.stats.uploadedBytes += result.uploadedBytes;
      job.stats.draws += result.draws;
      job.stats.passes += result.passes;
      job.stats.cpuMs += result.cpuMs;
      job.stats.uploadWrites += result.uploadWrites;
      job.stats.maxSingleUploadBytes = Math.max(job.stats.maxSingleUploadBytes, result.maxSingleUploadBytes);
      job.stats.maxSingleUploadCPUms = Math.max(job.stats.maxSingleUploadCPUms, result.maxSingleUploadCPUms);
      job.stats.mainPreprocessCPUms += result.mainPreprocessCPUms;
      metadata.mainPreprocessCPUms += result.mainPreprocessCPUms;
      job.stats.renderCPUms += result.renderCPUms;
      job.stats.allocationCPUms += result.allocationCPUms;
      job.stats.uploadCPUms += result.uploadCPUms;
      job.stats.steps++;
      for (const key of [
        'inputAllocationCPUms',
        'stageAllocationCPUms',
        'postAllocationCPUms',
        'bindingCPUms',
        'computePrepareCPUms',
        'selectionCPUms',
        'drawCommandCPUms',
        'computeCommandCPUms',
        'postCommandCPUms',
        'allocationOperations',
        'bindingChanges',
        'pipelineChanges',
      ])
        job.stats[key] += result[key];
      job.stats.maxAllocationOperationCPUms = Math.max(
        job.stats.maxAllocationOperationCPUms,
        result.maxAllocationOperationCPUms,
      );
      job.stats.maxBindingOperationCPUms = Math.max(
        job.stats.maxBindingOperationCPUms,
        result.maxBindingOperationCPUms,
      );
      job.stats.computePasses += result.computePasses;
      job.stats.computedVertices += result.computedVertices;
      job.stats.visibilityCandidates += result.visibilityCandidates;
      job.stats.indirectDraws += result.indirectDraws;
      job.stats.fallbackDraws += result.fallbackDraws;
      job.stats.parametricDraws += result.parametricDraws;
      job.stats.stampDraws += result.stampDraws;
      job.stats.stampDrawInstances += result.stampDrawInstances;
      metadata.lastAllocationCPUms = result.allocationCPUms;
      metadata.lastUploadCPUms = result.uploadCPUms;
      metadata.lastCPUBreakdown = result.cpuBreakdown;
      metadata.maxAllocationOperationCPUms = Math.max(
        metadata.maxAllocationOperationCPUms,
        result.maxAllocationOperationCPUms,
      );
      metadata.maxBindingOperationCPUms = Math.max(metadata.maxBindingOperationCPUms, result.maxBindingOperationCPUms);
      metadata.allocationOperations += result.allocationOperations;
      metadata.bindingChanges += result.bindingChanges;
      metadata.pipelineChanges += result.pipelineChanges;
      metadata.steps++;
      metadata.uploadedBytes += result.uploadedBytes;
      finishStats(job);
      options.onStats?.(result, metadata);
      return result;
    } catch (e) {
      job.phase = 'failed';
      finishStats(job);
      options.onError?.(e);
      throw e;
    }
  }
  function submitted() {
    needsSubmission = false;
    while (retired.length) retire(retired.pop());
  }
  function feedback(sample) {
    if (sample.opening === true || sample.openingBudget === true) {
      metadata.openingGPUBudgetSamplesIgnored++;
      return;
    }
    const gpuMs = Number(sample.gpuMs),
      work = Number(sample.work);
    if (!(gpuMs > 0 && Number.isFinite(gpuMs) && work > 0 && Number.isFinite(work))) return;
    const measured = gpuMs / work;
    if (sample.compute === true || String(sample.gpuWorkKind || '').startsWith('compute-')) {
      const mode = String(sample.gpuWorkKind || '').slice(8),
        vertices = Number(sample.computedVertices ?? sample.vertices ?? 0);
      if (!['copy', 'expand'].includes(mode) || !(vertices >= 4096 && Number.isFinite(vertices))) {
        metadata.ignoredComputeBudgetSamples++;
        return;
      }
      const perVertex = gpuMs / vertices,
        previous = computeCosts[mode];
      computeCosts[mode] = perVertex > previous ? perVertex : previous * 0.8 + perVertex * 0.2;
      metadata.gpuMsPerComputeWorkByMode[mode] = computeCosts[mode];
      metadata.computeBudgetSamples++;
      metadata.gpuMsPerComputeWork = computeCosts.expand;
    } else {
      fitGPUCost(
        sample.pass !== undefined ? gpuPassKind(sample.pass) : sample.phase === 'post' ? 'post' : 'render',
        work,
        gpuMs,
      );
      metadata.gpuMsPerWork = gpuCost.render.rate;
      metadata.gpuPassCost = {
        renderFixedMs: gpuCost.render.fixed,
        renderRate: gpuCost.render.rate,
        postFixedMs: gpuCost.post.fixed,
        postRate: gpuCost.post.rate,
      };
    }
    if (active && sample.id === active.id) active.stats.gpuFeedbackSamples++;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
    for (const resource of [...resources.keys()]) release(resource);
  }
  function retireCPUViews() {
    if (!active || active.phase !== 'done') return;
    for (const key of [
      'packet',
      'plan',
      'preprocessor',
      'recordData',
      'opData',
      'opWork',
      'nodeData',
      'nodeGeo',
      'nodeOps',
      'stageData',
      'stageNodes',
      'prepareData',
      'taskData',
      'segmentOwners',
      'segments',
      'transforms',
    ])
      active[key] = null;
    active.uploads = [];
  }
  return {
    start,
    step,
    submitted,
    feedback,
    cancel,
    dispose,
    retireCPUViews,
    metadata,
    preprocessConfig,
    get byteCount() {
      return metadata.byteCount;
    },
    get active() {
      return active;
    },
    get ready() {
      return !disposed;
    },
  };
}
