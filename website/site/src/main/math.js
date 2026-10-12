const TAU = Math.PI * 2;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const lerp = (a, b, t) => a + (b - a) * t;

const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N1 = (() => {
  const r = rng(1337),
    N = 1024,
    v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = r();
  return x => {
    const i = Math.floor(x),
      f = x - i,
      u = f * f * (3 - 2 * f);
    return v[i & 1023] * (1 - u) + v[(i + 1) & 1023] * u;
  };
})();

const LAYERS = [
  { pan: 0.2, res: 0.6, y0: 0.33, y1: 0.76, cell: 0.02, reach: 0.08, blur: 1.5, lag: -0.08 },
  { pan: 0.46, res: 0.82, y0: 0.25, y1: 0.97, cell: 0.045, reach: 0.2, blur: 0.5, lag: -0.03 },
  { pan: 0.86, res: 1, y0: 0.26, y1: 1.02, cell: 0.13, reach: 0.42, blur: 0, lag: 0.02 },
  { pan: 1.6, res: 1, y0: -0.04, y1: 1.04, cell: 0.8, reach: 2.4, blur: 0, lag: 0.08 },
];

const CLOSE = 3;

const MTN = { pan: [0.035, 0.075], y0: 0.17, y1: 0.76, res: 0.35 };

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
    const g = { ts, T, n, R: n * T, Ht, pad, margin };

    return g;
  });
}

function mountainDimensions(W, H) {
  const s = MTN.res,
    Pw = Math.max(96, Math.round(Math.max(3 * H, 1.7 * W) * s)),
    Ph = Math.max(16, Math.round((MTN.y1 - MTN.y0) * H * s));
  return { Pw, Ph, Pc: Pw / s };
}
