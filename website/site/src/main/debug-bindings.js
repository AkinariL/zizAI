function hashBytes(d) {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

if (SITE_DEBUG && SITE_CONFIG.debug) {
  window.__zz = { gpu: GPU_DIAG, compositor: () => comp, gpuLine: GPU_LINE, gpuUI: GPU_UI };
  window.__rebuild = () => buildWorld(false);
  window.__tileBaseline = {
    get ready() {
      return !!comp?.remoteWorker && comp.valid && world.geo && worldIdle();
    },
    run: spec => comp.debugTile(spec),
    pause() {
      TUNE.pause = true;
      comp.setVisible(false);
    },
  };
}
