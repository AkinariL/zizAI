#pragma once
namespace painter {
constexpr ColorBytes sakuraFarColor{150, 124, 132}, sakuraMidColor{96, 74, 80};
inline float groundAt(Word li, float x) {
  if (!li)
    return .61f + .035f * (2 * noise.at(x * 1.3f + 11) - 1) + .012f * (2 * noise.at(x * 4.1f + 3) - 1);
  if (li == 1)
    return .83f + .045f * (2 * noise.at(x * .85f + 37) - 1) + .012f * (2 * noise.at(x * 3.3f + 9) - 1);
  return groundNear(x);
}
inline float groveAt(Word li, float x) {
  return li == 0 ? fm::smooth(.12f, .55f, noise.at(x * 1.6f + 17)) : fm::smooth(.2f, .62f, noise.at(x * 1.1f + 41));
}
inline float tallAt(Word li, float x) {
  return .62f + .5f * noise.at(x * (li ? 2.2f : 3.1f) + (li ? 29 : 5));
}
inline bool sakuraFar(Word h, int j, Random& r) {
  const float U = config.H, S = U / 900, x = (float(j) + r.r()) * .02f, d = groveAt(0, x);
  if (r.greater(.25f + .75f * d))
    return true;
  const float yb = groundAt(0, x) + r.range(0, .016f), tall = tallAt(0, x);
  const float R = (.012f + .026f * d * fm::sqrt(r.r())) * U * tall;
  const float cx = x * U + r.range(-.3f, .3f) * R, cy = yb * U - R * r.range(.7f, 1.3f) - .004f * U;
  if (r.chance(3, 5)) {
    const float alpha = r.range(.08f, .15f), width = fm::max(.45f, r.range(.6f, 1.1f) * S);
    pc::Pen pen;
    pen.width = width;
    pen.cap = 1;
    pc::begin(h);
    if (!pc::move(h, x * U, yb * U))
      return false;
    const float control = x * U + r.range(-.3f, .3f) * R;
    if (!pc::quadratic(h, control, (yb * U + cy) * .5f, cx, cy + R * .2f) ||
        !pc::stroke(h, pc::solid(color(sakuraFarColor, alpha)), 1, pen))
      return false;
  }
  const float alpha = r.range(.17f, .28f) * (.6f + .4f * d);
  const Word n = 6 + r.bucket(6);
  constexpr ColorBytes tones[4] = {sakuraHaze, pink, sakuraHaze, sakuraRose};
  blossomCloud(h, cx, cy, R, alpha, r, n, tones, 4);
  return !error;
}
inline bool sakuraMid(Word h, int j, Random& r) {
  const float U = config.H, S = U / 900, x = (float(j) + r.range(.05f, .95f)) * .045f, d = groveAt(1, x);
  if (r.greater(.15f + .85f * d))
    return true;
  const float tall = tallAt(1, x), yb = groundAt(1, x) + r.range(.006f, .03f),
              height = (.08f + .13f * d) * tall * r.range(.8f, 1.2f);
  const float X0 = x * U, Y0 = yb * U, top = (yb - height) * U, X1 = X0 + r.range(-.25f, .15f) * height * U;
  const float back = r.r(), alpha = r.range(.3f, .5f) * fm::lerp(.55f, 1, back) * (.8f + .2f * d),
              width = fm::max(.6f, r.range(1.1f, 2.2f) * S);
  const float cx = (X0 + X1) * .5f + r.range(-.15f, .15f) * height * U;
  float xs[16], ys[16], ws[16], tips[10] = {X1, top};
  Word tipCount = 1;
  for (Word i = 0; i < 16; i += 4) {
    const auto s = wasm_f32x4_make(float(i) / 15, float(i + 1) / 15, float(i + 2) / 15, float(i + 3) / 15),
               u = wasm_f32x4_sub(wasm_f32x4_splat(1), s);
    auto xx = wasm_f32x4_add(
        wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_mul(u, u), wasm_f32x4_splat(X0)),
                       wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_mul(u, s), wasm_f32x4_splat(2)), wasm_f32x4_splat(cx))),
        wasm_f32x4_mul(wasm_f32x4_mul(s, s), wasm_f32x4_splat(X1)));
    wasm_v128_store(xs + i, xx);
    wasm_v128_store(ys + i, wasm_f32x4_add(wasm_f32x4_splat(Y0), wasm_f32x4_mul(s, wasm_f32x4_splat(top - Y0))));
    wasm_v128_store(ws + i,
                    wasm_f32x4_mul(wasm_f32x4_splat(width),
                                   wasm_f32x4_sub(wasm_f32x4_splat(1), wasm_f32x4_mul(s, wasm_f32x4_splat(.55f)))));
  }
  auto paint = pc::linear(h, 0, Y0, 0, top);
  pc::stop(paint, 0, color(sakuraMidColor, 0));
  pc::stop(paint, .38f, color(sakuraMidColor, alpha));
  pc::stop(paint, 1, color(sakuraMidColor, alpha));
  ribbon(h, xs, ys, ws, 16, -1, 1);
  if (!pc::fill(h, paint))
    return false;
  const Word branches = 2 + r.bucket(3);
  pc::Pen pen;
  pen.cap = 1;
  for (Word q = 0; q < branches; q++) {
    const float s = r.range(.45f, .95f);
    Word i = Word(fm::floor(s * 15 + .5f));
    if (i > 15)
      i = 15;
    const float sign = r.chance(1, 2) ? -1.f : 1.f, angle = -fm::pi * .5f + sign * r.range(.35f, 1.15f),
                length = r.range(.3f, .6f) * height * U;
    const float ex = xs[i] + fm::cos(angle) * length, ey = ys[i] + fm::sin(angle) * length;
    pen.width = fm::max(.45f, width * .5f * (1 - .4f * s));
    pc::begin(h);
    pc::move(h, xs[i], ys[i]);
    pc::quadratic(h, (xs[i] + ex) * .5f, (ys[i] + ey) * .5f + .1f * length, ex, ey);
    if (!pc::stroke(h, pc::solid(color(sakuraMidColor, alpha * .9f)), 1, pen))
      return false;
    tips[tipCount * 2] = ex;
    tips[tipCount * 2 + 1] = ey;
    tipCount++;
  }
  const float R = (.03f + .036f * d) * tall * U;
  constexpr ColorBytes large[4] = {pinkPale, pink, sakuraHaze, pink}, small[2] = {sakuraRose, sakuraHaze};
  for (Word i = 0; i < tipCount; i++) {
    const float radius = R * r.range(.8f, 1.2f);
    const Word n = 10 + r.bucket(6);
    blossomCloud(h, tips[i * 2], tips[i * 2 + 1], radius, alpha, r, n, large, 4);
    if (error)
      return false;
  }
  for (Word i = 0; i < tipCount; i++) {
    const float cx = tips[i * 2] + r.range(-.3f, .3f) * R, cy = tips[i * 2 + 1] + r.range(-.2f, .35f) * R;
    blossomCloud(h, cx, cy, R * .55f, alpha * .7f, r, 4, small, 2);
    if (error)
      return false;
  }
  return true;
}
} // namespace painter
