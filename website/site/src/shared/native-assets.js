const siteNativeAssetLoads = new Map();
const siteNativeFirstInstances = new WeakMap();

function siteResourceFailure(resource, cause) {
  if (cause?.code === 'SITE_RESOURCE_LOAD_FAILED') return cause;
  const error = Error('Could not load ' + resource + ': ' + String(cause?.message || cause));
  error.name = 'SiteResourceError';
  error.code = 'SITE_RESOURCE_LOAD_FAILED';
  error.resource = resource;
  error.cause = cause;
  return error;
}

function siteAbsoluteAssetURL(value) {
  if (typeof value !== 'string' || !value) throw Error('Asset URL is missing');
  return new URL(value).href;
}

function decodeSiteBase64(value) {
  if (typeof value !== 'string' || !value) throw Error('Asset base64 is missing');
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function siteNativeByteSource(asset) {
  if (asset.bytes instanceof ArrayBuffer) return new Uint8Array(asset.bytes);
  if (ArrayBuffer.isView(asset.bytes))
    return new Uint8Array(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength);
  return null;
}

function isSiteNativeAsset(asset) {
  return (
    asset?.kind === 'site-native-asset' && typeof WebAssembly === 'object' && asset.module instanceof WebAssembly.Module
  );
}

function takeSiteNativeInstance(asset) {
  if (!isSiteNativeAsset(asset)) throw Error('Native WebAssembly asset was not preloaded');
  const first = siteNativeFirstInstances.get(asset);
  if (first) {
    siteNativeFirstInstances.delete(asset);
    return first;
  }
  return new WebAssembly.Instance(asset.module, {});
}

async function loadSiteNative(role) {
  let variant;
  try {
    if (role !== 'cpu' && role !== 'tile') throw Error('Unknown native asset role ' + role);
    const config = globalThis.SITE_CONFIG;
    if (config?.profile !== 'ordinary' && config?.profile !== 'shared')
      throw Error('SITE_CONFIG.profile must be ordinary or shared');
    const asset = config.assets?.wasm?.[role];
    if (!asset || typeof asset !== 'object') throw Error('Native asset configuration is missing');
    variant = asset.variant || (role === 'tile' ? config.profile : 'ordinary');
    if (variant !== 'ordinary' && variant !== 'shared') throw Error('Unknown native asset variant ' + variant);
    const bytes = siteNativeByteSource(asset);
    const hasURL = typeof asset.url === 'string',
      hasBase64 = typeof asset.base64 === 'string';
    if (Number(hasURL) + Number(hasBase64) + Number(!!bytes) !== 1)
      throw Error('Native asset needs exactly one URL, base64 or test BufferSource');
    const source = hasURL ? siteAbsoluteAssetURL(asset.url) : hasBase64 ? asset.base64 : asset.bytes;
    const cached = siteNativeAssetLoads.get(role);
    if (cached?.variant === variant && cached.source === source) return cached.promise;
    const promise = (async () => {
      if (typeof WebAssembly !== 'object') throw Error('WebAssembly is unavailable');
      let result;
      if (hasURL) {
        result = await WebAssembly.instantiateStreaming(
          fetch(source).then(response => {
            if (!response.ok) throw Error('WebAssembly asset HTTP ' + response.status);
            return response;
          }),
          {},
        );
      } else {
        result = await WebAssembly.instantiate(hasBase64 ? decodeSiteBase64(source) : bytes, {});
      }
      const memory = result.instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw Error('Native asset has no exported memory');
      const shared = typeof SharedArrayBuffer === 'function' && memory.buffer instanceof SharedArrayBuffer;
      if (shared !== (variant === 'shared')) throw Error('Native asset memory differs from its configured variant');
      const descriptor = Object.freeze({
        kind: 'site-native-asset',
        role,
        variant,
        module: result.module,
        source: hasURL ? 'url' : hasBase64 ? 'base64' : 'test-bytes',
        url: hasURL ? source : null,
      });
      siteNativeFirstInstances.set(descriptor, result.instance);
      return Object.freeze({
        ordinary: variant === 'ordinary' ? descriptor : null,
        shared: variant === 'shared' ? descriptor : null,
      });
    })().catch(error => {
      throw siteResourceFailure('WebAssembly ' + role + ' (' + variant + ')', error);
    });
    siteNativeAssetLoads.set(role, { source, variant, promise });
    return promise;
  } catch (error) {
    throw siteResourceFailure('WebAssembly ' + role + (variant ? ' (' + variant + ')' : ''), error);
  }
}

globalThis.loadSiteNative = loadSiteNative;
