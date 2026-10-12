#pragma once
#include "canvas.hpp"
#include "geometry.hpp"
#include "common.hpp"

namespace painter {
namespace bamboo {
constexpr ColorBytes ink{21, 31, 25}, leafInk{21, 31, 25}, farInk{100, 121, 108}, midInk{57, 75, 63},
    midStalk{57, 75, 63};
struct Tone {
  ColorBytes dark, pale;
  float d0, d1, p0, p1;
  Word paleMin, paleSpan;
  float rim, dry, paleDry;
};
constexpr Tone nearTone{{21, 31, 25}, {21, 31, 25}, .42f, .60f, .11f, .20f, 2, 2, .17f, .35f, .3f};
constexpr Word maxNodes = 64, maxLeaves = 12, maxSprays = 24, maxPath = 4096;
struct Leaf {
  float angle, length, width, bend, asym, tone, ox, oy;
  Word light;
};
struct Stalk {
  float x, yb, yt, hw, lean, bow, seg, alpha, curve, taper = .22f;
};
struct StalkPlan {
  float nodes[maxNodes];
  Word n = 0;
};
struct Spray {
  float x, y, ex, ey;
  Leaf leaves[maxLeaves];
  Word n;
};
struct Workspace {
  float x[maxPath], y[maxPath], w[maxPath], dry[maxPath];
  float lengths[4], px[4], py[4], selected[maxNodes];
  Leaf leaves[maxLeaves];
  Spray sprays[maxSprays];
};
static Workspace work;

inline bool fail(Word code) {
  if (!cellStatus)
    cellStatus = code;
  if (!error)
    error = code;
  return false;
}
inline bool ok(Word value) {
  return value && !error && !cellStatus ? true : fail(error ? error : 80);
}
inline float atan(float x) {
  return painter::atan2(x, 1);
}
inline float ground(Word li, float x) {
  if (li == 0)
    return .61f + .035f * (2 * noise.at(x * 1.3f + 11) - 1) + .012f * (2 * noise.at(x * 4.1f + 3) - 1);
  if (li == 1)
    return .83f + .045f * (2 * noise.at(x * .85f + 37) - 1) + .012f * (2 * noise.at(x * 3.3f + 9) - 1);
  return 1.03f + .03f * (2 * noise.at(x * .6f + 71) - 1);
}
inline float grove(Word li, float x) {
  return li == 0 ? fm::smooth(.12f, .55f, noise.at(x * 1.6f + 17)) : fm::smooth(.2f, .62f, noise.at(x * 1.1f + 41));
}
inline float near(float x) {
  float d = fm::max(fm::smooth(.42f, .68f, noise.at(x * 1.25f + 63)), clumpFloor(x, 0));
  const float across = (x * config.H - config.zhMid) / config.W + .72f;
  if (across > -.4f && across < 1.4f) {
    const float left = fm::abs(across - .17f) / .2f, right = fm::abs(across - .84f) / .15f;
    if (left < 1)
      d *= 1 - .85f * fm::smooth(1, .4f, left);
    if (right < 1)
      d = fm::max(d, fm::smooth(1, .4f, right));
    d *= 1 - fm::smooth(.28f, .33f, across) * fm::smooth(.72f, .67f, across);
  }
  return d;
}
inline float tall(Word li, float x) {
  return .62f + .5f * noise.at(x * (li == 0 ? 3.1f : 2.2f) + (li == 0 ? 5 : 29));
}
inline v128_t seventh(v128_t x) {
  const auto a = wasm_f32x4_mul(x, x), b = wasm_f32x4_mul(a, a);
  return wasm_f32x4_mul(wasm_f32x4_mul(b, a), x);
}
inline v128_t stalkX4(const Stalk& o, v128_t y) {
  const auto d = wasm_f32x4_sub(wasm_f32x4_splat(o.yb), y);
  const auto s = wasm_f32x4_div(d, wasm_f32x4_splat(o.yb - o.yt));
  const auto q = wasm_f32x4_min(wasm_f32x4_splat(1), wasm_f32x4_max(wasm_f32x4_splat(0), s));
  const auto sin =
      wasm_f32x4_make(fm::sin(wasm_f32x4_extract_lane(q, 0) * fm::pi), fm::sin(wasm_f32x4_extract_lane(q, 1) * fm::pi),
                      fm::sin(wasm_f32x4_extract_lane(q, 2) * fm::pi), fm::sin(wasm_f32x4_extract_lane(q, 3) * fm::pi));
  return wasm_f32x4_add(
      wasm_f32x4_add(
          wasm_f32x4_add(wasm_f32x4_splat(o.x), wasm_f32x4_mul(wasm_f32x4_splat(o.lean), d)),
          wasm_f32x4_div(wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_splat(o.bow), d), d), wasm_f32x4_splat(o.yb - o.yt))),
      wasm_f32x4_mul(wasm_f32x4_splat(o.curve * o.hw), sin));
}
inline float stalkX(const Stalk& o, float y) {
  return wasm_f32x4_extract_lane(stalkX4(o, wasm_f32x4_splat(y)), 0);
}
inline float stalkTilt(const Stalk& o, float y) {
  return atan((stalkX(o, y - 1) - stalkX(o, y + 1)) * .5f);
}
inline bool stalkPlan(const Stalk& o, Random& r, StalkPlan& p) {
  p.n = 0;
  if (!(o.seg > 0 && o.yb > o.yt && o.hw > 0))
    return fail(81);
  float y = o.yb + r.range(0, .7f) * o.seg;
  p.nodes[p.n++] = y;
  while (y > o.yt) {
    if (p.n == maxNodes)
      return fail(82);
    y -= o.seg * r.range(.88f, 1.12f);
    p.nodes[p.n++] = y;
  }
  return true;
}
inline pc::Path path(Word n) {
  return {n, work.x, work.y, work.w, work.dry};
}
inline bool brush(Word h, Word n, ColorBytes col, float alpha, Word seed, float body, float edge, float streak,
                  float tail, float head = 0, float dry = 0, float cover = 1.7f, float bw = 0, float unit = 0,
                  Word dryMode = 0) {
  if (n < 2 || n > maxPath)
    return fail(83);
  pc::Brush b = {};
  b.col[0] = float(col.r);
  b.col[1] = float(col.g);
  b.col[2] = float(col.b);
  b.alpha = alpha;
  b.seed = seed;
  b.body = body;
  b.edge = edge;
  b.streak = streak;
  b.tail = tail;
  b.head = head;
  b.dry = dry;
  b.cover = cover;
  b.bw = bw;
  b.unit = unit;
  float grid[9];
  for (Word q = 0; q <= 8; q++) {
    const float at = float(q) / 8;
    grid[q] = dryMode == 1 ? fm::smooth(.3f, 1, at) : dryMode == 2 ? fm::smooth(.7f, 0, at) : 1;
  }
  b.dryGrid = grid;
  return ok(pc::brush(h, path(n), b));
}
inline bool polygon4(Word h, const pc::Paint& paint, float x0, float y0, float x1, float y1, float x2, float y2,
                     float x3, float y3) {
  pc::begin(h);
  return ok(pc::move(h, x0, y0)) && ok(pc::line(h, x1, y1)) && ok(pc::line(h, x2, y2)) && ok(pc::line(h, x3, y3)) &&
         ok(pc::close(h)) && ok(pc::fill(h, paint));
}
inline bool blob(Word h, float x, float y, float rx, float ry, ColorBytes col, float a) {
  if (!(rx > 0 && ry > 0))
    return fail(81);
  if (!ok(pc::save(h)) || !ok(pc::translate(h, x, y)) || !ok(pc::scale(h, 1, ry / rx)))
    return false;
  auto p = pc::radial(h, 0, 0, 0, 0, 0, rx);
  pc::stop(p, 0, color(col, a));
  pc::stop(p, .55f, color(col, a * .55f));
  pc::stop(p, 1, color(col, 0));
  const bool result = ok(pc::fillRect(h, p, 1, -rx, -rx, rx * 2, rx * 2));
  pc::restore(h);
  return result;
}
inline bool leafPath(Word h, float x, float y, float angle, float len, float wid, float bend, float asym) {
  const float ca = fm::cos(angle), sa = fm::sin(angle);
  float up[34], lo[34];
  for (Word i = 0; i <= 16; i++) {
    const float s = float(i) / 16, cx = s * len, cy = bend * len * s * s, dy = 2 * bend * len * s,
                dl = fm::hypot(len, dy);
    if (!(dl > 0))
      return fail(81);
    const float nx = -dy / dl, ny = len / dl,
                half = wid * fm::pow(fm::max(0, fm::sin(fm::pi * fm::pow(.035f + .965f * s, .62f))), 1.08f);
    up[i * 2] = cx + nx * half * (1 + asym);
    up[i * 2 + 1] = cy + ny * half * (1 + asym);
    lo[i * 2] = cx - nx * half * (1 - asym);
    lo[i * 2 + 1] = cy - ny * half * (1 - asym);
  }
  for (Word i = 0; i < 16; i += 4) {
    const auto ux = wasm_f32x4_make(up[i * 2], up[(i + 1) * 2], up[(i + 2) * 2], up[(i + 3) * 2]);
    const auto uy = wasm_f32x4_make(up[i * 2 + 1], up[(i + 1) * 2 + 1], up[(i + 2) * 2 + 1], up[(i + 3) * 2 + 1]);
    const auto lx = wasm_f32x4_make(lo[i * 2], lo[(i + 1) * 2], lo[(i + 2) * 2], lo[(i + 3) * 2]);
    const auto ly = wasm_f32x4_make(lo[i * 2 + 1], lo[(i + 1) * 2 + 1], lo[(i + 2) * 2 + 1], lo[(i + 3) * 2 + 1]);
    float qx[4], qy[4];
    wasm_v128_store(qx, wasm_f32x4_sub(wasm_f32x4_add(wasm_f32x4_splat(x), wasm_f32x4_mul(ux, wasm_f32x4_splat(ca))),
                                       wasm_f32x4_mul(uy, wasm_f32x4_splat(sa))));
    wasm_v128_store(qy, wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_splat(y), wasm_f32x4_mul(ux, wasm_f32x4_splat(sa))),
                                       wasm_f32x4_mul(uy, wasm_f32x4_splat(ca))));
    for (Word q = 0; q < 4; q++) {
      up[(i + q) * 2] = qx[q];
      up[(i + q) * 2 + 1] = qy[q];
    }
    wasm_v128_store(qx, wasm_f32x4_sub(wasm_f32x4_add(wasm_f32x4_splat(x), wasm_f32x4_mul(lx, wasm_f32x4_splat(ca))),
                                       wasm_f32x4_mul(ly, wasm_f32x4_splat(sa))));
    wasm_v128_store(qy, wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_splat(y), wasm_f32x4_mul(lx, wasm_f32x4_splat(sa))),
                                       wasm_f32x4_mul(ly, wasm_f32x4_splat(ca))));
    for (Word q = 0; q < 4; q++) {
      lo[(i + q) * 2] = qx[q];
      lo[(i + q) * 2 + 1] = qy[q];
    }
  }
  const float ux = up[32], uy = up[33], lx = lo[32], ly = lo[33];
  up[32] = x + ux * ca - uy * sa;
  up[33] = y + ux * sa + uy * ca;
  lo[32] = x + lx * ca - ly * sa;
  lo[33] = y + lx * sa + ly * ca;
  pc::begin(h);
  if (!ok(pc::move(h, up[0], up[1])))
    return false;
  for (Word i = 1; i <= 16; i++)
    if (!ok(pc::line(h, up[i * 2], up[i * 2 + 1])))
      return false;
  for (int i = 16; i >= 0; i--)
    if (!ok(pc::line(h, lo[i * 2], lo[i * 2 + 1])))
      return false;
  return ok(pc::close(h));
}
inline bool leaf(Word h, float x, float y, float angle, float len, float wid, float bend, float asym, ColorBytes col,
                 float alpha, Word mode, Word family = 6, bool emit = true, float seed = 0, float rim = 0,
                 float dry = 0) {
  objectBegin(h, family);
  bool result = true;
  if (error || cellStatus)
    return false;
  if (emit) {
    if (config.stamps & (1u << (family == 7 ? 7 : 6))) {
      float v[16] = {x,
                     y,
                     angle,
                     len,
                     wid,
                     bend,
                     mode == 2 ? .06f : asym,
                     float(mode),
                     float(col.r) / 255,
                     float(col.g) / 255,
                     float(col.b) / 255,
                     mode == 1   ? pc::q3(alphaQ3(alpha))
                     : mode == 2 ? fm::clamp(alpha, 0, 1)
                                 : alpha,
                     fm::clamp(seed, 0, .999f),
                     .6f * config.H / 900,
                     fm::clamp(rim, 0, 1),
                     fm::clamp(dry, 0, 1)};
      const Word stamped = pc::stamp(h, 5, v, mode == 2 ? 16 : 12);
      if (stamped) {
        objectEnd(h);
        return !error && !cellStatus;
      }
      if (error || cellStatus) {
        objectEnd(h);
        return fail(error ? error : 80);
      }
    }
    result = leafPath(h, x, y, angle, len, wid, bend, asym);
    if (result && mode == 0) {
      auto g = pc::linear(h, x, y, x + fm::cos(angle) * len, y + fm::sin(angle) * len);
      pc::stop(g, 0, color(col, alpha));
      pc::stop(g, .45f, color(col, alpha * .93f));
      pc::stop(g, 1, color(col, alpha * .62f));
      result = ok(pc::fill(h, g)) && leafPath(h, x + fm::cos(angle) * len * .04f, y + fm::sin(angle) * len * .04f,
                                              angle, len * .8f, wid * .55f, bend, asym * .6f);
      if (result)
        result = ok(pc::fill(h, pc::solid(color(col, alpha * .1f))));
    } else if (result)
      result = ok(pc::fill(h, pc::solid(color(col, alpha))));
  }
  objectEnd(h);
  return result && !error && !cellStatus;
}
struct Group {
  Word source = 0;
  float rect[4] = {};
  bool visible = false;
};
inline bool groupBegin(Word h, const float* box, Group& g) {
  const auto& c = canvases[h - 1];
  const float* m = c.s.m;
  if (fm::abs(m[1]) > 1e-7f || fm::abs(m[2]) > 1e-7f || m[0] <= 0 || m[3] <= 0)
    return fail(84);
  const float x0 = fm::clamp(fm::floor(box[0] * m[0] + m[4]) - 3, 0, float(c.w)),
              y0 = fm::clamp(fm::floor(box[1] * m[3] + m[5]) - 3, 0, float(c.h));
  const float x1 = fm::clamp(fm::ceil(box[2] * m[0] + m[4]) + 3, 0, float(c.w)),
              y1 = fm::clamp(fm::ceil(box[3] * m[3] + m[5]) + 3, 0, float(c.h));
  g.rect[0] = x0;
  g.rect[1] = y0;
  g.rect[2] = x1 - x0;
  g.rect[3] = y1 - y0;
  g.visible = g.rect[2] >= 1 && g.rect[3] >= 1;
  if (!g.visible)
    return true;
  g.source = scratchCanvas(c.w, c.h);
  if (!g.source)
    return fail(error ? error : 85);
  return ok(pc::setTransform(g.source, m));
}
inline bool groupEnd(Word h, const Group& g, float alpha) {
  if (!g.visible)
    return true;
  if (!ok(pc::save(h)) || !ok(pc::resetTransform(h)))
    return false;
  const bool result = ok(pc::drawImage(h, g.source, g.rect, g.rect, alpha));
  pc::restore(h);
  return result;
}
inline float wind(float angle, Random& r) {
  const float vx = fm::cos(angle) * .4f - .46f, vy = fm::sin(angle) * .4f + .66f + r.range(-.2f, .22f);
  return painter::atan2(vy, vx);
}
inline bool cluster(Word h, float ax, float ay, float x, float y, float base, Word n, float len, const Tone& t,
                    float alpha, Random& r, float S, bool close = false, bool spray = false) {
  if (!n || n > maxLeaves)
    return fail(86);
  const Word pale = spray ? r.bucket(2) : t.paleMin + r.bucket(t.paleSpan);
  for (Word pass = 0; pass < 2; pass++) {
    const Word count = pass ? n : pale;
    for (Word q = 0; q < count; q++) {
      const Word k = pass ? n - 1 - q : q + 1;
      const float jit = (pass ? 2 : 5) * S * (close ? 1 : .4f);
      const float f = k ? fm::clamp(1 - .6f * float(k) / float(n) * r.range(.7f, 1.2f), .25f, 1) : 1;
      const float lx = fm::lerp(ax, x, f) + r.range(-jit, jit), ly = fm::lerp(ay, y, f) + r.range(-jit, jit);
      const float angle = base + (k ? ((k & 1) ? 1.f : -1.f) * r.range(.21f, .91f) : 0) + r.range(-.1f, .1f);
      const float L = len * (pass ? 1 : r.range(.8f, 1.1f)) * (k ? r.range(.5f, .92f) : 1),
                  wid = L * r.range(.078f, .098f);
      const float tone = (pass ? r.range(t.d0, t.d1) : r.range(t.p0, t.p1)) * alpha,
                  bend = (fm::cos(angle) >= 0 ? 1 : -1) * r.range(0, .09f), seed = r.r();
      if (!close && L < 5 * S)
        continue;
      if (!leaf(h, lx, ly, angle, L, wid, bend, 0, pass ? t.dark : t.pale, tone, 2, 6, true, seed, t.rim,
                pass ? t.dry : t.paleDry))
        return false;
    }
  }
  return true;
}
inline bool poly(Word count, float width, float extra, float step) {
  if (count < 2 || count > 4 || !(step > 0))
    return fail(81);
  float total = 0;
  for (Word i = 1; i < count; i++) {
    work.lengths[i - 1] = fm::hypot(work.px[i] - work.px[i - 1], work.py[i] - work.py[i - 1]);
    total += work.lengths[i - 1];
  }
  const float countf = fm::max(4, fm::ceil(total / step) + 1);
  if (countf > float(maxPath))
    return fail(83);
  const Word n = Word(countf);
  Word q = 0;
  for (; q + 4 <= n; q += 4) {
    float xa[4], xb[4], ya[4], yb[4], tt[4], ss[4];
    for (Word lane = 0; lane < 4; lane++) {
      const float s = float(q + lane) / float(n - 1);
      float d = s * total;
      Word at = 0;
      while (at < count - 2 && d > work.lengths[at]) {
        d -= work.lengths[at];
        at++;
      }
      ss[lane] = s;
      tt[lane] = work.lengths[at] ? fm::min(1, d / work.lengths[at]) : 0;
      xa[lane] = work.px[at];
      xb[lane] = work.px[at + 1];
      ya[lane] = work.py[at];
      yb[lane] = work.py[at + 1];
    }
    const auto t = wasm_v128_load(tt), s = wasm_v128_load(ss);
    wasm_v128_store(
        work.x + q,
        wasm_f32x4_add(wasm_v128_load(xa), wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(xb), wasm_v128_load(xa)), t)));
    wasm_v128_store(
        work.y + q,
        wasm_f32x4_add(wasm_v128_load(ya), wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(yb), wasm_v128_load(ya)), t)));
    wasm_v128_store(work.w + q, wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_splat(width),
                                                              wasm_f32x4_sub(wasm_f32x4_splat(1),
                                                                             wasm_f32x4_mul(wasm_f32x4_splat(.6f), s))),
                                               wasm_f32x4_splat(extra)));
  }
  for (; q < n; q++) {
    const float s = float(q) / float(n - 1);
    float d = s * total;
    Word at = 0;
    while (at < count - 2 && d > work.lengths[at]) {
      d -= work.lengths[at];
      at++;
    }
    const float t = work.lengths[at] ? fm::min(1, d / work.lengths[at]) : 0;
    work.x[q] = fm::lerp(work.px[at], work.px[at + 1], t);
    work.y[q] = fm::lerp(work.py[at], work.py[at + 1], t);
    work.w[q] = width * (1 - .6f * s) + extra;
  }
  for (Word i = 0; i < n; i++)
    work.dry[i] = 1;
  return true;
}
inline Word polyCount(float step, Word count) {
  float total = 0;
  for (Word i = 0; i < count - 1; i++)
    total += work.lengths[i];
  return Word(fm::max(4, fm::ceil(total / step) + 1));
}
inline bool twig(Word h, float x, float y, float angle, float len, float width, ColorBytes col, float alpha, Random& r,
                 float S, float leafLen, float leafAlpha, bool close = false, const Tone& tone = nearTone) {
  const Word joints = 2 + r.bucket(2);
  float aa = angle, px = x, py = y;
  work.px[0] = x;
  work.py[0] = y;
  for (Word j = 0; j < joints; j++) {
    const float L = len / float(joints) * r.range(.75f, 1.25f);
    aa += (j % 2 ? 1 : -1) * r.range(.05f, .22f);
    px += fm::cos(aa) * L;
    py += fm::sin(aa) * L;
    work.px[j + 1] = px;
    work.py[j + 1] = py;
  }
  const float step = (close ? 3 : 2.5f) * S;
  if (!poly(joints + 1, width, (close ? .35f : .3f) * S, step))
    return false;
  const Word n = polyCount(step, joints + 1), seed = r.brushSeed();
  if (!brush(h, n, col, alpha, seed, .9f, .1f, .25f, .18f, 0, 0, 1.7f, 1.1f))
    return false;
  if (close)
    for (Word j = 1; j < joints; j++) {
      pc::begin(h);
      if (!ok(pc::ellipse(h, work.px[j], work.py[j], width * .95f, width * .55f, aa, 0, fm::tau)) ||
          !ok(pc::fill(h, pc::solid(color(col, alpha)))))
        return false;
    }
  for (Word j = 1; j <= joints; j++) {
    const bool end = j == joints;
    const float sa = painter::atan2(work.py[j] - work.py[j - 1], work.px[j] - work.px[j - 1]);
    const float base = wind(sa, r);
    const Word leaves = end ? 4 + r.bucket(2) : 2 + r.bucket(2);
    if (!cluster(h, work.px[j - 1], work.py[j - 1], work.px[j], work.py[j], base, leaves, leafLen * (end ? 1 : .75f),
                 tone, fm::min(1, leafAlpha), r, S, close, !end))
      return false;
  }
  return true;
}
inline bool grass(Word h, float x, float y, Random& r, float S, ColorBytes col, float alpha, bool close = false) {
  const Word n = (close ? 4 : 3) + r.bucket(close ? 6 : 5);
  for (Word i = 0; i < n; i++) {
    const float L = r.range(close ? 40.f : 14.f, close ? 125.f : 36.f) * S;
    float angle = -fm::pi * .5f - r.range(.05f, close ? .75f : .8f);
    if (r.chance(1, close ? 5 : 4))
      angle += r.range(close ? .4f : .3f, close ? .8f : .7f);
    const float xx = x + r.range(close ? -18.f : -7.f, close ? 18.f : 7.f) * S,
                wid = L * r.range(close ? .04f : .05f, close ? .065f : .08f);
    const float bend = -r.range(close ? .06f : .05f, close ? .28f : .25f), a = alpha * r.range(close ? .5f : .55f, 1);
    if (!leaf(h, xx, y, angle, L, wid, bend, 0, col, a, 1, 7))
      return false;
  }
  return true;
}
inline bool node(Word h, float x, float y, float hw, ColorBytes col, float alpha, Random& r, float S) {
  const float span = hw * r.range(1.06f, 1.2f);
  float arch = hw * r.range(.12f, .24f);
  arch *= r.chance(3, 4) ? 1 : -1;
  const float tilt = r.range(-.06f, .06f) * hw;
  for (Word i = 0; i < 18; i++) {
    const float s = float(i) / 17, u = 2 * s - 1;
    work.x[i] = x - span + s * 2 * span;
    work.y[i] = y + arch * (1 - u * u) + tilt * u - hw * .04f;
    work.w[i] = hw * .15f * fm::pow(fm::sin(fm::pi * fm::clamp(s, .02f, .98f)), .55f) + .35f * S;
    work.dry[i] = 1;
  }
  return brush(h, 18, col, alpha, r.brushSeed(), .82f, .2f, .3f, .25f, 0, 0, 1.8f, 1.2f);
}
inline bool stalk(Word h, const Stalk& o, Random& r, float S, const StalkPlan& p) {
  const float span = o.yb - o.yt, gap = fm::max(1.1f, o.hw * .17f);
  if (!(S > 0 && span > 0) || p.n < 2)
    return fail(81);
  for (Word k = 0; k < p.n - 1; k++) {
    const float y0 = p.nodes[k] - gap * .5f, y1 = p.nodes[k + 1] + gap * .5f, len = y0 - y1, bulge = r.range(.04f, .1f);
    const float count = fm::max(10, fm::ceil(len / (3.4f * S)));
    if (count > maxPath)
      return fail(83);
    const Word n = Word(count);
    const float top = 1 - (p.nodes[k + 1] - o.yt) / span, width = o.hw * (1 - o.taper * fm::clamp(top, 0, 1));
    Word i = 0;
    for (; i + 4 <= n; i += 4) {
      const auto s = wasm_f32x4_div(wasm_f32x4_make(float(i), float(i + 1), float(i + 2), float(i + 3)),
                                    wasm_f32x4_splat(float(n - 1)));
      const auto yy = wasm_f32x4_sub(wasm_f32x4_splat(y0), wasm_f32x4_mul(s, wasm_f32x4_splat(len)));
      const auto sine =
          wasm_f32x4_make(fm::sin(float(i) / float(n - 1) * fm::pi), fm::sin(float(i + 1) / float(n - 1) * fm::pi),
                          fm::sin(float(i + 2) / float(n - 1) * fm::pi), fm::sin(float(i + 3) / float(n - 1) * fm::pi));
      wasm_v128_store(work.x + i, stalkX4(o, yy));
      wasm_v128_store(work.y + i, yy);
      wasm_v128_store(
          work.w + i,
          wasm_f32x4_mul(
              wasm_f32x4_splat(width),
              wasm_f32x4_sub(
                  wasm_f32x4_add(wasm_f32x4_splat(1),
                                 wasm_f32x4_mul(wasm_f32x4_splat(bulge),
                                                wasm_f32x4_add(seventh(wasm_f32x4_sub(wasm_f32x4_splat(1), s)),
                                                               wasm_f32x4_mul(wasm_f32x4_splat(1.25f), seventh(s))))),
                  wasm_f32x4_mul(wasm_f32x4_splat(.025f), sine))));
    }
    for (; i < n; i++) {
      const float s = float(i) / float(n - 1), yy = y0 - s * len;
      work.x[i] = stalkX(o, yy);
      work.y[i] = yy;
      const float u = 1 - s, u2 = u * u, u4 = u2 * u2, s2 = s * s, s4 = s2 * s2;
      work.w[i] = width * (1 + bulge * (u4 * u2 * u + 1.25f * (s4 * s2 * s)) - .025f * fm::sin(s * fm::pi));
    }
    const bool dryTop = r.chance(7, 10);
    const float fray = r.range(.12f, .42f), alpha = o.alpha * r.range(.88f, 1.04f), dry = r.range(.12f, .3f);
    const Word seed = r.brushSeed();
    for (i = 0; i < n; i++) {
      const float s = float(i) / float(n - 1);
      work.dry[i] = dryTop ? fm::smooth(.3f, 1, s) : fm::smooth(.7f, 0, s);
    }
    Word wet = 0;
    if (config.stamps & (1u << 5)) {
      wet = inkStroke(h, path(n), seed, S, alpha * .62f, .6f, ink, 1);
      if (wet == 2)
        return fail(error ? error : 83);
    }
    if (!brush(h, n, ink, wet ? alpha * .8f : alpha, seed, wet ? .4f : .55f, .62f, .3f, dryTop ? fray : 0,
               dryTop ? 0 : fray, dry, 1.75f, 0, 80 * S, dryTop ? 1 : 2))
      return false;
  }
  for (Word i = 1; i < p.n - 1; i++)
    if (p.nodes[i] > o.yt && !node(h, stalkX(o, p.nodes[i]), p.nodes[i], o.hw, ink, fm::min(1, o.alpha * 1.1f), r, S))
      return false;
  return true;
}
inline bool farLeaves(Word h, float x, float y, float len, ColorBytes col, float alpha, Random& r) {
  const Word n = 4 + r.bucket(6);
  const float base = r.range(2.2f, 3);
  for (Word i = 0; i < n; i++) {
    const float angle = base + (float(i) / float(n - 1) - .5f) * 1.3f + r.range(-.15f, .15f),
                L = len * r.range(.7f, 1.15f);
    const float bend = r.range(-.08f, .08f), a = alpha * r.range(.7f, 1);
    if (!leaf(h, x, y, angle, L, L * .11f, bend, 0, col, a, 1))
      return false;
  }
  return true;
}
inline bool far(Word h, int j, Random& r, float U, float S) {
  const float x = (float(j) + r.r()) * .02f, d = grove(0, x), dens = d * (.35f + .9f * noise.at(x * 23 + 5));
  if (r.greater(.15f + .85f * dens))
    return true;
  const float height = tall(0, x), y0 = ground(0, x), lean0 = r.range(-.12f, .03f);
  const float rx = r.range(.018f, .035f) * U, ry = r.range(.03f, .06f) * U * height, wash = r.range(.025f, .05f) * d;
  if (!blob(h, x * U, (y0 - (.05f + .08f * d) * height) * U, rx, ry, farInk, wash))
    return false;
  const Word n = 1 + Word(r.r() * (1 + 5 * dens));
  for (Word i = 0; i < n; i++) {
    const float xi = x + r.range(-.012f, .012f), yb = ground(0, xi) + r.range(0, .02f);
    const float heightStem = fm::min((.035f + .17f * d * fm::pow(r.r(), .75f)) * height, yb - .33f - .02f);
    const float lean = lean0 + r.range(-.04f, .04f),
                hw = fm::max(.4f, (.3f + .55f * fm::sqrt(heightStem / (.2f * height))) * r.range(.8f, 1.2f) * S);
    const float alpha = r.range(.12f, .24f) * (.6f + .4f * d), X0 = xi * U, Y0 = yb * U, Y1 = (yb - heightStem) * U,
                X1 = X0 + lean * heightStem * U;
    auto g = pc::linear(h, 0, Y0, 0, Y1);
    pc::stop(g, 0, color(farInk, 0));
    pc::stop(g, .4f, color(farInk, alpha));
    pc::stop(g, 1, color(farInk, alpha * .8f));
    if (!polygon4(h, g, X0 - hw, Y0, X1 - hw * .55f, Y1, X1 + hw * .55f, Y1, X0 + hw, Y0))
      return false;
    const Word sprays = 2 + r.bucket(4);
    for (Word q = 0; q < sprays; q++) {
      const float at = 1 - fm::pow(r.r(), 1.3f) * .6f, len = r.range(6, 12) * S * (.75f + .5f * d);
      if (!farLeaves(h, fm::lerp(X0, X1, at), fm::lerp(Y0, Y1, at), len, farInk, alpha * 1.15f, r))
        return false;
    }
  }
  return true;
}
inline float middleX(float x, float yb, float height, float lean, float bow, float y) {
  const float d = yb - y;
  return x + lean * d + bow * d * d / height;
}
inline bool middleStalk(Word h, float x, float yb, float height, float hw, float lean, float bow, float alpha,
                        float leafy, Random& r, float S) {
  if (!(height > 0 && S > 0))
    return fail(81);
  const float top = yb - height;
  float nodes[maxNodes];
  Word count = 1;
  nodes[0] = yb;
  for (float y = yb; y > top + height * .05f;) {
    if (count == maxNodes)
      return fail(82);
    y -= height * r.range(.1f, .15f);
    nodes[count++] = fm::max(y, top);
  }
  for (Word i = 0; i < count - 1; i++) {
    const float y0 = nodes[i] - .5f * S, y1 = nodes[i + 1] + .5f * S;
    if (y0 - y1 < 1)
      continue;
    const float w0 = hw * (1 - .3f * (yb - y0) / height), w1 = hw * (1 - .3f * (yb - y1) / height);
    const auto paint = pc::solid(color(midStalk, alpha * fm::smooth(yb, yb - height * .42f, (y0 + y1) * .5f)));
    const float X0 = middleX(x, yb, height, lean, bow, y0), X1 = middleX(x, yb, height, lean, bow, y1);
    if (!polygon4(h, paint, X0 - w0, y0, X1 - w1, y1, X1 + w1, y1, X0 + w0, y0))
      return false;
  }
  const Word extra = Word(fm::floor(leafy * (4 + r.r() * 7) + .5f));
  if (extra + 1 > maxSprays)
    return fail(87);
  work.sprays[0].y = top;
  for (Word i = 1; i <= extra; i++)
    work.sprays[i].y = fm::lerp(yb - height * .52f, top, fm::pow(r.r(), .65f));
  const float R = 30 * S;
  const float xa0 = middleX(x, yb, height, lean, bow, yb - height * .5f),
              xa1 = middleX(x, yb, height, lean, bow, yb - height * .75f), xa2 = middleX(x, yb, height, lean, bow, top);
  const float xa = fm::min(xa0, fm::min(xa1, xa2)), xb = fm::max(xa0, fm::max(xa1, xa2));
  const float rx = r.range(14, 26) * S * (.4f + .6f * leafy), ry = r.range(22, 40) * S * (.4f + .6f * leafy);
  if (!blob(h, middleX(x, yb, height, lean, bow, top + height * .2f), top + height * .2f, rx, ry, midInk, alpha * .14f))
    return false;
  for (Word q = 0; q <= extra; q++) {
    auto& t = work.sprays[q];
    t.x = middleX(x, yb, height, lean, bow, t.y);
    const float side = t.y == top ? -.25f : (r.chance(58, 100) ? -1 : 1), slope = lean + 2 * bow * (yb - t.y) / height;
    const float angle = -fm::pi * .5f + atan(slope) + side * r.range(.45f, 1.05f), len = r.range(4, 10) * S;
    t.ex = t.x + fm::cos(angle) * len;
    t.ey = t.y + fm::sin(angle) * len;
    t.n = 5 + r.bucket(4);
    const float base = wind(angle, r);
    for (Word i = 0; i < t.n; i++) {
      const float at = float(i) / float(t.n - 1) - .5f;
      auto& l = t.leaves[i];
      const float spread = r.range(1, 1.5f), jitter = r.range(-.12f, .12f);
      l.angle = base + at * spread + jitter;
      l.length = r.range(8, 17) * S * (1 - fm::abs(at) * .4f);
      l.width = l.length * r.range(.1f, .13f);
      l.bend = r.range(-.06f, .1f);
      l.asym = r.range(-.2f, .2f);
      l.tone = r.range(.6f, 1);
      l.ox = l.oy = 0;
      l.light = 0;
    }
  }
  const float box[4] = {xa - R - 8 * S, top - R, xb + R, yb - height * .5f + R};
  Group g;
  if (!groupBegin(h, box, g))
    return false;
  const Word target = g.visible ? g.source : h;
  for (Word q = 0; q <= extra; q++) {
    const auto& t = work.sprays[q];
    if (g.visible) {
      pc::Pen pen;
      pen.width = fm::max(.5f, hw * .45f);
      pen.cap = 1;
      pc::begin(target);
      if (!ok(pc::move(target, t.x, t.y)) || !ok(pc::line(target, t.ex, t.ey)) ||
          !ok(pc::stroke(target, pc::solid(color(midInk, .85f)), 1, pen)))
        return false;
    }
    for (Word i = 0; i < t.n; i++) {
      const auto& l = t.leaves[i];
      if (!leaf(target, t.ex, t.ey, l.angle, l.length, l.width, l.bend, l.asym, midInk, l.tone, 1, 6, g.visible))
        return false;
    }
  }
  return groupEnd(h, g, alpha);
}
inline bool middle(Word h, int j, Random& r, float U, float S) {
  const float x = (float(j) + r.range(.05f, .95f)) * .045f, d = grove(1, x),
              dens = d * (.35f + .95f * noise.at(x * 11 + 29));
  if (r.greater(.1f + .9f * dens))
    return true;
  const float height = tall(1, x), hc = (.15f + .23f * d) * height * r.range(.65f, 1.25f), back0 = r.r();
  const Word n = 1 + Word(r.r() * (1.5f + 7 * dens));
  const float lean0 = r.range(-.1f, .02f), fan = r.range(.03f, .12f),
              spread = r.range(.01f, .05f) * fm::sqrt(float(n) / 4);
  for (Word i = 0; i < n; i++) {
    const float p = n == 1 ? 0 : float(i) / float(n - 1) - .5f;
    const bool young = n > 1 && r.chance(1, 5);
    const float back = fm::clamp(back0 + r.range(-.25f, .25f), 0, 1), xi = x + p * spread + r.range(-.004f, .004f);
    const float yb = ground(1, xi) + fm::lerp(.035f, .002f, back) + r.range(0, .012f);
    const float factor = young ? r.range(.3f, .55f) : r.range(.6f, 1.2f) * (1 - .4f * fm::abs(p));
    const float hh = fm::min(hc * factor, yb - .25f - .05f);
    const float hw = fm::max(.45f, (young ? r.range(.5f, .8f) : r.range(.8f, 1.6f)) * fm::sqrt(hh / hc) * S);
    float lean = fm::clamp(lean0 + p * fan + r.range(-.025f, .025f), -.16f, .06f), bow = r.range(-.08f, .02f);
    const float over = fm::abs(lean + bow) * hh / .11f;
    if (over > 1) {
      lean /= over;
      bow /= over;
    }
    const float alpha = r.range(.2f, .4f) * fm::lerp(.45f, 1, back) * (.8f + .2f * d),
                leafy = young ? r.range(.25f, .5f) : r.range(.7f, 1.2f);
    if (!middleStalk(h, xi * U, yb * U, hh * U, hw, lean, bow, alpha, leafy, r, S))
      return false;
  }
  return true;
}
inline Word selectNodes(const StalkPlan& p, float low, float high) {
  Word n = 0;
  for (Word i = 0; i < p.n; i++)
    if (p.nodes[i] > low && p.nodes[i] < high)
      work.selected[n++] = p.nodes[i];
  return n;
}
inline void shuffleNodes(Word n, Random& r) {
  for (Word i = n; i > 1; i--) {
    const Word at = r.bucket(i);
    const float x = work.selected[i - 1];
    work.selected[i - 1] = work.selected[at];
    work.selected[at] = x;
  }
}
inline bool foreground(Word h, int j, Random& r, float U, float S) {
  const float x = (float(j) + r.range(.1f, .9f)) * .13f, d = near(x), d2 = near(x + .05f);
  const Word tufts = Word(r.r() * (1 + 4 * fm::max(d, d2 * .8f)));
  for (Word q = 0; q < tufts; q++) {
    const float xx = (x + r.range(-.06f, .06f)) * U, yy = r.range(.965f, 1.01f) * U, a = r.range(.25f, .5f);
    if (!grass(h, xx, yy, r, S, leafInk, a))
      return false;
  }
  if (r.greater(.9f * d))
    return true;
  const Word n = 1 + Word(r.r() * (1 + 3 * d));
  const float lean0 = r.range(-.08f, .015f), fan = r.range(.015f, .08f), spread = r.range(.015f, .075f);
  for (Word i = 0; i < n; i++) {
    const float p = n == 1 ? 0 : float(i) / float(n - 1) - .5f;
    const bool young = n > 1 && r.chance(1, 4);
    const float xi = x + p * spread + r.range(-.006f, .006f), yb = ground(2, xi),
                height = young ? r.range(.22f, .4f) : r.range(.42f, .72f) * (1 - .22f * fm::abs(p));
    const float hw = (young ? r.range(1.3f, 2.1f) : r.range(2.1f, 4.6f)) * S * fm::sqrt(height / .6f),
                alpha = young ? r.range(.45f, .62f) : r.range(.55f, .88f);
    Stalk o = {xi * U, yb * U, (yb - height) * U, hw};
    o.lean = fm::clamp(lean0 + p * fan + r.range(-.02f, .02f), -.13f, .05f);
    o.bow = r.range(-.1f, .02f);
    o.seg = height * U * r.range(.09f, .14f);
    o.alpha = alpha;
    o.curve = r.range(-.6f, .6f);
    StalkPlan pl;
    if (!stalkPlan(o, r, pl) || !stalk(h, o, r, S, pl))
      return false;
    const float f = young ? .75f : 1;
    const Word available = selectNodes(pl, o.yt, o.yb - height * U * .48f);
    shuffleNodes(available, r);
    const Word wanted = young ? 1 + r.bucket(2) : 3 + r.bucket(3), twigs = available < wanted ? available : wanted;
    for (Word q = 0; q < twigs; q++) {
      const float y = work.selected[q], side = r.chance(62, 100) ? -1 : 1;
      const float angle = -fm::pi * .5f + stalkTilt(o, y) + side * r.range(.55f, 1), len = r.range(.03f, .055f) * U * f,
                  leafLen = r.range(.038f, .054f) * U * f;
      if (!twig(h, stalkX(o, y) + side * hw * .6f, y, angle, len, fm::max(.8f * S, hw * .15f), leafInk,
                fm::min(1, alpha * 1.02f), r, S, leafLen, alpha))
        return false;
    }
    const Word tips = young ? 1 : 2;
    for (Word q = 0; q < tips; q++) {
      const float angle = -fm::pi * .5f + stalkTilt(o, o.yt) - (q ? -1 : 1) * r.range(.15f, .55f),
                  len = r.range(.03f, .05f) * U * f, leafLen = r.range(.036f, .05f) * U * f;
      if (!twig(h, stalkX(o, o.yt), o.yt + float(q) * 6 * S, angle, len, fm::max(.7f * S, hw * .14f), leafInk, alpha, r,
                S, leafLen, alpha))
        return false;
    }
  }
  return true;
}
} // namespace bamboo
} // namespace painter

namespace painter {
inline bool paintBamboo(Word h, Word li, int j, Random& r) {
  if (error || cellStatus)
    return false;
  const float U = config.H, S = U / 900;
  if (!(U > 0))
    return bamboo::fail(81);
  if (li == 0)
    return bamboo::far(h, j, r, U, S);
  if (li == 1)
    return bamboo::middle(h, j, r, U, S);
  if (li == 2)
    return bamboo::foreground(h, j, r, U, S);
  return bamboo::fail(88);
}
} // namespace painter
