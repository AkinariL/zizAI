const gpuSiteFontConfig = globalThis.SITE_CONFIG?.assets?.fonts;
const GPU_EMBEDDED_FONT_STATE = {
  backend: 'embedded-woff2',
  status: 'idle',
  families: [],
  resources: gpuSiteFontConfig?.resources?.length || 0,
  faces: gpuSiteFontConfig?.faces?.length || 0,
  bytes: (gpuSiteFontConfig?.resources || []).reduce(
    (sum, resource) => sum + (Number.isInteger(resource.bytes) ? resource.bytes : 0),
    0,
  ),
  loadedFaces: 0,
  errors: [],
  wallMs: 0,
};
let gpuEmbeddedFontPromise = null;

function siteFontResourceFailure(cause) {
  if (cause?.code === 'SITE_RESOURCE_LOAD_FAILED') return cause;
  const error = Error('Could not load WOFF2 fonts: ' + String(cause?.message || cause));
  error.name = 'SiteResourceError';
  error.code = 'SITE_RESOURCE_LOAD_FAILED';
  error.resource = 'WOFF2 fonts';
  error.cause = cause;
  return error;
}

function siteFontResourceURL(value) {
  if (typeof value !== 'string' || !value) throw Error('Font resource URL is missing');
  return new URL(value).href;
}

function decodeSiteFontBase64(value) {
  if (typeof value !== 'string' || !value) throw Error('Font resource base64 is missing');
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadSiteFontResource(resource, index) {
  const hasURL = typeof resource?.url === 'string',
    hasBase64 = typeof resource?.base64 === 'string';
  if (Number(hasURL) + Number(hasBase64) !== 1)
    throw Error('Font resource ' + index + ' needs exactly one URL or base64');
  let buffer;
  if (hasURL) {
    const response = await fetch(siteFontResourceURL(resource.url));
    if (!response.ok) throw Error('Font resource ' + index + ' HTTP ' + response.status);
    buffer = await response.arrayBuffer();
  } else buffer = decodeSiteFontBase64(resource.base64);
  if (!Number.isInteger(resource.bytes) || buffer.byteLength !== resource.bytes)
    throw Error('Font resource ' + index + ' byte count differs from its manifest');
  if (typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(resource.sha256))
    throw Error('Font resource ' + index + ' SHA-256 is missing');
  if (!globalThis.crypto?.subtle) throw Error('Font resource integrity checking is unavailable');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const sha256 = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
  if (sha256 !== resource.sha256.toLowerCase())
    throw Error('Font resource ' + index + ' SHA-256 differs from its manifest');
  return buffer;
}

function loadEmbeddedFonts() {
  if (gpuEmbeddedFontPromise) return gpuEmbeddedFontPromise;
  const start = performance.now();
  GPU_EMBEDDED_FONT_STATE.status = 'loading';
  if (typeof GPU_DIAG === 'object') GPU_DIAG.embeddedFonts = GPU_EMBEDDED_FONT_STATE;
  gpuEmbeddedFontPromise = (async () => {
    const bundle = globalThis.SITE_CONFIG?.assets?.fonts;
    if (!Array.isArray(bundle?.resources) || !Array.isArray(bundle?.faces) || !bundle.faces.length)
      throw Error('Font asset configuration is missing');
    const fontSet = typeof document === 'object' ? document.fonts : globalThis.fonts;
    if (!fontSet || typeof FontFace !== 'function') throw Error('FontFaceSet is unavailable in this thread');
    GPU_EMBEDDED_FONT_STATE.resources = bundle.resources.length;
    GPU_EMBEDDED_FONT_STATE.faces = bundle.faces.length;
    GPU_EMBEDDED_FONT_STATE.bytes = bundle.resources.reduce((sum, resource) => sum + resource.bytes, 0);
    const buffers = await Promise.all(bundle.resources.map(loadSiteFontResource));
    const entries = bundle.faces.map(entry => {
      if (
        !Number.isInteger(entry.resource) ||
        !buffers[entry.resource] ||
        typeof entry.family !== 'string' ||
        !entry.descriptors
      )
        throw Error('Invalid font face descriptor');
      const resource = bundle.resources[entry.resource];
      return {
        family: entry.family,
        sourceURL: resource.url ? siteFontResourceURL(resource.url) : 'embedded:woff2/' + resource.sha256,
        bytes: buffers[entry.resource],
        descriptors: { ...entry.descriptors },
      };
    });
    GPU_EMBEDDED_FONT_STATE.families = [...new Set(entries.map(entry => entry.family))];
    const results = await Promise.allSettled(
      entries.map(async entry => {
        let face;
        try {
          face = new FontFace(entry.family, entry.bytes, entry.descriptors);
          fontSet.add(face);
          await face.load();
          GPU_EMBEDDED_FONT_STATE.loadedFaces++;
          return entry;
        } catch (error) {
          if (face) fontSet.delete(face);
          GPU_EMBEDDED_FONT_STATE.errors.push(entry.family + ': ' + String(error.message || error));
          throw error;
        }
      }),
    );
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    GPU_STARTUP.recordFontFaces(
      'embedded-woff2',
      results.map(result => result.value),
    );
    GPU_EMBEDDED_FONT_STATE.status = 'ready';
  })()
    .catch(error => {
      GPU_EMBEDDED_FONT_STATE.status = 'error';
      const message = String(error.message || error);
      if (!GPU_EMBEDDED_FONT_STATE.errors.some(entry => entry.includes(message)))
        GPU_EMBEDDED_FONT_STATE.errors.push(message);
      throw siteFontResourceFailure(error);
    })
    .finally(() => {
      GPU_EMBEDDED_FONT_STATE.wallMs = performance.now() - start;
    });
  return gpuEmbeddedFontPromise;
}

globalThis.loadEmbeddedFonts = loadEmbeddedFonts;
globalThis.GPU_EMBEDDED_FONT_STATE = GPU_EMBEDDED_FONT_STATE;
