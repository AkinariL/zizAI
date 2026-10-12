#pragma once
namespace painter {
namespace close_sakura {
enum Kind : Word { Wash = 1, Brush = 2, Moss = 3, Bark = 4, Cluster = 5, Fallen = 6 };
static pc::Pen logicalPen;
static float drawPoints[4096 * 3], dryGrid[9];
inline bool fail(Word code = 80) {
  if (!error)
    error = code;
  cellStatus = error;
  return false;
}
inline bool add(ClosePlan& p, Word kind, float z, float x0, float x1, Word seed, const float* data, Word n) {
  return p.add(kind, z, x0, x1, seed, data, n) || fail(p.status ? p.status : 80);
}
inline bool half(Word h, float x, float y, float R, float dir, Random& r, float S, float tone) {
  float angles[3], radii[3];
  for (Word i = 0; i < 3; i++) {
    angles[i] = dir + (float(i) - 1) * .55f + r.range(-.12f, .12f);
    radii[i] = R * r.range(.86f, 1);
  }
  objectBegin(h, 3);
  float v[19] = {};
  pc::Paint gradient = {};
  bool hasGradient = false;
  for (Word i = 0; i < 3; i++) {
    memset(v, 0, sizeof v);
    v[0] = x;
    v[1] = y;
    v[2] = angles[i];
    v[3] = .82f;
    v[4] = radii[i];
    v[6] = 3;
    v[7] = tone;
    v[8] = R;
    v[16] = pc::q3(alphaQ3(.6f * tone));
    v[17] = pc::q3(alphaQ3(.5f * tone));
    v[18] = pc::q3(alphaQ3(.76f * tone));
    if ((config.stamps & (1u << 3)) && pc::stamp(h, 2, v, 19)) {
      if (error)
        return fail(error);
      continue;
    }
    if (error)
      return fail(error);
    if (!hasGradient) {
      gradient = pc::radial(h, x, y, 0, x, y, R);
      pc::stop(gradient, 0, color(pinkDeep, .6f * tone));
      pc::stop(gradient, .4f, color(pink, .5f * tone));
      pc::stop(gradient, 1, color(pinkPale, .76f * tone));
      hasGradient = true;
    }
    if (!pc::save(h) || !pc::translate(h, x, y) || !pc::rotate(h, angles[i]) || !pc::scale(h, 1, .82f))
      return fail(error ? error : 83);
    pc::begin(h);
    petalPath(h, radii[i]);
    pc::restore(h);
    if (!pc::fill(h, gradient))
      return fail(error ? error : 83);
  }
  memset(v, 0, sizeof v);
  v[0] = x - fm::cos(dir) * R * .08f;
  v[1] = y - fm::sin(dir) * R * .08f;
  v[2] = R * .22f;
  v[3] = R * .12f;
  v[4] = dir + fm::pi * .5f;
  v[6] = tone;
  v[7] = float(inkJA.r) / 255;
  v[8] = float(inkJA.g) / 255;
  v[9] = float(inkJA.b) / 255;
  v[10] = pc::q3(alphaQ3(.82f * tone));
  if (!((config.stamps & (1u << 3)) && pc::stamp(h, 3, v, 15))) {
    if (error)
      return fail(error);
    pc::begin(h);
    if (!pc::ellipse(h, v[0], v[1], v[2], v[3], v[4], 0, fm::tau) || !pc::fill(h, pc::solid(color(inkJA, .82f * tone))))
      return fail(error ? error : 83);
  }
  objectEnd(h);
  return !error;
}
inline bool bud(Word h, float x, float y, float R, float dir, float tone) {
  objectBegin(h, 4);
  float v[19] = {};
  v[0] = x + fm::cos(dir) * (R * .4f);
  v[1] = y + fm::sin(dir) * (R * .4f);
  v[2] = R * 1.05f;
  v[3] = R * .75f;
  v[4] = dir;
  v[5] = 2;
  v[6] = tone;
  v[7] = float(pink.r) / 255;
  v[8] = float(pink.g) / 255;
  v[9] = float(pink.b) / 255;
  v[10] = pc::q3(alphaQ3(.9f * tone));
  v[11] = float(pinkDeep.r) / 255;
  v[12] = float(pinkDeep.g) / 255;
  v[13] = float(pinkDeep.b) / 255;
  v[14] = pc::q3(alphaQ3(.85f * tone));
  v[15] = x;
  v[16] = y;
  v[17] = dir;
  v[18] = R;
  if (!((config.stamps & (1u << 4)) && pc::stamp(h, 3, v, 19))) {
    if (error)
      return fail(error);
    if (!pc::save(h) || !pc::translate(h, x, y) || !pc::rotate(h, dir))
      return fail(error ? error : 83);
    auto g = pc::radial(h, R * .3f, -R * .2f, 0, 0, 0, R * 1.3f);
    pc::stop(g, 0, color(pink, .9f * tone));
    pc::stop(g, 1, color(pinkDeep, .85f * tone));
    pc::begin(h);
    const bool ok = pc::ellipse(h, R * .4f, 0, R * 1.05f, R * .75f, 0, 0, fm::tau) && pc::fill(h, g);
    pc::restore(h);
    if (!ok)
      return fail(error ? error : 83);
  }
  memset(v, 0, sizeof v);
  v[0] = x;
  v[1] = y;
  v[2] = dir;
  v[3] = 1;
  v[4] = R;
  v[5] = 1;
  v[7] = 1;
  v[12] = float(inkJA.r) / 255;
  v[13] = float(inkJA.g) / 255;
  v[14] = float(inkJA.b) / 255;
  v[15] = pc::q3(alphaQ3(.85f * tone));
  if (!((config.stamps & (1u << 4)) && pc::stamp(h, 2, v, 16))) {
    if (error)
      return fail(error);
    if (!pc::save(h) || !pc::translate(h, x, y) || !pc::rotate(h, dir))
      return fail(error ? error : 83);
    pc::begin(h);
    pc::move(h, -R * .75f, 0);
    pc::quadratic(h, -R * .2f, -R * .6f, R * .05f, -R * .35f);
    pc::quadratic(h, -R * .1f, 0, R * .05f, R * .35f);
    pc::quadratic(h, -R * .2f, R * .6f, -R * .75f, 0);
    const bool ok = pc::fill(h, pc::solid(color(inkJA, .85f * tone)));
    pc::restore(h);
    if (!ok)
      return fail(error ? error : 83);
  }
  objectEnd(h);
  return !error;
}
inline bool flower(Word h, float x, float y, float R, float rot, Random& r, float S, float tone, bool outline) {
  const Word state = r.state();
  for (Word i = 0; i < 15; i++)
    r.raw();
  const Word n = 7 + r.bucket(5);
  for (Word i = 0; i < 3 * n; i++)
    r.raw();
  objectBegin(h, 2);
  const isolated_flower::Input in{x, y, R, rot, S, tone, 1, logicalPen, outline, (config.stamps & (1u << 5)) != 0};
  const auto result = isolated_flower::draw(h, state, in);
  logicalPen.width = result.lineWidth;
  logicalPen.cap = 1;
  objectEnd(h);
  return result.status ? fail(result.status) : !error;
}
inline void normal(const pc::Path& p, Word i, float& nx, float& ny) {
  const Word a = i ? i - 1 : 0, b = i + 1 < p.n ? i + 1 : p.n - 1;
  const float dx = p.x[b] - p.x[a], dy = p.y[b] - p.y[a];
  float l = fm::hypot(dx, dy);
  if (!l)
    l = 1;
  nx = -dy / l;
  ny = dx / l;
}
inline pc::Path polyline(const float* xs, const float* ys, Word count, float step, float width, Word profile) {
  float lengths[400], total = 0;
  for (Word i = 1; i < count; i++) {
    lengths[i - 1] = fm::hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    total += lengths[i - 1];
  }
  const Word n = Word(fm::max(4, fm::ceil(total / step) + 1));
  if (n > 4096) {
    fail(70);
    return {0, nullptr, nullptr, nullptr};
  }
  float* xx = drawPoints;
  float* yy = xx + n;
  float* ww = yy + n;
  for (Word i = 0; i < n; i++) {
    const float s = float(i) / float(n - 1);
    float d = s * total;
    Word q = 0;
    while (q < count - 2 && d > lengths[q]) {
      d -= lengths[q];
      q++;
    }
    const float t = lengths[q] ? fm::min(1, d / lengths[q]) : 0;
    xx[i] = fm::lerp(xs[q], xs[q + 1], t);
    yy[i] = fm::lerp(ys[q], ys[q + 1], t);
    ww[i] = profile == 0 ? (width - width * .76f * fm::pow(s, .9f)) * (1 + .55f * fm::pow(1 - s, 7)) *
                               (.9f + .2f * noise.at(s * 11 + 3))
                         : (.6f + 1.1f * fm::sin(fm::pi * s)) * width;
  }
  return {n, xx, yy, ww};
}
struct GrowInput {
  float x, y, angle, length, width, width0, droop, yMax;
  Word depth;
};
inline bool growClose(const GrowInput& o, Random& r, float S) {
  auto& g = geometry;
  if (g.status)
    return false;
  const float step = 3 * S;
  const Word n = Word(fm::max(5, fm::ceil(o.length / step))), branch = g.addPath(n, o.depth);
  if (branch == NONE)
    return false;
  Path p = g.branches[branch].path;
  float* xs = g.x(p);
  float* ys = g.y(p);
  float* ws = g.w(p);
  float x = o.x, y = o.y, a = o.angle, turn = 0;
  int kink = int(fm::floor(r.range(.12f, .3f) * float(n)));
  const float so = r.r() * 500;
  Word m = 0;
  for (Word i = 0; i < n; i++) {
    const float s = float(i) / float(n - 1);
    if (i > 2 && y > o.yMax)
      break;
    xs[m] = x;
    ys[m] = y;
    ws[m] = fm::max(.55f * S, o.width * (1 - .82f * fm::pow(s, .8f)));
    m++;
    a += (noise.at(so + s * 5) - .5f) * .07f +
         fm::sin(fm::pi * .5f - a) * o.droop * .005f * (1 - o.width / (o.width0 ? o.width0 : o.width) * .5f);
    if (--kink <= 0) {
      turn = (r.r() - .5f) * .11f;
      kink = int(fm::floor(r.range(.12f, .3f) * float(n)));
    }
    a += turn;
    turn *= .84f;
    x += fm::cos(a) * step;
    y += fm::sin(a) * step;
  }
  if (m < 3) {
    g.branchCount--;
    g.pointFloats = p.first;
    return true;
  }
  if (m != n) {
    for (Word i = 0; i < m; i++)
      g.points[p.first + m + i] = ys[i];
    for (Word i = 0; i < m; i++)
      g.points[p.first + 2 * m + i] = ws[i];
    g.pointFloats = p.first + 3 * m;
    g.branches[branch].path.n = m;
    p.n = m;
    ys = g.y(p);
    ws = g.w(p);
  }
  if (o.depth < 3) {
    const Word kids = o.depth == 0 ? 4 + r.bucket(3) : 1 + r.bucket(3);
    for (Word k = 0; k < kids; k++) {
      const float s = r.range(.16f, .95f);
      const Word i = Word(fm::min(float(m - 1), fm::floor(s * float(m - 1)))), i0 = i ? i - 1 : 0,
                 i1 = i + 1 < m ? i + 1 : m - 1;
      const float dir = atan2(ys[i1] - ys[i0], xs[i1] - xs[i0]), side = r.chance(1, 2) ? -1.f : 1.f,
                  angle = dir + side * r.range(.4f, 1);
      const float length = o.length * r.range(.28f, .56f) * (1.05f - .5f * s), width = ws[i] * r.range(.42f, .62f);
      if (!growClose({xs[i], ys[i], angle, length, width, o.width0 ? o.width0 : o.width, o.droop, o.yMax, o.depth + 1},
                     r, S))
        return false;
    }
  }
  if (o.depth >= 1) {
    for (Word i = Word(fm::floor(float(m) * .3f)); i < m; i += 2 + r.bucket(6))
      if (r.chance(55, 100))
        g.bloom(xs[i], ys[i], o.depth);
    g.bloom(xs[m - 1], ys[m - 1], o.depth, 1);
  }
  return !g.status;
}
inline void span(Path p, float pad, float& a, float& b) {
  a = 1e30f;
  b = -1e30f;
  const float* xs = geometry.x(p);
  const float* ws = geometry.w(p);
  for (Word i = 0; i < p.n; i++) {
    a = fm::min(a, xs[i] - ws[i]);
    b = fm::max(b, xs[i] + ws[i]);
  }
  a -= pad;
  b += pad;
}
inline bool pathStroke(ClosePlan& p, Word kind, float z, Path path, float pad, Word seed, float S, float tone,
                       Word depth, bool trunk) {
  float a, b;
  span(path, pad, a, b);
  const Word prefix = kind == Brush ? 5 : 2, n = path.n * 3 + prefix;
  if (n > maxCloseFloats - p.dataCount)
    return fail(80);
  float meta[5] = {float(path.n), S, tone, float(depth), trunk ? 1.f : 0};
  const Word at = p.dataCount;
  if (!add(p, kind, z, a, b, seed, meta, prefix))
    return false;
  auto& stroke = p.strokes[p.strokeCount - 1];
  memcpy(p.data + p.dataCount, geometry.points + path.first, path.n * 12);
  p.dataCount += path.n * 3;
  stroke.count = n;
  stroke.first = at;
  return true;
}
inline bool blossom(ClosePlan& p, float z0, float tone, Random& r, float U, float S, float k, bool trunk) {
  auto& g = geometry;
  for (Word i = g.bloomCount; i > 1; i--) {
    const Word j = r.bucket(i);
    const Bloom b = g.blooms[i - 1];
    g.blooms[i - 1] = g.blooms[j];
    g.blooms[j] = b;
  }
  for (Word i = 0; i < g.bloomCount; i += 5) {
    const auto b = g.blooms[i];
    const float rx = r.range(.035f, .07f) * U * k, ry = rx * r.range(.55f, .8f);
    const bool pale = r.chance(1, 2);
    const float a = r.range(.07f, .13f) * tone;
    const float data[6] = {b.x, b.y + 4 * S, rx, ry, pale ? 1.f : 0, a};
    if (!add(p, Wash, z0, b.x - rx, b.x + rx, 0, data, 6))
      return false;
  }
  Word order[maxCellBranches];
  for (Word i = 0; i < g.branchCount; i++) {
    Word at = i;
    while (at && g.branches[order[at - 1]].depth > g.branches[i].depth) {
      order[at] = order[at - 1];
      at--;
    }
    order[at] = i;
  }
  for (Word q = 0; q < g.branchCount; q++) {
    const Branch b = g.branches[order[q]];
    const bool tr = b.depth == 0 && trunk;
    const Word sd = r.seedOf();
    if (!pathStroke(p, Brush, z0 + 1 + float(b.depth) * .01f, b.path, 18 * S, sd, S, tone, b.depth, tr))
      return false;
    if (b.depth <= 1 && tone > .7f) {
      const Word seed = r.seedOf();
      if (!pathStroke(p, Moss, z0 + 2, b.path, 12 * S, seed, S, tone, b.depth, false))
        return false;
    }
  }
  if (trunk) {
    const Word seed = r.seedOf();
    if (!pathStroke(p, Bark, z0 + 2, g.branches[0].path, 4 * S, seed, S, tone, 0, true))
      return false;
  }
  for (Word q = 0; q < g.bloomCount; q++) {
    const auto b = g.blooms[q];
    const Word n = b.tip ? 3 + r.bucket(4) : 2 + r.bucket(3);
    const float base = 13 * S * k * (b.depth >= 3 ? .86f : 1);
    const Word seed = r.seedOf();
    const float e = 3 * base, data[6] = {b.x, b.y, float(n), base, tone, S};
    if (!add(p, Cluster, z0 + 3, b.x - e, b.x + e, seed, data, 6))
      return false;
  }
  return true;
}
inline bool bough(ClosePlan& p, float x, bool near, Random& r, float U, float S, float k) {
  geometry.reset();
  const float side = r.chance(55, 100) ? -1.f : 1.f, f = near ? 1.f : .7f;
  const float angle = fm::pi * .5f - side * r.range(.7f, 1.15f), length = r.range(.4f, .72f) * U * f,
              width = r.range(8, 12) * S * k * f, droop = r.range(.5f, 1.1f);
  if (!growClose({x, -.09f * U, angle, length, width, 0, droop, U * (near ? .44f : .38f), 0}, r, S))
    return fail(geometry.status ? geometry.status : 80);
  return !geometry.branchCount || blossom(p, near ? 4 : 0, near ? 1 : .55f, r, U, S, k * f, false);
}
inline bool trunk(ClosePlan& p, float x, Random& r, float U, float S, float k) {
  geometry.reset();
  const float side = r.chance(1, 2) ? -1.f : 1.f, so = r.r() * 50, st = 22 * S, turnAt = r.range(.4f, .5f) * U,
              reach = r.range(.4f, .7f) * U * k;
  float xs[301], ys[301], tx = x, ty = 1.07f * U;
  Word count = 0;
  for (Word q = 0; q < 300; q++) {
    xs[count] = tx;
    ys[count++] = ty;
    const float e = fm::smooth(0, 1, fm::clamp((turnAt - ty) / (.3f * U), 0, 1));
    const float a =
        (side > 0 ? fm::lerp(-fm::pi * .5f - .05f, -.17f, e) : fm::lerp(-fm::pi * .5f + .05f, -fm::pi + .17f, e)) +
        (noise.at(so + float(q) * .28f) - .5f) * .34f;
    tx += fm::cos(a) * st;
    ty += fm::sin(a) * st;
    if (fm::abs(tx - x) > reach || ty < .06f * U)
      break;
  }
  xs[count] = tx;
  ys[count++] = ty;
  const float width = r.range(20, 26) * S * k;
  const auto sample = polyline(xs, ys, count, 3 * S, width, 0);
  if (error)
    return false;
  const Word index = geometry.addPath(sample.n, 0);
  if (index == NONE)
    return fail(geometry.status);
  const Path TP = geometry.branches[index].path;
  memcpy(geometry.points + TP.first, drawPoints, sample.n * 12);
  const float* px = geometry.x(TP);
  const float* py = geometry.y(TP);
  const float* pw = geometry.w(TP);
  const Word nl = 5 + r.bucket(3);
  for (Word q = 0; q < nl; q++) {
    const float s = r.range(.42f, .97f);
    const Word i = Word(fm::min(float(TP.n - 2), fm::floor(s * float(TP.n - 1))));
    const float dir = atan2(py[i + 1] - py[i], px[i + 1] - px[i]);
    const bool up = r.chance(45, 100);
    const float angle = dir + (up ? -1.f : 1.f) * side * r.range(.45f, 1.05f),
                length = r.range(.17f, .32f) * U * k * (1.1f - .4f * s), w = pw[i] * r.range(.4f, .6f);
    if (!growClose({px[i], py[i], angle, length, w, 0, up ? .5f : 1.3f, U * .42f, 1}, r, S))
      return fail(geometry.status ? geometry.status : 80);
  }
  for (Word i = Word(fm::floor(float(TP.n) * .55f)); i < TP.n; i += 3 + r.bucket(5))
    if (r.chance(3, 5))
      geometry.bloom(px[i], py[i], 2);
  if (geometry.status)
    return fail(geometry.status);
  return blossom(p, 4, 1, r, U, S, k, true);
}
inline bool fallen(Word h, const float* d, Random& r) {
  const float x = d[0], y = d[1], U = d[2], S = d[3], rx = r.range(.06f, .12f) * U, ry = r.range(.01f, .02f) * U,
              a = r.range(.1f, .18f);
  ellipseBlob(h, x, y, rx, ry, pink, a);
  if (error)
    return false;
  const Word n = 10 + r.bucket(14);
  for (Word i = 0; i < n; i++) {
    const float xx = x + r.range(-.1f, .1f) * U, yy = y + r.range(-.02f, .012f) * U, rot = r.r() * fm::tau,
                sy = r.range(.35f, .75f), R = r.range(5, 9) * S;
    const Word c = r.bucket(3);
    const float alpha = r.range(.45f, .85f);
    petalFill(h, xx, yy, rot, sy, R, c == 0 ? pink : c == 1 ? sakuraHaze : pinkPale, alpha);
    if (error)
      return false;
  }
  return true;
}
inline bool moss(Word h, const pc::Path& p, Random& r, float S) {
  for (Word i = 4; i + 4 < p.n; i += 6 + r.bucket(16)) {
    if (r.chance(1, 2))
      continue;
    float nx, ny;
    normal(p, i, nx, ny);
    const float side = r.chance(1, 2) ? -1.f : 1.f, off = p.w[i] * r.range(.55f, 1.1f) * side, x = p.x[i] + nx * off,
                y = p.y[i] + ny * off;
    const Word n = 1 + r.bucket(3);
    for (Word j = 0; j < n; j++) {
      const float rad = r.range(.9f, 2.3f) * S, a = r.range(.7f, .95f), xx = x + r.range(-3, 3) * S,
                  yy = y + r.range(-3, 3) * S, rx = rad * r.range(.7f, 1.35f), rot = r.r() * fm::tau;
      pc::begin(h);
      if (!pc::ellipse(h, xx, yy, rx, rad, rot, 0, fm::tau) || !pc::fill(h, pc::solid(color(inkJA, a))))
        return fail(error ? error : 83);
    }
  }
  return true;
}
inline bool bark(Word h, const pc::Path& p, Random& r, float S) {
  ribbon(h, p.x, p.y, p.w, p.n, .25f, .97f);
  if (!pc::fill(h, pc::solid(color(inkJA, .22f))))
    return fail(error ? error : 83);
  for (Word i = 3; i + 3 < p.n; i += 2 + r.bucket(5)) {
    if (r.chance(35, 100))
      continue;
    float nx, ny;
    normal(p, i, nx, ny);
    const float c = r.range(-.55f, .45f), span = r.range(.25f, .6f);
    float xs[7], ys[7];
    for (Word q = 0; q < 7; q++) {
      const float u = c + (float(q) / 6 - .5f) * span;
      xs[q] = p.x[i] + nx * u * p.w[i];
      ys[q] = p.y[i] + ny * u * p.w[i] + fm::sin(float(q) / 6 * fm::pi) * 1.2f * S;
    }
    const auto Q = polyline(xs, ys, 7, 1.5f * S, S, 1);
    if (error)
      return false;
    const float a = r.range(.45f, .85f);
    ribbon(h, Q.x, Q.y, Q.w, Q.n, -1, 1);
    if (!pc::fill(h, pc::solid(color(inkJA, a))))
      return fail(error ? error : 83);
  }
  return true;
}
inline bool cluster(Word h, const float* d, Random& r) {
  const Word n = Word(d[2]);
  const float base = d[3], tone = d[4], S = d[5];
  for (Word i = 0; i < n; i++) {
    const float angle = r.r() * fm::tau, distance = r.range(.25f, 1.7f) * base, x = d[0] + fm::cos(angle) * distance,
                y = d[1] + fm::sin(angle) * distance;
    const Word choice = r.raw();
    const float R = base * r.range(.75f, 1.2f), t = r.range(.8f, 1) * tone;
    if (Wide(choice) * 5 < (Wide(3) << 32)) {
      const float rot = r.r() * fm::tau;
      const bool outline = r.chance(1, 2);
      if (!flower(h, x, y, R, rot, r, S, t, outline))
        return false;
    } else if (Wide(choice) * 50 < (Wide(41) << 32)) {
      if (!half(h, x, y, R, atan2(y - d[1], x - d[0]), r, S, t))
        return false;
    } else if (!bud(h, x, y, R * .42f, atan2(y - d[1], x - d[0]), t))
      return false;
  }
  return true;
}
} // namespace close_sakura
} // namespace painter

