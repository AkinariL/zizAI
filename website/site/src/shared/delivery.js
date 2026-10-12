(() => {
  const config = globalThis.SITE_CONFIG;
  const hash = new URLSearchParams(location.hash.slice(1));
  const deliveredProfile = config.profile;
  if (config.profile === 'shared' && hash.get('tilememory') === 'ordinary') {
    config.profile = 'ordinary';
    config.assets.wasm.tile = config.assets.wasm.tileOrdinary;
  }
  delete config.assets.wasm.tileOrdinary;
  const urls = [];
  const binary = base64 => {
    const text = atob(base64),
      bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
  };
  function resourceURL(asset, type) {
    if (asset.url) return new URL(asset.url, document.baseURI).href;
    const url = URL.createObjectURL(new Blob([binary(asset.base64)], { type }));
    urls.push(url);
    return url;
  }
  for (const name of ['render', 'generate']) {
    const asset = config.workers[name];
    config.workers[name] =
      typeof asset === 'string' ? new URL(asset, document.baseURI).href : resourceURL(asset, 'text/javascript');
  }
  for (const asset of Object.values(config.assets.wasm)) {
    if (asset.url) asset.url = new URL(asset.url, document.baseURI).href;
  }
  for (const font of config.assets.fonts.resources) {
    if (location.protocol === 'file:' && font.base64) continue;
    font.url = resourceURL(font, 'font/woff2');
    delete font.base64;
  }
  config.breakgen = config.debug ? hash.get('breakgen') : null;
  try {
    config.entryDiagnostics = JSON.parse(sessionStorage.getItem('webgpuEntry') || 'null');
  } catch {}
  globalThis.__siteDelivery = {
    profile: config.profile,
    deliveredProfile,
    debug: config.debug,
    entry: config.entryDiagnostics,
  };
  addEventListener(
    'pagehide',
    () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
    { once: true },
  );
})();
