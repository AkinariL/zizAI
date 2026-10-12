const INK_ZH = [21, 31, 25],
  INK_JA = [44, 31, 34];
const MIST_ZH = [229, 237, 224],
  MIST_JA = [244, 236, 237],
  WASH_ZH = [205, 226, 196],
  WASH_JA = [246, 208, 219];
const BAM_FAR = [100, 121, 108],
  BAM_MID = [57, 75, 63];
const SAK_FAR = [150, 124, 132],
  SAK_MID = [96, 74, 80];
const PINK_PALE = [251, 229, 234],
  PINK = [241, 186, 201],
  PINK_DEEP = [221, 131, 156],
  PINK_LINE = [192, 104, 128],
  PINK_HEART = [176, 66, 98];
const SKY = {
  zh: [
    [212, 224, 207],
    [229, 237, 224],
    [221, 230, 216],
  ],
  ja: [
    [234, 221, 224],
    [245, 238, 236],
    [238, 227, 228],
  ],
};
const MTN_TINT = {
  zh: [
    [121, 140, 135],
    [94, 114, 106],
  ],
  ja: [
    [160, 135, 145],
    [134, 108, 118],
  ],
};
const LAYERS = [
  { pan: 0.2, res: 0.6, y0: 0.33, y1: 0.76, cell: 0.02, reach: 0.08, blur: 1.5, lag: -0.08 },
  { pan: 0.46, res: 0.82, y0: 0.25, y1: 0.97, cell: 0.045, reach: 0.2, blur: 0.5, lag: -0.03 },
  { pan: 0.86, res: 1, y0: 0.26, y1: 1.02, cell: 0.13, reach: 0.42, blur: 0, lag: 0.02 },
  { pan: 1.6, res: 1, y0: -0.04, y1: 1.04, cell: 0.8, reach: 2.4, blur: 0, lag: 0.08 },
];
const CLOSE = 3;
const MTN = { pan: [0.035, 0.075], y0: 0.17, y1: 0.76, res: 0.35 };
const world = {
  W: 0,
  H: 0,
  kc: 1,
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
    const g = { ts, T, n, R: n * T, Ht, pad, margin };
    return g;
  });
}
function tileSpan(li, cam) {
  const g = world.geo[li],
    c = cam * LAYERS[li].pan * world.H;
  return [Math.floor(((c - g.margin) * g.ts) / g.T), Math.floor(((c + world.W + g.margin) * g.ts) / g.T)];
}
function worldView(cam) {
  const { W, H, geo, mtn } = world,
    fr = x => x - Math.floor(x);
  return {
    sc: geo.map(g => (W * g.ts) / g.R),
    of: geo.map((g, i) => fr((cam * LAYERS[i].pan * H * g.ts) / g.R)),
    n1: LAYERS.map(L => fr(cam * L.pan * 0.5)),
    n3: LAYERS.map(L => fr(cam * L.pan * 1.5)),
    ms: W / mtn.Pc,
    mo: MTN.pan.map(p => fr((cam * p * H) / mtn.Pc)),
  };
}
