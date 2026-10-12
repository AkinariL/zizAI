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
const rr = (r, a, b) => a + (b - a) * r();
const rgba = (c, a) =>
  'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function makeCanvas(w, h) {
  return new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}
const softCtx = c => c.getContext('2d', { willReadFrequently: true });
function periodicNoise(seed, period) {
  const r = rng(seed),
    g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x, y) => {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      xf = x - xi,
      yf = y - yi;
    const u = xf * xf * (3 - 2 * xf),
      v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period,
      y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period,
      y1 = (y0 + 1) % period;
    const a = g[x0 + y0 * period],
      b = g[x1 + y0 * period],
      c = g[x0 + y1 * period],
      d = g[x1 + y1 * period];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}
function makePaper(size, seed) {
  const c = makeCanvas(size, size),
    ctx = softCtx(c);
  const img = ctx.createImageData(size, size),
    d = img.data;
  const p = size / 64;
  const n1 = periodicNoise(seed, (4 * p) | 0 || 4),
    n2 = periodicNoise(seed + 1, (16 * p) | 0 || 16),
    n3 = periodicNoise(seed + 2, (64 * p) | 0 || 64);
  const P1 = (4 * p) | 0 || 4,
    P2 = (16 * p) | 0 || 16,
    P3 = (64 * p) | 0 || 64;
  const r = rng(seed + 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size;
      const val =
        0.5 +
        (n1(u * P1, v * P1) - 0.5) * 0.26 +
        (n2(u * P2, v * P2) - 0.5) * 0.2 +
        (n3(u * P3, v * P3) - 0.5) * 0.16 +
        (r() - 0.5) * 0.13;
      const i = (x + y * size) * 4,
        b = clamp(val, 0, 1) * 255;
      d[i] = d[i + 1] = d[i + 2] = b;
      d[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  ctx.lineCap = 'round';
  const fibres = ((size * size) / 380) | 0;
  for (let k = 0; k < fibres; k++) {
    const x = r() * size,
      y = r() * size,
      len = rr(r, 5, 30),
      a0 = r() * TAU,
      curv = rr(r, -0.12, 0.12);
    const light = r() < 0.55;
    ctx.strokeStyle = light
      ? 'rgba(255,255,255,' + rr(r, 0.1, 0.3).toFixed(3) + ')'
      : 'rgba(0,0,0,' + rr(r, 0.04, 0.12).toFixed(3) + ')';
    ctx.lineWidth = rr(r, 0.4, 1.1);
    for (const ox of [-size, 0, size])
      for (const oy of [-size, 0, size]) {
        const sx = x + ox,
          sy = y + oy;
        if (sx < -40 || sx > size + 40 || sy < -40 || sy > size + 40) continue;
        ctx.beginPath();
        let px = sx,
          py = sy,
          a = a0;
        ctx.moveTo(px, py);
        for (let s = 0; s < 6; s++) {
          a += curv;
          px += (Math.cos(a) * len) / 6;
          py += (Math.sin(a) * len) / 6;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
  }
  return c;
}
function makePaperNoise() {
  const size = 512,
    paper = makePaper(size, 5),
    ctx = softCtx(paper);
  const img = ctx.getImageData(0, 0, size, size),
    d = img.data;
  const A = [4, 8, 16, 32].map((p, i) => [p, periodicNoise(70 + i, p)]);
  const B = [4, 8, 16, 32].map((p, i) => [p, periodicNoise(90 + i, p)]);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size;
      let fa = 0,
        fb = 0,
        amp = 0.5,
        tot = 0;
      for (let o = 0; o < 4; o++) {
        fa += A[o][1](u * A[o][0], v * A[o][0]) * amp;
        fb += B[o][1](u * B[o][0], v * B[o][0]) * amp;
        tot += amp;
        amp *= 0.5;
      }
      const i = (x + y * size) * 4;
      d[i + 1] = clamp((fa / tot - 0.5) * 1.6 + 0.5, 0, 1) * 255;
      d[i + 2] = clamp((fb / tot - 0.5) * 1.6 + 0.5, 0, 1) * 255;
      d[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return paper;
}
function samplePath(f, n) {
  const P = { x: new Float32Array(n), y: new Float32Array(n), w: new Float32Array(n), n };
  for (let i = 0; i < n; i++) {
    const q = f(i / (n - 1));
    P.x[i] = q[0];
    P.y[i] = q[1];
    P.w[i] = q[2];
  }
  return P;
}
function normals(P) {
  const n = P.n,
    nx = new Float32Array(n),
    ny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1),
      b = Math.min(n - 1, i + 1);
    const dx = P.x[b] - P.x[a],
      dy = P.y[b] - P.y[a],
      l = Math.hypot(dx, dy) || 1;
    nx[i] = -dy / l;
    ny[i] = dx / l;
  }
  return [nx, ny];
}
function ribbon(ctx, P, nx, ny, u0, u1) {
  ctx.beginPath();
  for (let i = 0; i < P.n; i++) {
    const w = P.w[i];
    const x = P.x[i] + nx[i] * w * u1,
      y = P.y[i] + ny[i] * w * u1;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  for (let i = P.n - 1; i >= 0; i--) {
    const w = P.w[i];
    ctx.lineTo(P.x[i] + nx[i] * w * u0, P.y[i] + ny[i] * w * u0);
  }
  ctx.closePath();
}
const BN = periodicNoise(4242, 128);
function brush(ctx, P, o) {
  const r = rng(o.seed | 0);
  const [nx, ny] = normals(P);
  const col = o.col,
    n = P.n;
  let wmax = 0,
    len = 0;
  for (let i = 0; i < n; i++) {
    wmax = Math.max(wmax, P.w[i]);
    if (i) len += Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]);
  }
  const head = o.head || 0,
    tail = o.tail || 0;
  const dryAt = s => (o.dry || 0) * (o.dryAt ? o.dryAt(s) : 1);
  if (o.body) {
    const g = ctx.createLinearGradient(P.x[0], P.y[0], P.x[n - 1], P.y[n - 1]);
    for (let k = 0; k <= 8; k++) {
      const s = k / 8;
      const fade =
        (head ? sstep(head * 0.15, head * 0.9, s) : 1) * (tail ? sstep(1 - tail * 0.15, 1 - tail * 0.9, s) : 1);
      g.addColorStop(s, rgba(col, o.a * o.body * fade * (1 - 0.6 * clamp(dryAt(s), 0, 1))));
    }
    ctx.fillStyle = g;
    ribbon(ctx, P, nx, ny, -0.94, 0.94);
    ctx.fill();
  }
  const B = o.B || Math.max(4, Math.min(48, Math.round((wmax * 2) / (o.bw || 1.6))));
  const cover = o.cover || 1.8,
    streak = o.streak ?? 0.45,
    unit = o.unit || 40;
  const ox = r() * 90,
    oy = r() * 90;
  const pres = new Float32Array(n);
  for (let k = 0; k < B; k++) {
    const u = ((k + 0.5) / B) * 2 - 1 + (r() - 0.5) * (1.1 / B);
    const au = Math.abs(u);
    let a = o.a * (1 - streak * r());
    a *= 1 + (o.edge || 0) * (au * au * au * 1.7 - 0.45);
    a = clamp(a, 0, 1);
    const hbRel = (1 / B) * cover * (0.7 + 0.6 * r());
    const s0 = head * Math.pow(r(), 1.6) * (0.45 + 0.9 * au),
      s1 = 1 - tail * Math.pow(r(), 1.6) * (0.45 + 0.9 * au);
    const fr = 0.035;
    const kb = ox + k * 0.61;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1);
      let pv = sstep(s0, s0 + fr, s) * (1 - sstep(s1 - fr, s1, s));
      if (head === 0 && s < fr) pv = 1;
      if (tail === 0 && s > 1 - fr) pv = Math.max(pv, s0 <= s ? 1 : 0);
      const d = dryAt(s) * (0.5 + 0.7 * au);
      if (d > 0 && pv > 0) {
        const g = BN(kb, oy + (s * len) / unit) * 0.7 + BN(kb * 2.1 + 40, oy + (s * len) / (unit * 0.3)) * 0.3;
        pv *= sstep(d - 0.06, d + 0.06, g);
      }
      pres[i] = pv;
    }
    ctx.beginPath();
    let i = 0;
    while (i < n) {
      while (i < n && pres[i] < 0.05) i++;
      const i0 = i;
      while (i < n && pres[i] >= 0.05) i++;
      const i1 = i - 1;
      if (i1 - i0 < 1) continue;
      for (let j = i0; j <= i1; j++) {
        const w = P.w[j],
          hb = hbRel * w * pres[j],
          cx = P.x[j] + nx[j] * u * w,
          cy = P.y[j] + ny[j] * u * w;
        j === i0 ? ctx.moveTo(cx + nx[j] * hb, cy + ny[j] * hb) : ctx.lineTo(cx + nx[j] * hb, cy + ny[j] * hb);
      }
      for (let j = i1; j >= i0; j--) {
        const w = P.w[j],
          hb = hbRel * w * pres[j],
          cx = P.x[j] + nx[j] * u * w,
          cy = P.y[j] + ny[j] * u * w;
        ctx.lineTo(cx - nx[j] * hb, cy - ny[j] * hb);
      }
      ctx.closePath();
    }
    ctx.fillStyle = rgba(col, a);
    ctx.fill();
  }
}
function leafShape(ctx, x, y, ang, len, wid, bend, asym) {
  const N = 16,
    ca = Math.cos(ang),
    sa = Math.sin(ang);
  const up = [],
    lo = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const cx = s * len,
      cy = bend * len * s * s;
    const dx = len,
      dy = 2 * bend * len * s,
      dl = Math.hypot(dx, dy);
    const nxl = -dy / dl,
      nyl = dx / dl;
    const h = wid * Math.pow(Math.sin(Math.PI * Math.pow(0.035 + 0.965 * s, 0.62)), 1.08);
    up.push([cx + nxl * h * (1 + asym), cy + nyl * h * (1 + asym)]);
    lo.push([cx - nxl * h * (1 - asym), cy - nyl * h * (1 - asym)]);
  }
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const p = up[i];
    const X = x + p[0] * ca - p[1] * sa,
      Y = y + p[0] * sa + p[1] * ca;
    i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  }
  for (let i = N; i >= 0; i--) {
    const p = lo[i];
    ctx.lineTo(x + p[0] * ca - p[1] * sa, y + p[0] * sa + p[1] * ca);
  }
  ctx.closePath();
}
function inkLeaf(ctx, x, y, ang, len, wid, bend, asym, col, a) {
  leafShape(ctx, x, y, ang, len, wid, bend, asym);
  const g = ctx.createLinearGradient(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len);
  g.addColorStop(0, rgba(col, a));
  g.addColorStop(0.45, rgba(col, a * 0.93));
  g.addColorStop(1, rgba(col, a * 0.62));
  ctx.fillStyle = g;
  ctx.fill();
  leafShape(
    ctx,
    x + Math.cos(ang) * len * 0.04,
    y + Math.sin(ang) * len * 0.04,
    ang,
    len * 0.8,
    wid * 0.55,
    bend,
    asym * 0.6,
  );
  ctx.fillStyle = rgba(col, a * 0.1);
  ctx.fill();
}
function petalPath(ctx, R) {
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(R * 0.22, -R * 0.2, R * 0.5, -R * 0.56, R * 0.84, -R * 0.42);
  ctx.quadraticCurveTo(R * 1.02, -R * 0.33, R * 0.99, -R * 0.1);
  ctx.lineTo(R * 0.86, -R * 0.01);
  ctx.lineTo(R * 0.99, R * 0.09);
  ctx.quadraticCurveTo(R * 1.02, R * 0.33, R * 0.84, R * 0.42);
  ctx.bezierCurveTo(R * 0.5, R * 0.56, R * 0.22, R * 0.2, 0, 0);
}
