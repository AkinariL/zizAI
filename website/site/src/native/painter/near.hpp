#pragma once
#include "canvas.hpp"
#include "geometry.hpp"
namespace painter {
struct ColorBytes {
  int r, g, b;
};
constexpr ColorBytes inkJA{44, 31, 34}, pink{241, 186, 201}, pinkPale{251, 229, 234}, pinkDeep{221, 131, 156},
    pinkHeart{176, 66, 98}, sakuraHaze{229, 160, 182}, sakuraRose{216, 128, 156};
struct Config {
  float W, H, kc, hero;
  Word stamps = 255, objects = 0;
  float s = 1;
  Word maxTex = 8192;
  float zhMid = -1e9f, jaTop = -1e9f, jaRight = -1e9f;
};
static Config config;
static Geometry geometry;
static Noise1 noise;
static Word cellState, cellDraws, cellStatus, objectOrdinal;
inline void objectBegin(Word h, Word kind);
inline void objectEnd(Word h);
inline Word alphaQ3(float a) {
  return Word(fm::floor(fm::clamp(a, 0, 1) * 1000 + .5f));
}
inline pc::Color color(ColorBytes c, float alpha = 1) {
  return pc::colorBytes(c.r, c.g, c.b, alphaQ3(alpha));
}
inline void petalPath(Word h, float R) {
  pc::move(h, 0, 0);
  pc::cubic(h, R * .22f, -R * .2f, R * .5f, -R * .56f, R * .84f, -R * .42f);
  pc::quadratic(h, R * 1.02f, -R * .33f, R * .99f, -R * .1f);
  pc::line(h, R * .86f, -R * .01f);
  pc::line(h, R * .99f, R * .09f);
  pc::quadratic(h, R * 1.02f, R * .33f, R * .84f, R * .42f);
  pc::cubic(h, R * .5f, R * .56f, R * .22f, R * .2f, 0, 0);
}
inline void ellipseBlob(Word h, float x, float y, float rx, float ry, ColorBytes col, float a) {
  if (config.stamps & 1) {
    float v[15] = {};
    v[0] = x;
    v[1] = y;
    v[2] = rx;
    v[3] = ry;
    v[5] = v[6] = 1;
    v[7] = v[11] = float(col.r) / 255;
    v[8] = v[12] = float(col.g) / 255;
    v[9] = v[13] = float(col.b) / 255;
    v[10] = pc::q3(alphaQ3(a));
    v[14] = pc::q3(alphaQ3(a * .55f));
    if (pc::stamp(h, 3, v, 15))
      return;
  }
  pc::save(h);
  pc::translate(h, x, y);
  pc::scale(h, 1, ry / rx);
  auto p = pc::radial(h, 0, 0, 0, 0, 0, rx);
  pc::stop(p, 0, color(col, a));
  pc::stop(p, .55f, color(col, a * .55f));
  pc::stop(p, 1, color(col, 0));
  pc::fillRect(h, p, 1, -rx, -rx, rx * 2, rx * 2);
  pc::restore(h);
}
inline void petalFill(Word h, float x, float y, float rot, float sy, float R, ColorBytes col, float a) {
  objectBegin(h, 5);
  if (config.stamps & (1u << 2)) {
    float v[16] = {};
    v[0] = x;
    v[1] = y;
    v[2] = rot;
    v[3] = sy;
    v[4] = R;
    v[7] = 1;
    v[12] = float(col.r) / 255;
    v[13] = float(col.g) / 255;
    v[14] = float(col.b) / 255;
    v[15] = pc::q3(alphaQ3(a));
    if (pc::stamp(h, 2, v, 16)) {
      objectEnd(h);
      return;
    }
  }
  pc::save(h);
  pc::translate(h, x, y);
  pc::rotate(h, rot);
  pc::scale(h, 1, sy);
  pc::begin(h);
  petalPath(h, R);
  pc::restore(h);
  pc::fill(h, pc::solid(color(col, a)));
  objectEnd(h);
}
inline void smallFlower(Word h, float x, float y, float R, float rot, Random& r, float tone) {
  float v[22] = {x, y, R, rot, tone};
  for (Word k = 0; k < 5; k++) {
    const Word j = 5 + k * 3;
    v[j] = r.range(-.12f, .12f);
    v[j + 1] = r.range(.88f, 1.06f);
    v[j + 2] = r.range(.85f, 1.05f);
  }
  objectBegin(h, 1);
  const Word inner = alphaQ3(.72f * tone);
  v[20] = float(inner + 1024 * inner);
  v[21] = float(alphaQ3(.88f * tone) + 1024 * alphaQ3(.55f * tone));
  if ((config.stamps & (1u << 1)) && pc::stamp(h, 1, v, 22)) {
    objectEnd(h);
    return;
  }
  auto p = pc::radial(h, x, y, 0, x, y, R);
  pc::stop(p, 0, color(pinkDeep, .72f * tone));
  pc::stop(p, .36f, color(pink, .72f * tone));
  pc::stop(p, 1, color(pinkPale, .88f * tone));
  pc::begin(h);
  for (Word k = 0; k < 5; k++) {
    const Word j = 5 + k * 3;
    pc::save(h);
    pc::translate(h, x, y);
    pc::rotate(h, rot + float(k) * fm::tau / 5 + v[j]);
    pc::scale(h, 1, v[j + 1]);
    petalPath(h, R * v[j + 2]);
    pc::restore(h);
  }
  pc::fill(h, p);
  pc::begin(h);
  pc::arc(h, x, y, fm::max(.45f, R * .17f), 0, fm::tau);
  pc::fill(h, pc::solid(color(pinkHeart, .55f * tone)));
  objectEnd(h);
}
inline void blossomCloud(Word h, float cx, float cy, float R, float a, Random& r, Word n, const ColorBytes* tones,
                         Word toneCount) {
  for (Word i = 0; i < n; i++) {
    const float angle = r.r() * fm::tau;
    const float distance = fm::sqrt(r.r()) * R;
    const float rx = r.range(.3f, .56f) * R;
    const float ry = r.range(.22f, .42f) * R;
    const ColorBytes col = tones[r.bucket(toneCount)];
    const float alpha = a * r.range(.6f, 1);
    ellipseBlob(h, cx + fm::cos(angle) * distance * 1.25f, cy + fm::sin(angle) * distance * .7f, rx, ry, col, alpha);
  }
}
inline Word inkStroke(Word h, const pc::Path& p, Word seed, float S, float tone, float paper = .6f,
                      ColorBytes col = inkJA, float style = 0) {
  constexpr Word step = 6;
  const Word m = (p.n - 1 + step - 1) / step;
  float along = 0, knotX = p.x[0], knotY = p.y[0], knotW = p.w[0], knotS = 0;
  Word at = 0;
  const float pu = paper * S, side = p.x[p.n - 1] >= p.x[0] ? 1.f : -1.f;
  float v[21] = {};
  v[8] = float(col.r) / 255;
  v[9] = float(col.g) / 255;
  v[10] = float(col.b) / 255;
  v[16] = style;
  v[11] = fm::clamp(tone, 0, 1);
  v[12] = float(seed & 0xffff) / 65536;
  v[13] = pu;
  v[18] = 1;
  v[19] = 1;
  v[20] = side;
  for (Word j = 0; j + 1 <= m; j++) {
    const Word corner = (j + 1) * step < p.n - 1 ? (j + 1) * step : p.n - 1;
    float cornerS = along;
    for (Word i = at; i < corner; i++)
      cornerS += fm::hypot(p.x[i + 1] - p.x[i], p.y[i + 1] - p.y[i]);
    const bool last = j + 2 >= m;
    const Word next = last ? p.n - 1 : (j + 2) * step;
    float nextS = cornerS;
    for (Word i = corner; i < next; i++)
      nextS += fm::hypot(p.x[i + 1] - p.x[i], p.y[i + 1] - p.y[i]);
    float cx = p.x[corner], cy = p.y[corner], ex, ey, ew, es;
    if (m == 1) {
      ex = cx;
      ey = cy;
      ew = p.w[corner];
      es = cornerS;
      cx = (knotX + ex) * .5f;
      cy = (knotY + ey) * .5f;
    } else if (last) {
      ex = p.x[next];
      ey = p.y[next];
      ew = p.w[next];
      es = nextS;
    } else {
      ex = (cx + p.x[next]) * .5f;
      ey = (cy + p.y[next]) * .5f;
      ew = (p.w[corner] + p.w[next]) * .5f;
      es = (cornerS + nextS) * .5f;
    }
    v[0] = knotX;
    v[1] = knotY;
    v[2] = cx;
    v[3] = cy;
    v[4] = ex;
    v[5] = ey;
    v[6] = knotW;
    v[7] = ew;
    v[14] = knotS / pu;
    v[15] = es / pu;
    v[17] = float((j == 0 ? 1 : 0) | (last || m == 1 ? 2 : 0));
    if (!pc::stamp(h, 6, v, 21))
      return error || j ? 2 : 0;
    knotX = ex;
    knotY = ey;
    knotW = ew;
    knotS = es;
    along = cornerS;
    at = corner;
    if (last || m == 1)
      break;
  }
  return error ? 2 : 1;
}
inline float clumpFloor(float x, Word salt) {
  const float P = fm::clamp(.5f * config.W / config.H, .22f, .8f);
  const int m = int(fm::floor(x / P));
  float best = 0;
  for (int q = m - 1; q <= m + 1; q++) {
    Random r(cellSeed(9191, salt, q));
    const float c = (float(q) + r.range(.2f, .8f)) * P, w = P * r.range(.2f, .3f), peak = r.range(.7f, 1);
    const float d = fm::abs(x - c) / w;
    if (d < 1)
      best = fm::max(best, peak * fm::smooth(1, .35f, d));
  }
  return best;
}
inline float nearAt(float x) {
  return fm::max(fm::smooth(.42f, .68f, noise.at(x * 1.25f + 63)), clumpFloor(x, 1));
}
inline float groundNear(float x) {
  return 1.03f + .03f * (2 * noise.at(x * .6f + 71) - 1);
}
inline void sakuraNear(Word h, int j, Random& r) {
  geometry.reset();
  cellStatus = 0;
  const float U = config.H, S = U / 900;
  const float offset = r.range(.1f, .9f);
  const float x = (float(j) + offset) * .13f, d = nearAt(x), d2 = nearAt(x + .05f);
  const Word fallen = Word(r.r() * (1 + 4 * fm::max(d, d2 * .8f)));
  for (Word q = 0; q < fallen; q++) {
    const float px = (x + r.range(-.06f, .06f)) * U;
    const float py = r.range(.975f, 1.01f) * U;
    const float rx = r.range(.03f, .06f) * U;
    const float ry = r.range(.006f, .012f) * U;
    const float a = r.range(.1f, .18f);
    ellipseBlob(h, px, py, rx, ry, pink, a);
    const Word count = 4 + r.bucket(8);
    for (Word k = 0; k < count; k++) {
      const float petalX = px + r.range(-.05f, .05f) * U;
      const float petalY = py + r.range(-.01f, .006f) * U;
      const float rot = r.r() * fm::tau;
      const float sy = r.range(.35f, .7f);
      const float R = r.range(2.5f, 4.5f) * S;
      const ColorBytes col = r.chance(1, 2) ? pink : sakuraHaze;
      const float alpha = r.range(.35f, .7f);
      petalFill(h, petalX, petalY, rot, sy, R, col, alpha);
    }
  }
  if (r.greater(.8f * d))
    return;
  const float cellPixels = (U * 13) / 100;
  float cellOrigin = float(j) * cellPixels, cellOffset = offset * cellPixels;
  if (U == fm::floor(U) && U <= 1000000) {
    const long long grid = static_cast<long long>(j) * 13 * static_cast<long long>(U);
    cellOrigin = float(grid / 100);
    cellOffset = float(grid % 100) / 100 + cellOffset;
  }
  const float Y0 = groundNear(x) * U;
  const float height = r.range(.22f, .34f) * U;
  const float width = r.range(5.2f, 8.4f) * S;
  float xs[401], ys[401];
  xs[0] = 0;
  ys[0] = 0;
  const float so = r.r() * 100, step = 6 * S;
  float px = 0, py = 0, lean = r.range(-.16f, .1f);
  Word count = 1;
  for (Word k = 0; -py < height && k < 400; k++) {
    lean = fm::clamp(lean + (noise.at(so + float(k) * .15f) - .5f) * .08f, -.34f, .28f);
    px += fm::sin(lean) * step;
    py -= fm::cos(lean) * step;
    xs[count] = px;
    ys[count++] = py;
  }
  const Word trunk = trunkPath(geometry, xs, ys, count, width, 3 * S, cellOrigin, Y0, cellOffset);
  if (trunk == 0xffffffffu)
    return;
  const Path path = geometry.branches[trunk].path;
  const float* tx = geometry.x(path);
  const float* ty = geometry.y(path);
  const float* tw = geometry.w(path);
  const Word limbs = 4 + r.bucket(3);
  for (Word i = 0; i < limbs && !geometry.status; i++) {
    const float s = r.range(.4f, 1);
    const Word kHi = Word(fm::min(float(path.n - 2), fm::floor(s * float(path.n - 1))));
    const Word kLo = Word(fm::min(float(path.n - 3), fm::floor(s * float(path.n - 2))));
    const TrunkSample lo =
        trunkSample(geometry, xs, ys, count, width, float(kLo) / float(path.n - 2), cellOrigin, Y0, cellOffset);
    const TrunkSample loNext =
        trunkSample(geometry, xs, ys, count, width, float(kLo + 1) / float(path.n - 2), cellOrigin, Y0, cellOffset);
    const float branchX = fm::lerp(tx[kHi], lo.x, .5f), branchY = fm::lerp(ty[kHi], lo.y, .5f);
    const float branchWidth = fm::lerp(tw[kHi], lo.w, .5f);
    const float dirHi = atan2(ty[kHi + 1] - ty[kHi], tx[kHi + 1] - tx[kHi]);
    const float dirLo = atan2(loNext.y - lo.y, loNext.x - lo.x);
    const float dir = fm::lerp(dirHi, dirLo, .5f);
    const float childAngle = dir + (i % 2 ? 1 : -1) * r.range(.5f, 1.2f);
    const float childLength = height * r.range(.6f, 1.05f);
    const float childWidth = branchWidth * r.range(.45f, .65f);
    const float droop = r.range(.6f, 1.4f);
    const Limb child = {branchX, branchY, childAngle, childLength, childWidth, 0, droop, 1, 3};
    grow(geometry, noise, child, r, S);
  }
  if (geometry.status)
    return;
  for (Word i = 0; i < geometry.bloomCount; i += 4) {
    const Bloom b = geometry.blooms[i];
    const float rx = r.range(.05f, .09f) * U;
    const float ry = r.range(.035f, .06f) * U;
    const ColorBytes col = r.chance(1, 2) ? pinkPale : pink;
    const float alpha = r.range(.08f, .14f);
    ellipseBlob(h, b.x, b.y + 6 * S, rx, ry, col, alpha);
  }
  constexpr ColorBytes cloudTones[3] = {pinkPale, pink, sakuraHaze};
  for (Word i = 0; i < geometry.bloomCount; i++) {
    if (r.chance(3, 10))
      continue;
    const Bloom b = geometry.blooms[i];
    const float R = r.range(.024f, .056f) * U;
    const float bx = b.x + r.range(-8, 8) * S;
    const float by = b.y + r.range(-6, 8) * S;
    const float ry = R * r.range(.55f, .8f);
    const ColorBytes col = cloudTones[r.bucket(3)];
    const float alpha = r.range(.2f, .34f);
    ellipseBlob(h, bx, by, R, ry, col, alpha);
  }
  Word order[maxCellBranches];
  for (Word i = 0; i < geometry.branchCount; i++) {
    Word at = i;
    while (at && geometry.branches[order[at - 1]].depth > geometry.branches[i].depth) {
      order[at] = order[at - 1];
      at--;
    }
    order[at] = i;
  }
  float dryGrid[9], dry[4096];
  for (Word k = 0; k <= 8; k++)
    dryGrid[k] = .4f + .6f * (float(k) / 8);
  constexpr float alphas[4] = {.9f, .78f, .62f, .5f};
  for (Word i = 0; i < geometry.branchCount; i++) {
    const Branch br = geometry.branches[order[i]];
    const Path p = br.path;
    for (Word q = 0; q < p.n; q++)
      dry[q] = .4f + .6f * (float(q) / float(p.n - 1));
    pc::Brush brush = {};
    brush.col[0] = 44;
    brush.col[1] = 31;
    brush.col[2] = 34;
    brush.alpha = br.depth < 4 ? alphas[br.depth] : .45f;
    brush.body = .6f;
    brush.edge = .6f;
    brush.streak = .5f;
    brush.dry = br.depth ? .15f : .3f;
    brush.tail = br.depth ? .3f : 0;
    brush.head = br.depth ? 0 : .1f;
    brush.seed = r.brushSeed();
    brush.cover = 1.6f;
    brush.unit = 50 * S;
    brush.dryGrid = dryGrid;
    const pc::Path nativePath = {p.n, geometry.x(p), geometry.y(p), geometry.w(p), dry};
    if ((config.stamps & (1u << 5)) && inkStroke(h, nativePath, brush.seed, S, brush.alpha * .62f) == 1) {
      brush.alpha *= .55f;
      brush.body *= .5f;
    }
    pc::brush(h, nativePath, brush);
  }
  constexpr ColorBytes tones[2] = {sakuraRose, pink};
  for (Word i = 0; i < geometry.bloomCount; i += 3) {
    const Bloom b = geometry.blooms[i];
    const float R = r.range(.012f, .022f) * U;
    const float a = r.range(.12f, .2f);
    blossomCloud(h, b.x, b.y, R, a, r, 3, tones, 2);
  }
  for (Word i = 0; i < geometry.bloomCount; i++) {
    const Bloom b = geometry.blooms[i];
    const Word n = b.tip ? 5 + r.bucket(5) : 3 + r.bucket(3);
    for (Word k = 0; k < n; k++) {
      const float a = r.r() * fm::tau;
      const float distance = r.range(.2f, 2.4f) * 5.5f * S;
      const float R = r.range(3, 5.4f) * S * (b.tip ? 1 : .88f);
      const float rot = r.r() * fm::tau;
      const float tone = r.range(.75f, 1);
      smallFlower(h, b.x + fm::cos(a) * distance, b.y + fm::sin(a) * distance, R, rot, r, tone);
    }
  }
}
} // namespace painter
