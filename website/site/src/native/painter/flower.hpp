#pragma once
#include "random.hpp"
#include "canvas.hpp"

namespace painter {
namespace isolated_flower {
struct Input {
  float x, y, radius, rotation, scale, tone, alpha;
  pc::Pen inherited;
  bool outline, stamps;
};
struct Result {
  Word state = 0, draws = 0, count = 0, status = 0, fillQ3 = 0, strokeQ3 = 0;
  float lineWidth = 0;
  Word lineCap = 1;
};
inline Word toneQ3(float tone, Word percent) {
  if (!(tone > 0) || !percent)
    return 0;
  if (tone >= 100.f / float(percent))
    return 1000;
  union {
    float f;
    Word bits;
  } value{tone};
  const Word exponent = (value.bits >> 23) & 255u;
  const Word mantissa = (value.bits & 0x7fffffu) | (exponent ? 0x800000u : 0u);
  const Word shift = exponent ? 150u - exponent : 149u;
  if (shift >= 64)
    return 0;
  const Wide numerator = Wide(mantissa) * Wide(10u * percent);
  const Wide rounded = (numerator + (Wide(1) << (shift - 1))) >> shift;
  return rounded > 1000 ? 1000 : Word(rounded);
}
inline pc::Color color(int r, int g, int b, Word q) {
  return pc::colorBytes(r, g, b, q);
}
__attribute__((noinline)) inline void endpointPair(float* out, float x, float y, float ca0, float sa0, float length0,
                                                   float ca1, float sa1, float length1) {
  const auto directions = wasm_f32x4_make(ca0, sa0, ca1, sa1);
  const auto lengths = wasm_f32x4_make(length0, length0, length1, length1);
  wasm_v128_store(out, wasm_f32x4_add(wasm_f32x4_make(x, y, x, y), wasm_f32x4_mul(directions, lengths)));
}
inline U petalPath(U h, float r) {
  return pc::move(h, 0, 0) && pc::cubic(h, r * .22f, -r * .2f, r * .5f, -r * .56f, r * .84f, -r * .42f) &&
         pc::quadratic(h, r * 1.02f, -r * .33f, r * .99f, -r * .1f) && pc::line(h, r * .86f, -r * .01f) &&
         pc::line(h, r * .99f, r * .09f) && pc::quadratic(h, r * 1.02f, r * .33f, r * .84f, r * .42f) &&
         pc::cubic(h, r * .5f, r * .56f, r * .22f, r * .2f, 0, 0);
}
inline Result draw(U h, Word state, const Input& in) {
  Result out;
  out.state = state;
  if (!h || h > MAX_BANKS || !canvases[h - 1].used) {
    out.status = 0xf001u;
    return out;
  }
  if (error) {
    out.status = error;
    return out;
  }
  if (!finite(in.x) || !finite(in.y) || !finite(in.radius) || in.radius <= 0 || !finite(in.rotation) ||
      !finite(in.scale) || in.scale <= 0 || !finite(in.tone) || !finite(in.alpha) || in.alpha < 0 || in.alpha > 1 ||
      !finite(in.inherited.miter) || in.inherited.miter <= 0 || in.inherited.cap > 2 || in.inherited.join > 2) {
    out.status = 0xf002u;
    return out;
  }
  Random random(state);
  auto finish = [&](Word status) {
    out.state = random.state();
    out.draws = random.draws;
    out.status = status;
    return out;
  };
  auto failed = [&]() { return finish(error ? error : 0xf003u); };
  out.fillQ3 = toneQ3(in.tone, 62);
  out.strokeQ3 = toneQ3(in.tone, 42);
  out.lineWidth = .5f * in.scale;
  float v[32] = {}, tips[22] = {};
  pc::Paint gradient = {};
  bool hasGradient = false;
  for (Word k = 0; k < 5; k++) {
    const float angle = in.rotation + float(k) * fm::tau / 5.f + random.range(-.1f, .1f);
    const float radius = in.radius * random.range(.86f, 1.04f);
    const float sy = random.range(.9f, 1.08f);
    bool accepted = false;
    if (in.stamps) {
      memset(v, 0, sizeof v);
      v[0] = in.x;
      v[1] = in.y;
      v[2] = angle;
      v[3] = sy;
      v[4] = radius;
      v[6] = 2;
      v[7] = in.tone;
      v[8] = in.radius * 1.02f;
      v[9] = in.outline ? .7f * in.scale : 0;
      v[10] = pc::q3(toneQ3(in.tone, 36));
      v[11] = 4;
      v[16] = pc::q3(out.fillQ3);
      v[17] = pc::q3(toneQ3(in.tone, 55));
      v[18] = pc::q3(toneQ3(in.tone, 78));
      accepted = pc::stamp(h, 2, v, 19, in.alpha) != 0;
      if (error)
        return failed();
    }
    if (!accepted) {
      if (!hasGradient) {
        gradient = pc::radial(h, in.x, in.y, 0, in.x, in.y, in.radius * 1.02f);
        if (!pc::stop(gradient, 0, color(221, 131, 156, out.fillQ3)) ||
            !pc::stop(gradient, .3f, color(241, 186, 201, toneQ3(in.tone, 55))) ||
            !pc::stop(gradient, 1, color(251, 229, 234, toneQ3(in.tone, 78))))
          return failed();
        hasGradient = true;
      }
      if (!pc::save(h))
        return failed();
      const bool transformed = pc::translate(h, in.x, in.y) && pc::rotate(h, angle) && pc::scale(h, 1, sy);
      if (transformed)
        pc::begin(h);
      const bool path = transformed && petalPath(h, radius);
      pc::restore(h);
      if (!path || !pc::fill(h, gradient, in.alpha) || error)
        return failed();
      if (in.outline) {
        auto pen = in.inherited;
        pen.width = .7f * in.scale;
        if (!pc::stroke(h, pc::solid(color(192, 104, 128, toneQ3(in.tone, 36))), in.alpha, pen) || error)
          return failed();
      }
    }
  }
  auto hardEllipse = [&](float x, float y, float radius, int red, int green, int blue, Word q) {
    if (in.stamps) {
      memset(v, 0, sizeof v);
      v[0] = x;
      v[1] = y;
      v[2] = v[3] = radius;
      v[6] = in.tone;
      v[7] = float(red) / 255.f;
      v[8] = float(green) / 255.f;
      v[9] = float(blue) / 255.f;
      v[10] = pc::q3(q);
      if (pc::stamp(h, 3, v, 15, in.alpha))
        return !error;
      if (error)
        return false;
    }
    pc::begin(h);
    return pc::arc(h, x, y, radius, 0, fm::tau) && pc::fill(h, pc::solid(color(red, green, blue, q)), in.alpha) &&
           !error;
  };
  if (!hardEllipse(in.x, in.y, in.radius * .16f, 176, 66, 98, toneQ3(in.tone, 60)))
    return failed();
  const Word n = 7 + random.bucket(5);
  out.count = n;
  memset(v, 0, sizeof v);
  v[0] = in.x;
  v[1] = in.y;
  v[2] = float(n);
  v[3] = .5f * in.scale;
  v[4] = pc::q3(out.strokeQ3);
  v[5] = 5;
  for (Word k = 0; k < n; k += 2) {
    const float angle0 = random.r() * fm::tau;
    const float length0 = in.radius * random.range(.32f, .56f);
    const Word j = k * 2;
    if (k + 1 < n) {
      const float angle1 = random.r() * fm::tau;
      const float length1 = in.radius * random.range(.32f, .56f);
      endpointPair(tips + j, in.x, in.y, fm::cos(angle0), fm::sin(angle0), length0, fm::cos(angle1), fm::sin(angle1),
                   length1);
      memcpy(v + 6 + j, tips + j, 16);
    } else {
      tips[j] = in.x + fm::cos(angle0) * length0;
      tips[j + 1] = in.y + fm::sin(angle0) * length0;
      v[6 + j] = tips[j];
      v[7 + j] = tips[j + 1];
    }
  }
  bool accepted = false;
  if (in.stamps) {
    accepted = pc::stamp(h, 4, v, 6 + n * 2, in.alpha) != 0;
    if (error)
      return failed();
  }
  if (!accepted) {
    pc::begin(h);
    for (Word k = 0; k < n; k++)
      if (!pc::move(h, in.x, in.y) || !pc::line(h, tips[k * 2], tips[k * 2 + 1]))
        return failed();
    auto pen = in.inherited;
    pen.width = out.lineWidth;
    pen.cap = 1;
    if (!pc::stroke(h, pc::solid(color(44, 31, 34, out.strokeQ3)), in.alpha, pen) || error)
      return failed();
  }
  for (Word k = 0; k < n; k++) {
    const float radius = random.range(.55f, 1.05f) * in.scale;
    if (!hardEllipse(tips[k * 2], tips[k * 2 + 1], radius, 44, 31, 34, out.fillQ3))
      return failed();
  }
  return finish(0);
}
} // namespace isolated_flower
} // namespace painter
