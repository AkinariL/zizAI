function createMeshCanvas(width, height, options = {}) {
  const rt = getTileDataRuntime(),
    a = rt.api;
  let W = Math.max(1, Math.round(width)),
    H = Math.max(1, Math.round(height));
  const tolerance = options.curveTolerance ?? 0.25;
  const h = rt.check(
    a.mc_create(
      W,
      H,
      tolerance,
      options.gpuGeometry === false ? 0 : 1,
      options.analyticStrokes === false ? 0 : 1,
      options.compactSingleEllipses ? 1 : 0,
    ),
  );
  const bank = rt.bankForHandle(h);
  const reset = () => a.mc_reset(h, W, H);
  return {
    _cppHandle: h,
    _commandBank: bank,
    get width() {
      return W;
    },
    set width(value) {
      W = Math.max(1, Math.round(value));
      reset();
    },
    get height() {
      return H;
    },
    set height(value) {
      H = Math.max(1, Math.round(value));
      reset();
    },
    exportMesh() {
      const c = rt.view(Uint32Array, a.mc_info(h, 1), 16);
      const packet = bank.exportPacket(W, H, 2, {
        fills: c[0],
        strokes: c[1],
        groups: c[2],
        culled: c[3],
        clearResets: c[4],
        partialClearResets: c[5],
        curveSegments: c[6],
        maxCurveDepth: c[7],
        gpuCurveSegments: c[8],
        compactFallbacks: c[9],
        compactByteFallbacks: c[10],
        compactEllipseFallbacks: c[12],
        stampTransformFallbacks: c[13],
        stampInputFallbacks: c[14],
        curveTolerance: tolerance,
        analyticStrokes: options.analyticStrokes !== false,
        gpuGeometry: options.gpuGeometry !== false,
        nativeRecorder: true,
        nativePainter: true,
        precision: 'float32',
        retainedPathObjects: 0,
      });
      rt.addBankStats(packet, h);
      return packet;
    },
  };
}
