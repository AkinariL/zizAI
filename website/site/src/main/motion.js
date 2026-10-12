const EASE_IN = {
  linear: () => t => t,
  sine: () => t => 1 - Math.cos((t * Math.PI) / 2),
  quad: () => t => t * t,
  cubic: () => t => t * t * t,
  quart: () => t => t * t * t * t,
  quint: () => t => t * t * t * t * t,
  pow: c => t => Math.pow(t, c.n),
  expo: () => t => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  circ: () => t => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  back: c => t => (c.s + 1) * t * t * t - c.s * t * t,
  elastic: c => {
    const a = Math.max(1, c.amp),
      p = Math.max(0.05, c.per),
      s = (p / TAU) * Math.asin(1 / a);
    return t => (t <= 0 ? 0 : t >= 1 ? 1 : -a * Math.pow(2, 10 * (t - 1)) * Math.sin(((t - 1 - s) * TAU) / p));
  },
  bounce: () => t => 1 - bounceOut(1 - t),
};

function bounceOut(t) {
  const n = 7.5625,
    d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

function cubicBezier(x1, y1, x2, y2) {
  const B = (a, b, u) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  return t => {
    let lo = 0,
      hi = 1,
      u = t;
    for (let i = 0; i < 22; i++) {
      u = (lo + hi) / 2;
      if (B(x1, x2, u) < t) lo = u;
      else hi = u;
    }
    return B(y1, y2, u);
  };
}

function easeOf(c) {
  if (c.type === 'bezier') return cubicBezier(...c.bz);
  const f = (EASE_IN[c.type] || EASE_IN.linear)(c);
  if (c.mode === 'in') return f;
  if (c.mode === 'inOut') return t => (t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2);
  return t => 1 - f(1 - t);
}

const CURVE_BASE = {
  type: 'spring',
  mode: 'out',
  dur: 0.6,
  k: 200,
  z: 0.8,
  tau: 0.4,
  n: 3,
  s: 1.70158,
  amp: 1,
  per: 0.3,
  bz: [0.25, 0.1, 0.25, 1],
};

const curve = o => ({ ...CURVE_BASE, ...o, bz: [...(o.bz || CURVE_BASE.bz)] });

const CURVES = {
  cam: curve({ type: 'spring', k: 5.5, z: 1, lead: 0.3, dur: 1.4, mode: 'inOut' }),
  track: curve({ type: 'spring', k: 70, z: 1, dur: 0.7 }),
  w: curve({ type: 'spring', k: 380, z: 0.68, dur: 0.45 }),
  h: curve({ type: 'spring', k: 260, z: 0.78, dur: 0.45 }),
  vis: curve({ type: 'spring', k: 150, z: 0.86, dur: 0.4 }),
  page: curve({ type: 'spring', k: 3, z: 1, tau: 1.3, dur: 1.8, mode: 'inOut' }),
  box: curve({ type: 'exp', tau: 0.5, dur: 0.8, mode: 'inOut' }),
  meter: curve({ type: 'exp', tau: 0.32, dur: 0.5 }),
  candIn: curve({ type: 'bezier', bz: [0.2, 0.8, 0.2, 1], dur: 0.42 }),
  candOut: curve({ type: 'bezier', bz: [0.4, 0, 0.2, 1], dur: 0.2 }),
  keyIn: curve({ type: 'bezier', bz: [0.2, 0.9, 0.3, 1], dur: 0.24 }),
  inkIn: curve({ type: 'bezier', bz: [0.2, 0.8, 0.2, 1], dur: 0.66 }),
};

const TRANS = { F: 0.65, J: 0.5, lag: 0.6, dip: 0.7, wideF: 0.5, wideT: 0.3 };

const TUNE = {
  speed: 1,
  pause: false,
  pan: 1,
  closePan: 1.6,
  base: 0.085,
  baseSoft: 0.028,
  baseA: 0.95,
  baseLift: 0.12,
};

const DEFAULTS = JSON.stringify({ curves: CURVES, trans: TRANS, tune: TUNE });

const RES_CAP = parseFloat(param('res') || '') || 0;
const RES_MOBILE = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const LAB = { res: RES_CAP || (RES_MOBILE ? 1.7 : 4), ground: true, drift: true, glass: true };

let CURVE_VER = 0;

function transShape() {
  const asp = world.W / world.H || 1.6,
    wide = sstep(1.1, 1.8, asp);
  const lagMax = Math.max(...LAYERS.map(L => Math.abs(L.lag))) * TRANS.lag;
  return { F: TRANS.F * (1 + TRANS.wideF * wide), J: TRANS.J, L: lagMax + 0.01, slow: 1 + TRANS.wideT * wide };
}

class Motion {
  constructor(x, cfg) {
    this.x = x;
    this.v = 0;
    this.target = x;
    this.cfg = cfg;
    this.goal = x;
    this.from = x;
    this.t = 1;
    this.type = cfg.type;
    this.f = null;
    this.fv = -1;
    this.eventSet = 0;
    this.eventShift = 0;
  }
  step(dt) {
    const c = this.cfg,
      x0 = this.x;
    if (c.type !== this.type) {
      this.type = c.type;
      this.from = this.x;
      this.goal = this.target;
      this.t = 0;
    }
    if (c.type === 'spring') {
      const k = Math.max(0.01, c.k),
        d = 2 * Math.sqrt(k) * c.z,
        n = Math.max(1, Math.ceil(dt / (1 / 240))),
        h = dt / n;
      for (let i = 0; i < n; i++) {
        const a = -k * (this.x - this.target) - d * this.v;
        this.v += a * h;
        this.x += this.v * h;
      }
      this.goal = this.target;
      this.t = 1;
      return this.x;
    }
    if (c.type === 'exp') {
      this.x += (this.target - this.x) * (1 - Math.exp(-dt / Math.max(0.005, c.tau)));
      this.goal = this.target;
    } else {
      if (this.target !== this.goal) {
        this.from = this.x;
        this.goal = this.target;
        this.t = 0;
      }
      if (this.fv !== CURVE_VER) {
        this.f = easeOf(c);
        this.fv = CURVE_VER;
      }
      this.t = Math.min(1, this.t + dt / Math.max(0.01, c.dur));
      this.x = this.t >= 1 ? this.goal : this.from + (this.goal - this.from) * this.f(this.t);
    }
    if (dt > 0) this.v = (this.x - x0) / dt;
    return this.x;
  }
  set(x) {
    this.x = this.target = this.goal = this.from = x;
    this.v = 0;
    this.t = 1;
    this.eventSet++;
  }
  shift(d) {
    this.x += d;
    this.target += d;
    this.goal += d;
    this.from += d;
    this.eventShift += d;
  }
}

class Blend {
  constructor(p, cfg) {
    this.m = new Motion(p, cfg);
    this.p = p;
    this.D = p > 0.5 ? 1 : 0;
    this.t = 0;
  }
  step(target, dt) {
    this.m.target = target;
    this.p = this.m.step(dt);
    const pin = this.D ? 1 - this.p : this.p;
    this.t = clamp((pin - 0.1) / 0.8, 0, 1);
    if (this.t >= 0.999) {
      this.D ^= 1;
      this.t = 0;
    }
  }
  reset(p) {
    this.m.set(p);
    this.p = p;
    this.D = p > 0.5 ? 1 : 0;
    this.t = 0;
  }
  mask(x) {
    const { F, J, L } = transShape(),
      e = 1 + 0.5 * F + 0.5 * J + L - this.t * (1 + F + J + 2 * L);
    return sstep(e - F / 2, e + F / 2, x);
  }
  weight(kind, x) {
    const zhIn = this.D === 1,
      m = this.mask(x);
    const zhShare = zhIn ? m : 1 - m;
    return kind === 'leaf' ? zhShare : 1 - zhShare;
  }
}
