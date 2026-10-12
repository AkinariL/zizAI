const cpuUtilsRuntimes = new Map();
function getCPUUtilsRuntime(role = 'startup') {
  if (cpuUtilsRuntimes.has(role)) return cpuUtilsRuntimes.get(role);
  cpuUtilsRuntimes.set(role, null);
  const runtime = instantiateNativeRuntime(
    typeof CPU_UTILS_WASM_BYTES === 'undefined' ? null : CPU_UTILS_WASM_BYTES,
    typeof CPU_UTILS_SHARED_WASM_BYTES === 'undefined' ? null : CPU_UTILS_SHARED_WASM_BYTES,
    globalThis.GPU_CPU_OPTIONS?.sharedMemory === false,
  );
  if (!runtime) return null;
  const { api, memory } = runtime;
  if (!api.cu_role(role === 'glyph' ? 2 : 1)) throw Error('Native utility role mismatch');
  const f = new Float32Array(memory.buffer);
  const view = (Type, at, n) => new Type(memory.buffer, at, n);
  function pack(items, limit, ui = false, gutter = 2) {
    if (items.length > 4096) throw Error('Native glyph atlas capacity exceeded');
    const at = api.cu_rects() / 4;
    for (let i = 0; i < items.length; i++) {
      f[at + i * 4] = items[i].w;
      f[at + i * 4 + 1] = items[i].h;
    }
    if (!api.cu_pack(items.length, gutter, limit, ui ? 0 : 1)) throw Error('Native glyph atlas exceeds texture limit');
    const p = view(Uint32Array, api.cu_placements(), items.length * 2),
      info = view(Uint32Array, api.cu_info(), 16);
    for (let i = 0; i < items.length; i++) {
      if (ui) {
        items[i].ax = p[i * 2];
        items[i].ay = p[i * 2 + 1];
      } else {
        items[i].atlasX = p[i * 2];
        items[i].atlasY = p[i * 2 + 1];
      }
    }
    return ui ? { w: info[0], h: info[1] } : { width: info[0], height: info[1] };
  }
  function paper() {
    if (role === 'glyph') throw Error('Glyph workspace cannot overwrite immutable startup assets');
    if (!api.cu_paper()) throw Error('Native paper generation failed');
    const i = view(Uint32Array, api.cu_info(), 16);
    return {
      width: 512,
      height: 512,
      data: view(Uint8ClampedArray, i[0], 512 * 512 * 4),
      histogram: view(Uint32Array, i[1], 256),
      pap: Math.fround(i[2] / 255),
      native: true,
    };
  }
  function grain() {
    if (role === 'glyph') throw Error('Glyph workspace cannot overwrite immutable startup assets');
    if (!api.cu_grain()) throw Error('Native grain capacity exceeded');
    const i = view(Uint32Array, api.cu_info(), 16);
    return { values: view(Float32Array, i[0], i[1]), fibres: view(Float32Array, i[2], i[3]), native: true };
  }
  function hashParticles(buffer, count) {
    if (count > 4096) throw Error('Native particle capacity exceeded');
    const p = api.cu_scratch();
    const direct =
      ArrayBuffer.isView(buffer) &&
      buffer.buffer === memory.buffer &&
      buffer.byteOffset === p &&
      buffer.byteLength === count * 80;
    if (!direct)
      view(Uint8Array, p, count * 80).set(
        ArrayBuffer.isView(buffer)
          ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          : new Uint8Array(buffer),
      );
    if (!api.cu_particle_hash(count)) throw Error('Native particle hash failed');
    if (!direct) {
      const out = ArrayBuffer.isView(buffer)
          ? new Uint32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
          : new Uint32Array(buffer),
        v = view(Uint32Array, p, count * 20);
      for (let n = 0; n < count; n++) out[n * 20 + 19] = v[n * 20 + 19];
    }
    runtime.particleWasmCopyBytes = (runtime.particleWasmCopyBytes || 0) + (direct ? 0 : count * 84);
  }
  function particleWorkspace(count) {
    if (role !== 'particle' || count > 4096) throw Error('Native particle workspace capacity/role mismatch');
    return view(Float32Array, api.cu_scratch(), count * 20);
  }
  function prewarmText(runs, glyphPack, alignment) {
    if (role !== 'glyph') throw Error('Text prewarm requires its own glyph workspace');
    let gi = 0;
    const ri = api.cu_run_input() / 4,
      at = api.cu_glyph_input() / 4;
    if (runs.length > 8192) throw Error('Native text run capacity exceeded');
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i],
        p = ri + i * 16;
      f[p] = run.w;
      f[p + 1] = run.h;
      f[p + 2] = run.padding;
      f[p + 3] = run.dpr;
      f[p + 4] = run.baseline;
      f[p + 5] = run.radius;
      f[p + 6] = run.sigma;
      f[p + 7] = run.drySigma;
      f[p + 8] = run.atlasX;
      f[p + 9] = run.atlasY;
      f[p + 10] = gi;
      f[p + 11] = run.glyphs.length;
      for (const placement of run.glyphs) {
        if (gi >= 10240) throw Error('Native text glyph capacity exceeded');
        const g = placement.glyph,
          q = at + gi++ * 8;
        f[q] = placement.x;
        f[q + 1] = placement.y;
        f[q + 2] = g.left;
        f[q + 3] = g.top;
        f[q + 4] = g.w;
        f[q + 5] = g.h;
        f[q + 6] = g.atlasX;
        f[q + 7] = g.atlasY;
      }
    }
    if (!api.cu_text_prewarm(runs.length, gi, alignment, glyphPack.width, glyphPack.height))
      throw Error('Native text prewarm exceeds fixed workspace capacity');
    return prewarmResult('uniformData');
  }
  function prewarmUI(blurred, size, alignment) {
    if (role !== 'glyph' || blurred.length > 10240) throw Error('Native UI prewarm capacity/role mismatch');
    const at = api.cu_glyph_input() / 4;
    for (let i = 0; i < blurred.length; i++) {
      const g = blurred[i],
        p = at + i * 8;
      f[p] = g.w;
      f[p + 1] = g.h;
      f[p + 2] = g.blur;
      f[p + 3] = g.dpr;
      f[p + 4] = g.ax;
      f[p + 5] = g.ay;
    }
    if (!api.cu_ui_prewarm(blurred.length, alignment, size.w, size.h))
      throw Error('Native UI prewarm exceeds fixed workspace capacity');
    return prewarmResult('parameters');
  }
  function prewarmResult(key) {
    const i = view(Uint32Array, api.cu_info(), 16);
    return {
      vertices: view(Float32Array, i[0], i[1]),
      [key]: view(Float32Array, i[2], i[3]),
      maxW: i[4],
      maxH: i[5],
      nativeNumeric: true,
      cpuPrecision: 'float32',
    };
  }
  Object.assign(runtime, {
    pack,
    paper,
    grain,
    hashParticles,
    particleWorkspace,
    prewarmText,
    prewarmUI,
    precision: 'float32',
    simd: 'f32x4',
    role,
  });
  cpuUtilsRuntimes.set(role, runtime);
  return runtime;
}

