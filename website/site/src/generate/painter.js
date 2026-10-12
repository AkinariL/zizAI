const LAYERS = [
  { pan: 0.2, res: 0.6, y0: 0.33, y1: 0.76, cell: 0.02, reach: 0.08, blur: 1.5, lag: -0.08 },
  { pan: 0.46, res: 0.82, y0: 0.25, y1: 0.97, cell: 0.045, reach: 0.2, blur: 0.5, lag: -0.03 },
  { pan: 0.86, res: 1, y0: 0.26, y1: 1.02, cell: 0.13, reach: 0.42, blur: 0, lag: 0.02 },
  { pan: 1.6, res: 1, y0: -0.04, y1: 1.04, cell: 0.8, reach: 2.4, blur: 0, lag: 0.08 },
];
const CLOSE = 3;
const STAMP_NAMES = ['blob', 'small', 'petal', 'half', 'bud', 'flower', 'leaf', 'grass'];
const NATIVE_LAYER_NAMES = [
  'sakuraFar',
  'sakuraMid',
  'sakuraNear',
  'sakuraClose',
  'bambooFar',
  'bambooMid',
  'bambooNear',
  'bambooClose',
];
const NATIVE_TILE_EXPORTS = ['pt_tile_geometry', 'pt_begin', 'pt_step', 'pt_abort'];
let STAMPS = {},
  NATIVE_PAINT = {};
function configureStamps(value) {
  const names = value == null || value === '' ? STAMP_NAMES : String(value).split(',');
  STAMPS = Object.fromEntries(STAMP_NAMES.map(name => [name, names.includes(name)]));
}
function nativeStampMask() {
  let mask = 0;
  for (let i = 0; i < STAMP_NAMES.length; i++) if (STAMPS[STAMP_NAMES[i]]) mask |= 1 << i;
  return mask;
}
function configureNativePaint(value) {
  const names =
    value == null || value === '' || value === 'all' || value === '1' ? NATIVE_LAYER_NAMES : String(value).split(',');
  if (!NATIVE_LAYER_NAMES.every(name => names.includes(name)))
    throw Error(
      'This build requires all native painting layers; disabled/partial nativepaint is unsupported. Use the frozen test reference for the old JS route.',
    );
  NATIVE_PAINT = Object.fromEntries(NATIVE_LAYER_NAMES.map(name => [name, true]));
}
configureStamps();
configureNativePaint();
let TILE_GPU = false;
function makeCanvas(w, h) {
  return createMeshCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), GPU_MESH_OPTIONS);
}
const world = {
  W: 0,
  H: 0,
  kc: 1,
  hero: 0,
  geo: null,
  rings: null,
  jobs: [],
  cur: null,
  mtn: null,
  mark: [2, 2, 2, 2],
  read: [-1, -1],
};
function worldGeometry(W, H, s, maxTex) {
  return LAYERS.map(L => {
    let ts = L.res * s,
      T,
      n;
    const Tc = Math.max(180, Math.round(Math.min(W, 1.5 * H) * 0.38)),
      margin = Math.round(0.04 * W + 24);
    for (;;) {
      T = Math.max(48, Math.round(Tc * ts));
      n = Math.ceil(((W + 2 * margin) * ts) / T) + 2;
      if (n * T <= maxTex || ts < 0.3) break;
      ts *= 0.85;
    }
    const Ht = Math.max(2, Math.round((L.y1 - L.y0) * H * ts)),
      pad = L.blur ? Math.ceil(3 * L.blur * (H / 900) * ts) + 2 : 0;
    return { ts, T, n, R: n * T, Ht, pad, margin, work: null };
  });
}
const PLANS = {
  clear() {
    const rt = getTileDataRuntime();
    if (rt.api.pt_cache_clear) rt.check(rt.api.pt_cache_clear());
  },
};
const SCRS = { clear() {} };
function nativePaintCheck(a, value) {
  if (!value) throw Error('Native tile generation failed: ' + a.pt_error());
  return value;
}
function* paintTile(job) {
  const { sc, li, k } = job,
    g = world.geo?.[li],
    canvas = g?.work;
  if (
    (sc !== 'zh' && sc !== 'ja') ||
    !Number.isInteger(li) ||
    li < 0 ||
    li > 3 ||
    !Number.isInteger(k) ||
    !canvas?._cppHandle
  )
    throw Error('Invalid native tile job/result canvas');
  const rt = getTileDataRuntime(),
    a = rt.api;
  for (const name of NATIVE_TILE_EXPORTS)
    if (typeof a[name] !== 'function') throw Error('Native tile producer export is missing: ' + name);
  nativePaintCheck(a, a.pt_tile_geometry(li, g.ts, g.T, g.Ht, g.pad, g.n, g.margin));
  let begun = false,
    done = false;
  try {
    begun = true;
    nativePaintCheck(a, a.pt_begin(canvas._cppHandle, sc === 'ja' ? 1 : 0, li, k));
    for (;;) {
      const status = a.pt_step();
      if (status === 2) {
        done = true;
        return;
      }
      if (status !== 1) throw Error('Native tile generation failed: ' + a.pt_error());
      yield;
    }
  } finally {
    if (begun && !done) a.pt_abort();
  }
}
