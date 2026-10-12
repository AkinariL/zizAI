(async () => {
  const hash = new URLSearchParams(self.location.hash.slice(1)),
    requested = hash.get('renderer'),
    forceGL = ['gl', 'webgl', 'webgl2'].includes(requested);
  let gpuError = null;
  try {
    if (typeof OffscreenCanvas !== 'function' || typeof self.requestAnimationFrame !== 'function')
      throw Error('Worker canvas / animation APIs unavailable');
    if (!forceGL && (!hash.has('nowebgpu') || requested === 'webgpu')) {
      try {
        if (!navigator.gpu) throw Error('Worker WebGPU unavailable');
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        const context = new OffscreenCanvas(1, 1).getContext('webgpu');
        if (!adapter || !context) throw Error('Worker GPU adapter / context unavailable');
        self.postMessage({
          backend: 'webgpu',
          worker: true,
          offscreen: true,
          adapter: true,
          context: true,
          workerRAF: true,
        });
        return;
      } catch (error) {
        gpuError = String(error.message || error);
        if (requested === 'webgpu') throw error;
      }
    }
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw Error('Worker WebGL2 unavailable' + (gpuError ? '; ' + gpuError : ''));
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    self.postMessage({
      backend: 'webgl2',
      gpuFallbackReason: gpuError,
      worker: true,
      offscreen: true,
      adapter: false,
      context: true,
      workerRAF: true,
      maxTextureSize,
    });
  } catch (error) {
    self.postMessage({ error: String(error.message || error) });
  }
})();
