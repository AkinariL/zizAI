function nativeDataClock() {
  return typeof performance === 'object' ? (performance.timeOrigin || 0) + performance.now() : Date.now();
}
function nativeRuntimeAssetValid(asset) {
  if (!asset || typeof WebAssembly !== 'object') return false;
  try {
    if (asset instanceof WebAssembly.Module) return true;
    if (typeof isSiteNativeAsset === 'function' && isSiteNativeAsset(asset)) return true;
    return (asset instanceof ArrayBuffer || ArrayBuffer.isView(asset)) && WebAssembly.validate(asset);
  } catch {
    return false;
  }
}
function nativeSharedEnvironment(sharedBytes, disabled = false) {
  const secureContext = globalThis.isSecureContext === true,
    isolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof SharedArrayBuffer === 'function',
    reasons = [];
  if (disabled) reasons.push('disabled_by_option');
  if (!secureContext) reasons.push('insecure_context');
  if (!isolated) reasons.push('not_cross_origin_isolated');
  if (!sharedArrayBuffer) reasons.push('shared_array_buffer_unavailable');
  if (!sharedBytes) reasons.push('shared_wasm_not_embedded');
  else if (!nativeRuntimeAssetValid(sharedBytes)) reasons.push('shared_wasm_validation_failed');
  let topLevel = null;
  try {
    if (typeof window === 'object') topLevel = window === window.top;
  } catch {}
  return {
    secureContext,
    crossOriginIsolated: isolated,
    sharedArrayBuffer,
    topLevel,
    protocol: globalThis.location?.protocol || null,
    eligible: reasons.length === 0,
    selected: 'not_instantiated',
    reasons,
    headerRequirement: 'COOP: same-origin; COEP: require-corp or credentialless; embedding must also permit isolation',
  };
}
function nativeRuntimeFailure(message, environment, cause = message) {
  const error =
    typeof siteResourceFailure === 'function'
      ? siteResourceFailure(message, cause)
      : Error(message + ': ' + String(cause?.message || cause));
  error.environment = environment;
  return error;
}
function nativeRuntimeAssetInstance(asset, variant) {
  let instance;
  if (typeof isSiteNativeAsset === 'function' && isSiteNativeAsset(asset)) {
    if (asset.variant !== variant) throw Error('Native asset descriptor has the wrong variant');
    instance = takeSiteNativeInstance(asset);
  } else
    instance = new WebAssembly.Instance(
      asset instanceof WebAssembly.Module ? asset : new WebAssembly.Module(asset),
      {},
    );
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw Error('Native asset has no exported memory');
  const shared = typeof SharedArrayBuffer === 'function' && memory.buffer instanceof SharedArrayBuffer;
  if (shared !== (variant === 'shared')) throw Error('Native asset memory differs from the selected variant');
  return instance;
}
function instantiateNativeRuntime(ordinaryBytes, sharedBytes, disabled = false) {
  const environment = nativeSharedEnvironment(sharedBytes, disabled);
  const variant = sharedBytes && !disabled ? 'shared' : 'ordinary';
  const asset = variant === 'shared' ? sharedBytes : ordinaryBytes;
  if (variant === 'shared' && !environment.eligible)
    throw nativeRuntimeFailure(
      'Shared WebAssembly environment is unavailable',
      environment,
      environment.reasons.join(', '),
    );
  if (!nativeRuntimeAssetValid(asset))
    throw nativeRuntimeFailure('Native WebAssembly asset is missing or invalid', environment);
  let api;
  try {
    api = nativeRuntimeAssetInstance(asset, variant).exports;
  } catch (error) {
    throw nativeRuntimeFailure('Native WebAssembly instantiation failed', environment, error);
  }
  environment.selected = variant;
  return { api, memory: api.memory, environment, shared: variant === 'shared' };
}
async function inspectNativeResponseHeaders(environment) {
  if (
    typeof document !== 'object' ||
    typeof fetch !== 'function' ||
    !/^https?:$/.test(globalThis.location?.protocol || '')
  )
    return;
  try {
    const response = await fetch(location.href.split('#')[0], {
      method: 'HEAD',
      cache: 'no-cache',
      credentials: 'same-origin',
    });
    environment.responseHeaders = {
      status: response.status,
      coop: response.headers.get('Cross-Origin-Opener-Policy'),
      coep: response.headers.get('Cross-Origin-Embedder-Policy'),
    };
    if (!environment.crossOriginIsolated && environment.responseHeaders.coop && environment.responseHeaders.coep)
      environment.isolationNote =
        'Response headers are present; check ancestor isolation and iframe permission policy.';
  } catch (error) {
    environment.responseHeaders = { unavailable: String(error.message || error) };
  }
}
function nativeTransportStats() {
  return {
    sharedPayloads: 0,
    fallbackPayloads: 0,
    sharedPayloadBytes: 0,
    bulkCrossThreadCopyBytes: 0,
    bulkCopyCPUms: 0,
    messageReceiveMs: 0,
    maxMessageReceiveMs: 0,
    descriptorCPUms: 0,
    publishSyncCPUms: 0,
    acquireSyncCPUms: 0,
    releaseSyncCPUms: 0,
    requestPostCPUms: 0,
    responsePostCPUms: 0,
    releasePostCPUms: 0,
    releaseMessageMs: 0,
    maxLeaseMs: 0,
    payloadMessages: 0,
    releaseMessages: 0,
    invalidReleases: 0,
    deferredResets: 0,
  };
}
function nativeArrayType(array) {
  if (array instanceof Float32Array) return 1;
  if (array instanceof Uint32Array) return 2;
  if (array instanceof Uint8ClampedArray) return 3;
  if (array instanceof Uint8Array) return 4;
  throw Error('Unsupported native data view');
}
function nativeArrayConstructor(type) {
  return type === 1
    ? Float32Array
    : type === 2
      ? Uint32Array
      : type === 3
        ? Uint8ClampedArray
        : type === 4
          ? Uint8Array
          : null;
}
function nativeDataFields(packet, topKeys, planKeys = []) {
  return [...topKeys.map(key => [packet, 0, key]), ...planKeys.map(key => [packet.preprocessed, 1, key])].filter(
    ([owner, , key]) => owner[key],
  );
}
function nativeDataSize(fields) {
  let usedBytes = 0,
    payloadBytes = 0;
  for (const [owner, , key] of fields) {
    usedBytes = Math.ceil(usedBytes / 16) * 16 + owner[key].byteLength;
    payloadBytes += owner[key].byteLength;
  }
  return { usedBytes, payloadBytes };
}
function serializeNativeData(packet, fields, options = {}) {
  const start = performance.now(),
    { usedBytes, payloadBytes } = nativeDataSize(fields);
  const source = fields[0]?.[0][fields[0][2]].buffer;
  const shared = typeof SharedArrayBuffer === 'function' && source instanceof SharedArrayBuffer;
  let buffer,
    token = options.token,
    copyCPUms = 0,
    copyBytes = 0,
    descriptors = [],
    signalOffset = null;
  if (shared) {
    buffer = source;
    for (const [owner, scope, key] of fields) {
      const array = owner[key];
      if (array.buffer !== buffer) throw Error('A native packet spans multiple shared heaps');
      descriptors.push([scope, key, nativeArrayType(array), array.byteOffset, array.length]);
      delete owner[key];
    }
    signalOffset = options.signalOffset;
    if (!Number.isInteger(signalOffset)) throw Error('Shared native result has no publication signal');
  } else {
    const loan = options.pool?.take(usedBytes);
    buffer = loan?.buffer || new ArrayBuffer(usedBytes);
    token = loan?.token ?? token;
    const bytes = new Uint8Array(buffer),
      copyStart = performance.now();
    let at = 0;
    for (const [owner, scope, key] of fields) {
      const array = owner[key];
      at = Math.ceil(at / 16) * 16;
      bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
      descriptors.push([scope, key, nativeArrayType(array), at, array.length]);
      at += array.byteLength;
      delete owner[key];
    }
    copyCPUms = performance.now() - copyStart;
    copyBytes = payloadBytes;
    if (options.pool) {
      const s = options.pool.stats;
      s.copies++;
      s.copyBytes += copyBytes;
      s.copyMs += copyCPUms;
      s.maxCopyMs = Math.max(s.maxCopyMs, copyCPUms);
    }
  }
  const readyWord = options.readyWord || 0,
    releaseWord = options.releaseWord ?? 1;
  let publishSyncCPUms = 0;
  if (shared) {
    const begin = performance.now(),
      signal = new Uint32Array(buffer, signalOffset, options.signalWords || 2);
    if (!options.immutable) Atomics.store(signal, releaseWord, 0);
    Atomics.store(signal, readyWord, token);
    publishSyncCPUms = performance.now() - begin;
  }
  packet.delivery = {
    buffer,
    fields: descriptors,
    token,
    shared,
    immutable: !!options.immutable,
    signalOffset,
    signalWords: options.signalWords || 2,
    readyWord,
    releaseWord,
    usedBytes,
    payloadBytes,
    capacityBytes: buffer.byteLength,
    bulkCrossThreadCopyBytes: copyBytes,
    copyMs: copyCPUms,
    descriptorCPUms: Math.max(0, performance.now() - start - copyCPUms - publishSyncCPUms),
    publishSyncCPUms,
    environment: options.environment || null,
    postedAt: nativeDataClock(),
  };
  return shared ? [] : [buffer];
}
function restoreNativeData(packet, stats = null) {
  if (!packet?.delivery) return;
  const d = packet.delivery,
    now = nativeDataClock(),
    start = performance.now();
  const shared = typeof SharedArrayBuffer === 'function' && d.buffer instanceof SharedArrayBuffer;
  if (shared !== d.shared) throw Error('Native backing-store type differs from its descriptor');
  let acquireSyncCPUms = 0;
  if (d.shared) {
    const begin = performance.now();
    d.signal = new Uint32Array(d.buffer, d.signalOffset, d.signalWords);
    if (Atomics.load(d.signal, d.readyWord) !== d.token) throw Error('Unpublished shared native result');
    acquireSyncCPUms = performance.now() - begin;
  }
  for (const [scope, key, type, offset, count] of d.fields) {
    const Type = nativeArrayConstructor(type),
      owner = scope === 0 ? packet : scope === 1 ? packet.preprocessed : null;
    if (
      !Type ||
      !owner ||
      !Number.isInteger(offset) ||
      !Number.isInteger(count) ||
      count < 0 ||
      offset < 0 ||
      offset % Type.BYTES_PER_ELEMENT ||
      offset + count * Type.BYTES_PER_ELEMENT > d.buffer.byteLength
    )
      throw Error('Invalid native result range');
    owner[key] = new Type(d.buffer, offset, count);
  }
  d.receivedAt = now;
  d.messageReceiveMs = Math.max(0, now - d.postedAt);
  d.acquireSyncCPUms = acquireSyncCPUms;
  d.descriptorCPUms += Math.max(0, performance.now() - start - acquireSyncCPUms);
  if (stats) {
    stats.payloadMessages++;
    stats[d.shared ? 'sharedPayloads' : 'fallbackPayloads']++;
    if (d.shared) stats.sharedPayloadBytes += d.payloadBytes;
    stats.bulkCrossThreadCopyBytes += d.bulkCrossThreadCopyBytes;
    stats.bulkCopyCPUms += d.copyMs;
    stats.messageReceiveMs += d.messageReceiveMs;
    stats.maxMessageReceiveMs = Math.max(stats.maxMessageReceiveMs, d.messageReceiveMs);
    stats.descriptorCPUms += d.descriptorCPUms;
    stats.publishSyncCPUms += d.publishSyncCPUms;
    stats.acquireSyncCPUms += acquireSyncCPUms;
    stats.lastEnvironment = d.environment;
  }
}
function ownNativeData(packet, worker, releaseMessage, stats = null) {
  restoreNativeData(packet, stats);
  if (!packet?.delivery || packet.delivery.immutable) return;
  let live = true;
  packet.releaseData = () => {
    if (!live) return;
    live = false;
    const d = packet.delivery,
      begin = performance.now();
    if (d.shared) Atomics.store(d.signal, d.releaseWord, d.token);
    const syncCPUms = performance.now() - begin,
      returnedAt = nativeDataClock();
    const message = { ...releaseMessage, token: d.token, buffer: d.shared ? null : d.buffer, returnedAt };
    const postStart = performance.now();
    try {
      worker.postMessage(message, d.shared ? [] : [d.buffer]);
    } catch (error) {
      if (stats) stats.releaseError = String(error.message || error);
    }
    if (stats) {
      stats.releaseMessages++;
      stats.releaseSyncCPUms += syncCPUms;
      stats.releasePostCPUms += performance.now() - postStart;
      stats.maxLeaseMs = Math.max(stats.maxLeaseMs, returnedAt - d.postedAt);
    }
  };
}
