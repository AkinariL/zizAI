function startupPaperPacket() {
  const native = getCPUUtilsRuntime('startup');
  if (!native) throw Error('Native startup assets unavailable');
  return {
    ...native.paper(),
    cpuPrecision: 'float32',
    wasmCopyBytes: 0,
    wasmCopyMs: 0,
    nativeEnvironment: native.environment,
  };
}
function startupUIGrainPacket() {
  const native = getCPUUtilsRuntime('startup');
  if (!native) throw Error('Native startup assets unavailable');
  return {
    ...native.grain(),
    cpuPrecision: 'float32',
    wasmCopyBytes: 0,
    wasmCopyMs: 0,
    nativeEnvironment: native.environment,
  };
}

function createStartupPreparation() {
  const metadata = {
    backend: 'cpu-main',
    tasks: 0,
    workerTasks: 0,
    fallbackTasks: 0,
    workerCPUms: 0,
    mainCPUms: 0,
    transferredBytes: 0,
    pending: 0,
    peakPending: 0,
    warnings: [],
    fontSheets: 0,
    fontFaces: 0,
    closed: false,
  };
  if (typeof nativeTransportStats === 'function') {
    metadata.transport = nativeTransportStats();
    metadata.environment = nativeSharedEnvironment(
      typeof CPU_UTILS_SHARED_WASM_BYTES === 'undefined' ? null : CPU_UTILS_SHARED_WASM_BYTES,
    );
    inspectNativeResponseHeaders(metadata.environment);
  }
  const sheets = new Map();
  let chain = Promise.resolve(),
    disposed = false;
  function run(prepare) {
    const execute = () => {
      if (disposed) throw Error('Startup CPU preparation disposed');
      metadata.tasks++;
      const start = performance.now(),
        packet = prepare();
      metadata.fallbackTasks++;
      metadata.mainCPUms += performance.now() - start;
      return packet;
    };
    const result = chain.then(execute);
    chain = result.catch(() => {});
    return result;
  }
  function recordFontFaces(key, faces) {
    if (disposed || sheets.has(key)) return;
    sheets.set(key, Promise.resolve(faces));
    metadata.fontSheets++;
    metadata.embeddedFontFaces = (metadata.embeddedFontFaces || 0) + faces.length;
    metadata.embeddedFontBytes =
      (metadata.embeddedFontBytes || 0) +
      [...new Set(faces.map(face => face.bytes).filter(Boolean))].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }
  return {
    metadata,
    paper: () => run(startupPaperPacket),
    uiGrain: () => run(() => startupUIGrainPacket({ rng, rr, periodicNoise })),
    recordFontFaces,
    async fontManifest() {
      const all = (await Promise.all([...sheets.values()])).flat();
      metadata.fontFaces = all.length;
      return all;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      metadata.closed = true;
      metadata.pending = 0;
    },
  };
}
const GPU_STARTUP = createStartupPreparation();
