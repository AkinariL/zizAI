(async () => {
  const diagnostic = {
    navigatorGPU: !!navigator.gpu,
    worker: false,
    offscreen: false,
    adapter: false,
    context: false,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    selected: null,
    error: null,
  };
  const config = globalThis.SITE_ENTRY_CONFIG;
  try {
    if (
      typeof Worker !== 'function' ||
      typeof OffscreenCanvas !== 'function' ||
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen !== 'function'
    )
      throw Error('Worker rendering APIs are unavailable');
    const worker = new Worker(new URL(config.probeURL, document.baseURI).href + location.hash, {
      name: 'Rendering capability probe',
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Worker rendering capability probe timed out')), 30000);
        worker.onmessage = event => {
          clearTimeout(timer);
          event.data.error ? reject(Error(event.data.error)) : resolve(event.data);
        };
        worker.onerror = event => {
          clearTimeout(timer);
          reject(Error(event.message || 'Worker probe failed'));
        };
      });
      Object.assign(diagnostic, result);
    } finally {
      worker.terminate();
    }
    const ordinary = new URLSearchParams(location.hash.slice(1)).get('tilememory') === 'ordinary';
    diagnostic.selected = diagnostic.crossOriginIsolated && !ordinary ? 'shared' : 'ordinary';
    sessionStorage.setItem('webgpuEntry', JSON.stringify(diagnostic));
    globalThis.__siteEntryDiagnostic = diagnostic;
    location.replace(new URL(config.packages[diagnostic.selected], document.baseURI).href + location.hash);
  } catch (error) {
    diagnostic.error = String(error.message || error);
    diagnostic.selected = 'server-fallback';
    globalThis.__siteEntryDiagnostic = diagnostic;
    try {
      sessionStorage.setItem('webgpuEntry', JSON.stringify(diagnostic));
    } catch {}
    if (config.fallbackURL) location.replace(new URL(config.fallbackURL, document.baseURI).href);
    else document.body.textContent = '画面を表示できません。';
  }
})();
