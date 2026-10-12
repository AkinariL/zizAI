class Drift {
  constructor(canvas, opt) {
    this.cv = canvas;
    this.o = opt;
    this.ps = [];
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
  }
  resize(w, h, dpr) {
    if (this.w) {
      const sx = w / this.w,
        sy = h / this.h;
      for (const p of this.ps) {
        p.x *= sx;
        p.y *= sy;
      }
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.blank = true;
  }
  pan(dx) {
    if (dx) for (const p of this.ps) if (!p.dormant) p.x -= dx * (0.8 + 0.25 * p.z);
  }
  seed(kind, n, S, weight) {
    for (let i = 0; i < n; i++) {
      const p = this.make(kind, S);
      this.place(p, true);
      p.dormant = Math.random() > weight(kind, clamp(p.x / this.w, 0, 1));
      p.retry = Math.random() * 1.5;
      p.life = 10;
      this.ps.push(p);
    }
  }
  make(kind, S) {
    const o = this.o,
      z = Math.pow(Math.random(), 1.3);
    const leaf = kind === 'leaf';
    const p = { kind, z, S };
    p.size = (leaf ? lerp(o.leaf[0], o.leaf[1], z) : lerp(o.petal[0], o.petal[1], z)) * S;
    p.alpha = leaf ? lerp(0.22, 0.8, z) * o.alpha : lerp(0.4, 0.95, z) * o.alpha;
    p.vy = (leaf ? lerp(15, 44, z) : lerp(12, 36, z)) * S * o.speed;
    p.vx = -(leaf ? lerp(8, 27, z) : lerp(10, 32, z)) * S * o.speed;
    const pace = rr(Math.random, 0.9, 1.35);
    p.vy *= pace;
    p.vx *= pace;
    p.rot = leaf ? rr(Math.random, 2.2, 3.6) : Math.random() * TAU;
    p.vr = (Math.random() - 0.5) * (leaf ? 0.5 : 2.2);
    p.flip = Math.random() * TAU;
    p.vf = rr(Math.random, 0.5, 1.6) * (leaf ? 0.7 : 1.5);
    p.sw = Math.random() * TAU;
    p.vsw = rr(Math.random, 0.45, 1.05);
    p.amp = rr(Math.random, 8, 30) * S * (0.4 + z) * o.speed;
    p.spr = (Math.random() * 4) | 0;
    p.blur = z < 0.2 ? 2 : z < 0.42 ? 1 : 0;
    p.life = 0;
    return p;
  }
  place(p, anywhere) {
    const reg = this.o.region ? this.o.region() : { x0: 0, x1: this.w, y0: 0, y1: this.h };
    const rw = reg.x1 - reg.x0,
      rh = reg.y1 - reg.y0;
    if (anywhere) {
      p.x = reg.x0 + Math.random() * rw * 1.1;
      p.y = reg.y0 + Math.random() * rh;
      return;
    }
    if (Math.random() < 0.7) {
      p.x = reg.x0 + rr(Math.random, 0.05, 1.25) * rw;
      p.y = reg.y0 - p.size * 0.8 - 4;
    } else {
      p.x = reg.x1 + p.size * 0.8 + 4;
      p.y = reg.y0 + rr(Math.random, -0.05, 0.8) * rh;
    }
  }
  step(dt, weight, gust) {
    const reg = this.o.region ? this.o.region() : { x0: 0, x1: this.w, y0: 0, y1: this.h };
    const rw = reg.x1 - reg.x0;
    for (const p of this.ps) {
      if (p.dormant) {
        p.retry -= dt;
        if (p.retry <= 0) {
          this.place(p, false);
          const xf = clamp((p.x - reg.x0) / rw, 0, 1);
          if (Math.random() < weight(p.kind, xf)) {
            p.dormant = false;
            p.life = 0;
          } else p.retry = rr(Math.random, 0.25, 0.9);
        }
        continue;
      }
      p.life += dt;
      p.sw += p.vsw * dt;
      p.flip += p.vf * dt;
      p.x += (p.vx * gust + Math.cos(p.sw) * p.amp * p.vsw) * dt;
      p.y += p.vy * (0.85 + 0.3 * Math.sin(p.sw * 0.5 + 1)) * dt;
      p.rot += p.vr * dt + Math.cos(p.sw) * (p.kind === 'leaf' ? 0.35 : 0.6) * dt;
      if (p.x < reg.x0 - p.size * 1.4 || p.y > reg.y1 + p.size * 1.4) {
        p.dormant = true;
        p.retry = 0;
      }
    }
  }
}
