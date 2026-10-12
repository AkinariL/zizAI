(() => {
  let started = false;
  const waiting = [];
  self.onmessage = event => {
    if (event.data?.type === 'bootstrap' && !started) {
      started = true;
      globalThis.SITE_CONFIG = event.data.config;
      start().catch(error => self.postMessage({ type: 'bootstrap-error', error: String(error.stack || error) }));
    } else waiting.push(event);
  };
  async function start() {
    const native = await loadSiteNative('cpu');
    const CPU_UTILS_WASM_BYTES = native.ordinary;
    const CPU_UTILS_SHARED_WASM_BYTES = native.shared;