namespace painter {
inline bool planSakura(ClosePlan& p, int j, Random& r) {
  const float U = config.H, S = U / 900, k = config.kc, cw = .8f * U * k * k;
  Random station(cellSeed(7777, 3, j));
  float x = (float(j) + station.range(.2f, .8f)) * cw;
  const Word choice = station.raw();
  Word kind;
  float v;
  Word full = 0;
  if (float(j) == fm::floor(config.hero / cw)) {
    x = config.hero;
    kind = 0;
    v = .4f;
  } else {
    kind = stationKind(j);
    (void)choice;
    v = station.r();
  }
  if (config.jaTop > -1e8f) {
    const float top = fm::floor(config.jaTop / cw);
    float right = fm::floor(config.jaRight / cw), rx = config.jaRight;
    if (right == top) {
      right = top + 1;
      rx = fm::max(rx, (top + 1.1f) * cw);
    }
    if (float(j) == top) {
      x = config.jaTop;
      kind = 1;
      v = .9f;
      full = 2;
    } else if (float(j) == right) {
      x = rx;
      kind = 0;
      v = .4f;
    } else if (float(j) == top - 1) {
      kind = 1;
      v = .9f;
      full = 1;
    }
  }
  const Word patches = r.chance(3, 5) ? 1 : 2;
  for (Word q = 0; q < patches; q++)
    if (r.chance(7, 10)) {
      const float gx = (float(j) + r.r()) * cw, gy = U * r.range(1, 1.03f);
      const Word seed = r.seedOf();
      const float data[4] = {gx, gy, U, S * k};
      if (!close_sakura::add(p, close_sakura::Fallen, 3, gx - .16f * U, gx + .16f * U, seed, data, 4))
        return false;
    }
  if (kind == 0 && v < .5f)
    return close_sakura::trunk(p, x, r, U, S, k);
  if (kind == 2)
    return close_sakura::bough(p, x, false, r, U, S, k);
  if (full) {
    for (int q = -1; q <= 1; q += 2) {
      const Word n = full == 2 ? 1 + r.bucket(2) : r.chance(7, 10) ? 1 : 0;
      for (Word i = 0; i < n; i++) {
        const float offset = i ? r.range(.3f, .46f) : r.range(.12f, .28f);
        if (!close_sakura::bough(p, x + offset * float(q) * U * k, false, r, U, S, k))
          return false;
      }
    }
  } else if (r.chance(35, 100)) {
    const float offset = r.range(.1f, .3f), side = r.chance(1, 2) ? -1.f : 1.f;
    if (!close_sakura::bough(p, x + offset * side * U * k, false, r, U, S, k))
      return false;
  }
  return close_sakura::bough(p, x, true, r, U, S, k);
}
inline bool drawSakuraStroke(Word h, const Stroke& stroke, const float* data) {
  using namespace close_sakura;
  Random r(stroke.seed);
  if (stroke.kind == Wash) {
    if (stroke.count != 6)
      return fail(83);
    ellipseBlob(h, data[0], data[1], data[2], data[3], data[4] ? pinkPale : pink, data[5]);
    return !error;
  }
  if (stroke.kind == Fallen) {
    if (stroke.count != 4)
      return fail(83);
    return fallen(h, data, r);
  }
  if (stroke.kind == Cluster) {
    if (stroke.count != 6 || data[2] < 2 || data[2] > 6)
      return fail(83);
    return cluster(h, data, r);
  }
  const Word prefix = stroke.kind == Brush ? 5 : 2, n = Word(data[0]);
  if (n < 3 || n > 4096 || stroke.count != prefix + n * 3)
    return fail(83);
  const pc::Path path{n, data + prefix, data + prefix + n, data + prefix + 2 * n};
  const float S = data[1];
  if (stroke.kind == Moss)
    return moss(h, path, r, S);
  if (stroke.kind == Bark)
    return bark(h, path, r, S);
  if (stroke.kind != Brush)
    return fail(83);
  const Word depth = Word(data[3]);
  const bool tr = data[4] != 0;
  const float tones[4] = {.9f, .86f, .8f, .74f};
  bool wet = false;
  if (config.stamps & (1u << 5)) {
    if (inkStroke(h, path, stroke.seed, S, (tr ? .9f : depth < 4 ? tones[depth] : .7f) * data[2] * .62f) == 2)
      return fail(error ? error : 83);
    wet = true;
  }
  pc::Brush b = {};
  b.col[0] = float(inkJA.r) / 255;
  b.col[1] = float(inkJA.g) / 255;
  b.col[2] = float(inkJA.b) / 255;
  b.alpha = (tr ? .9f : depth < 4 ? tones[depth] : .7f) * data[2];
  b.body = tr ? .5f : .58f;
  if (wet) {
    b.alpha *= .55f;
    b.body *= .5f;
  }
  b.edge = tr ? .8f : .65f;
  b.streak = .55f;
  b.dry = tr ? .32f : depth < 2 ? .4f : .2f;
  b.tail = tr ? 0 : .3f;
  b.head = tr ? .12f : 0;
  b.seed = stroke.seed;
  b.cover = 1.6f;
  b.unit = (tr ? 110 : 60) * S;
  for (Word q = 0; q < 9; q++)
    dryGrid[q] = tr ? .7f : .4f + .6f * float(q) / 8;
  b.dryGrid = dryGrid;
  return pc::brush(h, path, b) ? !error : fail(error ? error : 83);
}
} // namespace painter
