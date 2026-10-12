#pragma once
#include "bamboo.hpp"

namespace painter {
namespace bamboo {
constexpr Word stalkKind = 32, twigKind = 33, grassKind = 34;
struct Station {
  float x, cw, v;
  Word kind, vBits;
};
inline Station station(int j, float U) {
  Random r(cellSeed(7777, 3, j));
  const float cw = .8f * U * config.kc * config.kc, x = (float(j) + r.range(.2f, .8f)) * cw;
  const Word u = r.raw();
  const float opening = fm::floor(config.hero / cw);
  if (float(j) == opening)
    return {config.hero, cw, .4f, 0, 0x66666666u};
  Word kind = stationKind(j);
  (void)u;
  if (float(j) == opening + 1 && kind == 0)
    kind = 1;
  if (float(j) == opening - 1)
    return {x, cw, .4f, 0, 0x66666667u};
  const Word v = r.raw();
  return {x, cw, float(v >> 8) * inverse24, kind, v};
}
inline float twigReach(float len, float leafLen, float S) {
  return len * 1.25f + leafLen * 1.2f + 8 * S;
}
inline bool add(ClosePlan& p, Word kind, float z, float x0, float x1, Word seed, const float* data, Word n) {
  return p.add(kind, z, x0, x1, seed, data, n) ? true : fail(error ? error : 89);
}
inline bool planStem(ClosePlan& p, float x, bool near, Random& r, float U, float S, float k, bool young = false) {
  const float hw = (young ? r.range(3.2f, 5.2f) : near ? r.range(8.5f, 18) : r.range(3.8f, 8)) * S * k;
  const float alpha = young ? r.range(.6f, .78f) : near ? r.range(.84f, .94f) : r.range(.24f, .42f);
  float lean;
  if (r.chance(22, 100)) {
    const float side = r.chance(7, 10) ? -1 : 1;
    lean = side * r.range(.05f, .1f);
  } else
    lean = r.range(-.035f, .025f);
  const float bow = r.range(-.05f, .025f), nodeWidth = hw * r.range(8.5f, 10.5f) + 70 * S,
              nodeHeight = U * r.range(.2f, .25f);
  Stalk o = {x,     U * 1.06f,          -U * .08f,          hw, lean, bow, fm::max(nodeWidth, nodeHeight),
             alpha, r.range(-.5f, .5f), young ? .14f : .05f};
  const Word nodeSeed = r.seedOf();
  Random nodeRandom(nodeSeed);
  StalkPlan pl;
  if (!stalkPlan(o, nodeRandom, pl))
    return false;
  const Word seed = r.seedOf();
  const float z = near || young ? 4 : 0;
  const float reach = hw * 1.5f + (fm::abs(lean) + fm::abs(bow)) * U * 1.15f + fm::abs(o.curve) * hw + 2;
  float data[12 + maxNodes] = {o.x, o.yb, o.yt, o.hw, o.lean, o.bow, o.seg, o.alpha, o.curve, o.taper, S, float(pl.n)};
  for (Word i = 0; i < pl.n; i++)
    data[12 + i] = pl.nodes[i];
  if (!add(p, stalkKind, z, x - reach, x + reach, seed, data, 12 + pl.n))
    return false;
  const Word available = selectNodes(pl, U * .02f, U * .34f);
  shuffleNodes(available, r);
  const Word wanted = 1 + r.bucket(near ? 3 : 2), count = available < wanted ? available : wanted;
  float ys[8], sides[8];
  Word n = 0;
  for (Word i = 0; i < count; i++) {
    ys[n] = work.selected[i];
    sides[n] = r.chance(62, 100) ? -1 : 1;
    n++;
  }
  if (r.chance(2, 5)) {
    const Word low = selectNodes(pl, U * .64f, U * .92f);
    if (low) {
      ys[n] = work.selected[r.bucket(low)];
      sides[n] = r.chance(1, 2) ? -1 : 1;
      n++;
    }
  }
  if (n > 8)
    return fail(82);
  for (Word i = 0; i < n; i++) {
    const float y = ys[i], side = sides[i], f = near ? 1 : .7f;
    const float angle = -fm::pi * .5f + stalkTilt(o, y) + side * r.range(.66f, 1.05f),
                len = r.range(90, 160) * S * k * f, leafLen = r.range(130, 185) * S * k * f;
    const float tx = stalkX(o, y) + side * hw * .7f;
    const Word sd = r.seedOf();
    const float R = twigReach(len, leafLen, S);
    const float twigData[9] = {
        tx, y, angle, len, fm::max(1.2f * S, hw * .12f), S, leafLen, alpha, fm::min(1, alpha * 1.02f)};
    if (!add(p, twigKind, z + 1, tx - R, tx + R, sd, twigData, 9))
      return false;
  }
  return true;
}
} // namespace bamboo
} // namespace painter

