#pragma once
#include "random.hpp"
namespace painter {
constexpr Word maxCellPoints = 65536, maxCellBranches = 512, maxCellBlooms = 16384;
struct Path {
  Word first, n;
};
struct Branch {
  Path path;
  Word depth, order;
};
struct Bloom {
  float x, y;
  Word depth, tip;
};
struct Geometry {
  float points[maxCellPoints * 3];
  Branch branches[maxCellBranches];
  Bloom blooms[maxCellBlooms];
  float trunkLengths[400], trunkTotal = 0;
  Word pointFloats = 0, branchCount = 0, bloomCount = 0, status = 0, simdBatches = 0;
  void reset() {
    pointFloats = branchCount = bloomCount = status = simdBatches = 0;
    trunkTotal = 0;
    for (float& length : trunkLengths)
      length = 0;
  }
  Word addPath(Word n, Word depth) {
    if (branchCount == maxCellBranches || n > 4096 || pointFloats + n * 3 > maxCellPoints * 3) {
      status = 70;
      return 0xffffffffu;
    }
    const Word index = branchCount++;
    branches[index] = {{pointFloats, n}, depth, index};
    pointFloats += n * 3;
    return index;
  }
  float* x(Path p) { return points + p.first; }
  float* y(Path p) { return points + p.first + p.n; }
  float* w(Path p) { return points + p.first + p.n * 2; }
  void bloom(float x, float y, Word depth, Word tip = 0) {
    if (bloomCount == maxCellBlooms) {
      status = 71;
      return;
    }
    blooms[bloomCount++] = {x, y, depth, tip};
  }
};
inline float atanSmall(float x) {
  const float z = x * x;
  return x * (1 + z * (-1.0f / 3 +
                       z * (1.0f / 5 +
                            z * (-1.0f / 7 + z * (1.0f / 9 + z * (-1.0f / 11 + z * (1.0f / 13 + z * (-1.0f / 15))))))));
}
inline float atanUnit(float x) {
  return x > .41421356237f ? fm::pi * .25f + atanSmall((x - 1) / (x + 1)) : atanSmall(x);
}
inline float atan2(float y, float x) {
  const float a = fm::abs(x), b = fm::abs(y);
  if (!(a || b))
    return 0;
  float q = a >= b ? atanUnit(b / a) : fm::pi * .5f - atanUnit(a / b);
  if (x < 0)
    q = fm::pi - q;
  return y < 0 ? -q : q;
}
struct Limb {
  float x, y, angle, length, width, width0, droop;
  Word depth, maxDepth;
};
inline void grow(Geometry& g, Noise1& noise, const Limb& o, Random& r, float scale) {
  if (g.status)
    return;
  const float step = 3 * scale;
  const Word n = Word(fm::max(5, fm::ceil(o.length / step)));
  const Word branch = g.addPath(n, o.depth);
  if (branch == 0xffffffffu)
    return;
  const Path path = g.branches[branch].path;
  float* xs = g.x(path);
  float* ys = g.y(path);
  float* ws = g.w(path);
  float x = 0, y = 0, a = o.angle, turn = 0;
  int kink = int(fm::floor(r.range(.12f, .3f) * float(n)));
  const float so = r.r() * 500;
  Word i = 0;
  const auto width = wasm_f32x4_splat(o.width), low = wasm_f32x4_splat(.5f * scale);
  for (; i + 4 <= n; i += 4) {
    const auto q =
        wasm_f32x4_make(fm::pow(float(i) / float(n - 1), .8f), fm::pow(float(i + 1) / float(n - 1), .8f),
                        fm::pow(float(i + 2) / float(n - 1), .8f), fm::pow(float(i + 3) / float(n - 1), .8f));
    wasm_v128_store(
        ws + i, wasm_f32x4_max(low, wasm_f32x4_mul(width, wasm_f32x4_sub(wasm_f32x4_splat(1),
                                                                         wasm_f32x4_mul(wasm_f32x4_splat(.82f), q)))));
    g.simdBatches++;
  }
  for (; i < n; i++)
    ws[i] = fm::max(.5f * scale, o.width * (1 - .82f * fm::pow(float(i) / float(n - 1), .8f)));
  for (i = 0; i < n; i++) {
    const float s = float(i) / float(n - 1);
    xs[i] = o.x + x;
    ys[i] = o.y + y;
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
  if (o.depth < o.maxDepth) {
    const Word kids = 1 + r.bucket(3);
    for (Word k = 0; k < kids && !g.status; k++) {
      const float s = r.range(.2f, .95f);
      const Word at = Word(fm::min(float(n - 1), fm::floor(s * float(n - 1))));
      const Word i0 = at ? at - 1 : 0, i1 = at + 1 < n ? at + 1 : n - 1;
      const float dir = atan2(ys[i1] - ys[i0], xs[i1] - xs[i0]);
      const float sign = r.chance(1, 2) ? -1.0f : 1.0f;
      const float turnAngle = r.range(.4f, 1);
      const float lengthFactor = r.range(.3f, .58f);
      const float widthFactor = r.range(.42f, .62f);
      Limb child = {xs[at],
                    ys[at],
                    dir + sign * turnAngle,
                    o.length * lengthFactor * (1.05f - .5f * s),
                    ws[at] * widthFactor,
                    o.width0 ? o.width0 : o.width,
                    o.droop,
                    o.depth + 1,
                    o.maxDepth};
      grow(g, noise, child, r, scale);
    }
  }
  for (Word q = Word(fm::floor(float(n) * .3f)); q < n; q += 2 + r.bucket(5))
    if (r.chance(55, 100))
      g.bloom(xs[q], ys[q], o.depth);
  g.bloom(xs[n - 1], ys[n - 1], o.depth, 1);
}

struct TrunkSample {
  float x, y, w;
};
inline TrunkSample trunkSample(const Geometry& g, const float* xs, const float* ys, Word count, float width, float s,
                               float originX, float originY, float offsetX) {
  float d = s * g.trunkTotal;
  Word i = 0;
  while (i < count - 2 && d > g.trunkLengths[i]) {
    d -= g.trunkLengths[i];
    i++;
  }
  const float t = g.trunkLengths[i] ? fm::min(1, d / g.trunkLengths[i]) : 0;
  return {originX + (offsetX + fm::lerp(xs[i], xs[i + 1], t)), originY + fm::lerp(ys[i], ys[i + 1], t),
          width * (1 - .5f * fm::pow(s, .9f)) * (1 + .4f * fm::pow(1 - s, 6))};
}
inline Word trunkPath(Geometry& g, const float* xs, const float* ys, Word count, float width, float step, float originX,
                      float originY, float offsetX) {
  g.trunkTotal = 0;
  for (Word i = 1; i < count; i++) {
    g.trunkLengths[i - 1] = fm::hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    g.trunkTotal += g.trunkLengths[i - 1];
  }
  const Word n = Word(fm::max(4, float((count - 1) * 2 + 2)));
  const Word index = g.addPath(n, 0);
  if (index == 0xffffffffu)
    return index;
  const Path p = g.branches[index].path;
  float* x = g.x(p);
  float* y = g.y(p);
  float* w = g.w(p);
  for (Word q = 0; q < n; q++) {
    const float s = float(q) / float(n - 1);
    const TrunkSample sample = trunkSample(g, xs, ys, count, width, s, originX, originY, offsetX);
    x[q] = sample.x;
    y[q] = sample.y;
    w[q] = sample.w;
  }
  return index;
}
} // namespace painter