let cpuUtilsAnimationRuntime = null;
function getNativeAnimationRuntime() {
  if (cpuUtilsAnimationRuntime) return cpuUtilsAnimationRuntime;
  const native = getCPUUtilsRuntime('startup');
  if (!native?.api.an_info || !native.api.an_frame) throw Error('Native animation evaluator unavailable');
  const { api, memory } = native,
    info = new Uint32Array(memory.buffer, api.an_info(), 16);
  const maxRows = info[5],
    maxCurves = info[6],
    motionStride = info[7],
    rowStride = info[8],
    curveStride = info[9],
    outputStride = info[10];
  const motions = new Float32Array(memory.buffer, info[0], 8 * motionStride),
    rows = new Float32Array(memory.buffer, info[1], maxRows * rowStride),
    output = new Float32Array(memory.buffer, info[2], maxRows * outputStride),
    curves = new Float32Array(memory.buffer, info[3], maxCurves * curveStride),
    scene = new Float32Array(memory.buffer, info[4], 32);
  const codes = {
    linear: 0,
    bezier: 1,
    points: 2,
    sine: 3,
    quad: 4,
    cubic: 5,
    quart: 6,
    quint: 7,
    pow: 8,
    expo: 9,
    circ: 10,
    back: 11,
    elastic: 12,
    bounce: 13,
  };
  const curveIDs = new Map();
  let rowCount = 0,
    curveCount = 0;
  const number = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  function curve(c = { type: 'linear' }) {
    const key = JSON.stringify(c),
      existing = curveIDs.get(key);
    if (existing !== undefined) return existing;
    if (curveCount >= maxCurves) throw Error('Native animation curve capacity exceeded');
    if (c.points && c.points.length > 64) throw Error('Native animation response exceeds 64 samples');
    const id = curveCount++,
      p = id * curveStride;
    curves.fill(0, p, p + curveStride);
    curves[p] = codes[c.type] ?? 0;
    curves[p + 1] = c.mode === 'in' ? 0 : c.mode === 'inOut' ? 1 : 2;
    curves[p + 2] = number(c.n, 3);
    curves[p + 3] = number(c.s, 1.70158);
    curves[p + 4] = number(c.amp, 1);
    curves[p + 5] = number(c.per, 0.3);
    const bz = c.bz || [0, 0, 1, 1];
    for (let i = 0; i < 4; i++) curves[p + 6 + i] = bz[i];
    if (c.points) {
      curves[p + 10] = c.points.length;
      for (let i = 0; i < c.points.length; i++) curves[p + 11 + i] = c.points[i];
    }
    curveIDs.set(key, id);
    return id;
  }
  function resetRows() {
    rowCount = 0;
    curveCount = 0;
    curveIDs.clear();
    curve();
  }
  function row(
    channel,
    start,
    duration,
    delay,
    easing,
    from = 0,
    to = 1,
    type = 0,
    shape = 0,
    clamp = false,
    endpoints = 3,
  ) {
    if (rowCount >= maxRows) throw Error('Native animation row capacity exceeded');
    const id = rowCount++,
      p = id * rowStride;
    rows[p] = channel;
    rows[p + 1] = curve(easing);
    rows[p + 2] = start;
    rows[p + 3] = duration;
    rows[p + 4] = delay;
    rows[p + 5] = from;
    rows[p + 6] = to;
    rows[p + 7] = type;
    rows[p + 8] = shape;
    rows[p + 9] = clamp ? 1 : 0;
    rows[p + 10] = endpoints;
    rows[p + 11] = 0;
    return id;
  }
  function setMotion(index, source, reset, shift = 0) {
    const p = index * motionStride;
    if (!source) {
      motions[p + 13] = 0;
      return;
    }
    const c = source.cfg || source,
      type = c.type === 'spring' ? 0 : c.type === 'exp' ? 1 : 2;
    if (reset) {
      motions[p] = number(source.x);
      motions[p + 1] = number(source.v);
      motions[p + 8] = number(source.from, source.x);
      motions[p + 9] = number(source.goal, source.target);
      motions[p + 10] = number(source.t, 1);
      motions[p + 12] = type;
    } else if (shift) for (const field of [0, 2, 8, 9]) motions[p + field] += shift;
    motions[p + 2] = number(source.target);
    motions[p + 3] = type;
    motions[p + 4] = number(c.k, 200);
    motions[p + 5] = number(c.z, 0.8);
    motions[p + 6] = number(c.tau, 0.4);
    motions[p + 7] = number(c.dur, 0.6);
    motions[p + 11] = curve(type === 2 ? c : { type: 'linear' });
    motions[p + 13] = 1;
  }
  function resetScene(control, latest, source) {
    scene[0] = number(control.time, latest.time);
    scene[1] = number(control.clock) / 1000;
    scene[2] = number(latest.mx);
    scene[3] = number(latest.my);
    scene[4] = number(latest.veil);
    scene[5] = number(source.cam?.lead, number(source.cam?.x, control.cam));
    scene[6] = number(source.page?.D, latest.D);
    scene[7] = number(source.box?.D, control.box?.D);
    scene[22] = scene[23] = 0;
    scene[24] = scene[25] = 0;
  }
  function inputs(control, source) {
    scene[8] = number(control.mouseTarget?.[0], scene[2]);
    scene[9] = number(control.mouseTarget?.[1], scene[3]);
    scene[10] = number(control.veilTarget, scene[4]);
    scene[11] = number(source.cam?.camT, source.cam?.target);
    scene[12] = number(source.cam?.leadTime, source.cam?.cfg?.lead);
    scene[14] =
      control.staticMode === 'zh' ? 1 : control.staticMode === 'ja' ? 2 : control.staticMode === 'mix' ? 3 : 0;
    scene[15] = Number(param('t') || '.5');
  }
  function frame(dt, dts, slow, textTime, uiTime) {
    if (!api.an_frame(rowCount, curveCount, dt, dts, slow, textTime, uiTime))
      throw Error('Native animation batch rejected');
  }
  resetRows();
  cpuUtilsAnimationRuntime = {
    motions,
    rows,
    output,
    curves,
    scene,
    maxRows,
    maxCurves,
    motionStride,
    outputStride,
    workspaceBytes: info[11],
    get rowCount() {
      return rowCount;
    },
    get curveCount() {
      return curveCount;
    },
    curve,
    resetRows,
    row,
    setMotion,
    resetScene,
    inputs,
    frame,
    precision: 'float32',
    simd: 'f32x4',
  };
  return cpuUtilsAnimationRuntime;
}