namespace painter {
inline bool planBamboo(ClosePlan& p, int j, Random& r) {
  if (error || cellStatus)
    return false;
  const float U = config.H, S = U / 900, k = config.kc;
  if (!(U > 0 && k > 0))
    return bamboo::fail(81);
  const bamboo::Station s = bamboo::station(j, U);
  const Word tufts = r.chance(3, 5) ? 1 : 2;
  for (Word q = 0; q < tufts; q++)
    if (r.chance(7, 10)) {
      const float x = (float(j) + r.r()) * s.cw, y = U * r.range(1, 1.035f);
      const Word sd = r.seedOf();
      const float a = r.range(.45f, .8f);
      const float values[4] = {x, y, S * k, a};
      if (!bamboo::add(p, bamboo::grassKind, 3, x - .16f * U, x + .16f * U, sd, values, 4))
        return false;
    }
  if (s.kind == 0) {
    const Word full = s.x == config.hero && s.vBits == 0x66666666u ? 2 : s.vBits == 0x66666667u ? 1 : 0;
    const Word pale = full == 2 ? 1 + r.bucket(2) : full ? r.bucket(3) : r.chance(55, 100) ? 1 : 0;
    float side = r.chance(1, 2) ? -1 : 1;
    for (Word q = 0; q < pale; q++, side = -side) {
      const float offset = r.range(.12f, .3f);
      if (!bamboo::planStem(p, s.x + offset * side * U * k, false, r, U, S, k))
        return false;
    }
    if (!bamboo::planStem(p, s.x, true, r, U, S, k))
      return false;
    const bool second = full == 2 ? r.chance(3, 4) : full ? r.chance(1, 2) : Wide(s.vBits) * 100 < (Wide(30) << 32);
    if (second) {
      const float offset = r.range(.07f, .13f), to = r.chance(1, 2) ? -1 : 1;
      if (!bamboo::planStem(p, s.x + offset * to * U * k, true, r, U, S, k))
        return false;
    }
    const Word young = full == 2 ? 1 + r.bucket(2) : full ? r.bucket(3) : !second && r.chance(35, 100) ? 1 : 0;
    side = r.chance(1, 2) ? -1 : 1;
    for (Word q = 0; q < young; q++, side = -side) {
      const float offset = r.range(.035f, .09f) + .07f * float(q);
      if (!bamboo::planStem(p, s.x + offset * side * U * k, false, r, U, S, k, true))
        return false;
    }
  } else if (s.kind == 2) {
    if (!bamboo::planStem(p, s.x, false, r, U, S, k))
      return false;
  } else {
    if (Wide(s.vBits) * 100 < (Wide(35) << 32)) {
      const float offset = r.range(.1f, .3f), side = r.chance(1, 2) ? -1 : 1;
      if (!bamboo::planStem(p, s.x + offset * side * U * k, false, r, U, S, k))
        return false;
    }
    const Word sprays = r.chance(2, 5) ? 2 : 1;
    for (Word q = sprays; q > 0; q--) {
      const bool near = q == 1;
      const float f = near ? 1 : .72f;
      float x = s.x;
      if (!near) {
        const float offset = r.range(.08f, .25f), side = r.chance(1, 2) ? -1 : 1;
        x += offset * side * U * k;
      }
      const float angle = fm::pi * .5f + r.range(-.45f, .5f), len = r.range(.1f, .2f) * U * f,
                  leafLen = r.range(85, 125) * S * k * f;
      const float a = near ? r.range(.76f, .9f) : r.range(.3f, .42f);
      const Word sd = r.seedOf();
      const float R = bamboo::twigReach(len, leafLen, S);
      const float data[9] = {x, -.07f * U, angle, len, 2.2f * S * k * f, S, leafLen, a, a};
      if (!bamboo::add(p, bamboo::twigKind, near ? 5 : 1, x - R, x + R, sd, data, 9))
        return false;
    }
  }
  return !error && !cellStatus;
}
inline bool drawBambooStroke(Word h, const Stroke& stroke, const float* data) {
  if (error || cellStatus)
    return false;
  Random r(stroke.seed);
  if (stroke.kind == bamboo::stalkKind) {
    if (stroke.count < 14 || stroke.count > 12 + bamboo::maxNodes)
      return bamboo::fail(89);
    const float nf = data[11];
    if (!(nf >= 2 && nf <= bamboo::maxNodes && nf == fm::floor(nf)))
      return bamboo::fail(89);
    const Word n = Word(nf);
    if (stroke.count != 12 + n)
      return bamboo::fail(89);
    const bamboo::Stalk o = {data[0], data[1], data[2], data[3], data[4], data[5], data[6], data[7], data[8], data[9]};
    bamboo::StalkPlan p;
    p.n = n;
    for (Word i = 0; i < n; i++)
      p.nodes[i] = data[12 + i];
    return bamboo::stalk(h, o, r, data[10], p);
  }
  if (stroke.kind == bamboo::twigKind) {
    if (stroke.count != 9)
      return bamboo::fail(89);
    return bamboo::twig(h, data[0], data[1], data[2], data[3], data[4], bamboo::leafInk, data[8], r, data[5], data[6],
                        data[7], true);
  }
  if (stroke.kind == bamboo::grassKind) {
    if (stroke.count != 4)
      return bamboo::fail(89);
    return bamboo::grass(h, data[0], data[1], r, data[2], bamboo::leafInk, data[3], true);
  }
  return bamboo::fail(89);
}
} // namespace painter
