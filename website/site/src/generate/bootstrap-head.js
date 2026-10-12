(() => {
  let started = false;
  const waiting = [];
  self.onmessage = event => {
    if (event.data?.type === 'bootstrap' && !started) {
      started = true;
      globalThis.SITE_CONFIG = event.data.config;
      if (SITE_DEBUG && SITE_CONFIG.debug && SITE_CONFIG.breakgen === 'load') {
        throw Error('generator broken on purpose');
      }
      if (SITE_DEBUG && SITE_CONFIG.debug && SITE_CONFIG.breakgen === 'silent') return;
      start().catch(error => {
        self.postMessage({ type: 'bootstrap-error', error: String(error.stack || error) });
      });
    } else waiting.push(event);
  };
  async function start() {
    self.GPU_MESH_OPTIONS = { sharedMemory: SITE_CONFIG.profile === 'shared' };
    const native = await loadSiteNative('tile');
    const TILE_DATA_WASM_BYTES = native.ordinary;
    const TILE_DATA_SHARED_WASM_BYTES = native.shared;
