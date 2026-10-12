#pragma once
#include "cpu-math.hpp"
namespace animation {
using A = unsigned int;
constexpr A motionCount = 8, motionStride = 16, rowCapacity = 4096, rowStride = 12, curveCapacity = 128,
            curveStride = 80, outputStride = 4;
alignas(16) static float motions[motionCount * motionStride], rows[rowCapacity * rowStride],
    curves[curveCapacity * curveStride], output[rowCapacity * outputStride], scene[32], noise[1024];
static A metadata[16], noiseMade;
inline v128_t splat(float n) {
  return wasm_f32x4_splat(n);
}
inline v128_t bounded(v128_t n) {
  return wasm_f32x4_min(splat(1), wasm_f32x4_max(splat(0), n));
}
inline v128_t gather(const float* data, A stride, A first, A field) {
  return wasm_f32x4_make(data[first * stride + field], data[(first + 1) * stride + field],
                         data[(first + 2) * stride + field], data[(first + 3) * stride + field]);
}
inline void scatter(float* data, A stride, A first, A field, v128_t n) {
  float v[4];
  wasm_v128_store(v, n);
  for (A k = 0; k < 4; k++)
    data[(first + k) * stride + field] = v[k];
}
inline float exponential(float n) {
  return fm::exp2(n * 1.44269504089f);
}
inline float bounce(float t) {
  constexpr float n = 7.5625f, d = 2.75f;
  if (t < 1 / d)
    return n * t * t;
  if (t < 2 / d) {
    t -= 1.5f / d;
    return n * t * t + .75f;
  }
  if (t < 2.5f / d) {
    t -= 2.25f / d;
    return n * t * t + .9375f;
  }
  t -= 2.625f / d;
  return n * t * t + .984375f;
}
inline float inward(const float* c, float t) {
  switch (A(c[0])) {
  case 3:
    return 1 - fm::cos(t * fm::pi * .5f);
  case 4:
    return t * t;
  case 5:
    return t * t * t;
  case 6:
    return t * t * t * t;
  case 7:
    return t * t * t * t * t;
  case 8:
    return fm::pow(t, c[2]);
  case 9:
    return t <= 0 ? 0 : fm::exp2(10 * t - 10);
  case 10:
    return 1 - fm::sqrt(fm::max(0, 1 - t * t));
  case 11:
    return (c[3] + 1) * t * t * t - c[3] * t * t;
  case 12: {
    float a = fm::max(1, c[4]), p = fm::max(.05f, c[5]), s = p / fm::tau * (fm::pi * .5f - fm::acos(1 / a));
    return t <= 0 ? 0 : t >= 1 ? 1 : -a * fm::exp2(10 * (t - 1)) * fm::sin((t - 1 - s) * fm::tau / p);
  }
  case 13:
    return 1 - bounce(1 - t);
  default:
    return t;
  }
}
inline float scalarCurve(const float* c, float t) {
  A kind = A(c[0]);
  if (kind == 0)
    return t;
  if (kind == 2) {
    A n = A(c[10]);
    if (n < 2)
      return t;
    float p = fm::clamp(t, 0, 1) * float(n - 1);
    A i = A(fm::floor(p));
    if (i >= n - 1)
      i = n - 2;
    return fm::lerp(c[11 + i], c[12 + i], p - float(i));
  }
  A mode = A(c[1]);
  return mode == 0   ? inward(c, t)
         : mode == 1 ? (t < .5f ? inward(c, 2 * t) * .5f : 1 - inward(c, 2 - 2 * t) * .5f)
                     : 1 - inward(c, 1 - t);
}
inline v128_t bezier(v128_t a, v128_t b, v128_t u) {
  auto one = wasm_f32x4_sub(splat(1), u), uu = wasm_f32x4_mul(u, u);
  return wasm_f32x4_add(
      wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_mul(splat(3), a), u), wasm_f32x4_mul(one, one)),
                     wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_mul(splat(3), b), uu), one)),
      wasm_f32x4_mul(uu, u));
}
inline v128_t curve4(v128_t t, const A* ids) {
  float tv[4], yv[4];
  wasm_v128_store(tv, t);
  A activeBezier = 0;
  for (A k = 0; k < 4; k++) {
    const float* p = curves + ids[k] * curveStride;
    if (A(p[0]) != 1)
      yv[k] = scalarCurve(p, tv[k]);
    else if (tv[k] > 0 && tv[k] < 1)
      activeBezier |= 1u << k;
    else
      yv[k] = tv[k] <= 0 ? 0 : 1;
  }
  if (!activeBezier)
    return wasm_v128_load(yv);
  const float *a = curves + ids[0] * curveStride, *b = curves + ids[1] * curveStride,
              *c = curves + ids[2] * curveStride, *d = curves + ids[3] * curveStride;
  auto x1 = wasm_f32x4_make(a[6], b[6], c[6], d[6]), x2 = wasm_f32x4_make(a[8], b[8], c[8], d[8]);
  auto lo = splat(0), hi = splat(1), u = t;
  for (A i = 0; i < 22; i++) {
    u = wasm_f32x4_mul(wasm_f32x4_add(lo, hi), splat(.5f));
    auto less = wasm_f32x4_lt(bezier(x1, x2, u), t);
    lo = wasm_v128_bitselect(u, lo, less);
    hi = wasm_v128_bitselect(hi, u, less);
  }
  auto y = bezier(wasm_f32x4_make(a[7], b[7], c[7], d[7]), wasm_f32x4_make(a[9], b[9], c[9], d[9]), u);
  float bezierValues[4];
  wasm_v128_store(bezierValues, y);
  for (A k = 0; k < 4; k++)
    if (activeBezier & (1u << k))
      yv[k] = bezierValues[k];
  return wasm_v128_load(yv);
}
inline float noiseAt(float x) {
  int i = int(fm::floor(x));
  float f = x - float(i), u = f * f * (3 - 2 * f);
  return noise[A(i) & 1023] * (1 - u) + noise[A(i + 1) & 1023] * u;
}
inline void clockAdd(A value, A correction, float delta) {
  float y = delta - scene[correction], t = scene[value] + y;
  scene[correction] = (t - scene[value]) - y;
  scene[value] = t;
}
inline void stepMotions(float dt, float dts, float slow) {
  if (!noiseMade) {
    fm::RNG r = {1337};
    for (A i = 0; i < 1024; i++)
      noise[i] = float(r.next()) * (1.0f / 4294967296.0f);
    noiseMade = 1;
  }
  clockAdd(0, 22, dt);
  clockAdd(1, 23, dts);
  for (A k = 0; k < 2; k++) {
    float m = fm::max(-1.0f, fm::min(1.0f, scene[8 + k])), goal = m * (1.5f - .5f * m * m), w = 6,
          d = scene[2 + k] - goal, e = exponential(-w * dt), g = scene[24 + k] + w * d;
    scene[2 + k] = goal + (d + g * dt) * e;
    scene[24 + k] = (scene[24 + k] - w * g * dt) * e;
  }
  scene[4] += (scene[10] - scene[4]) * (1 - exponential(-dt / (scene[10] > scene[4] ? .16f : .55f)));
  scene[5] = scene[12] > .005f ? scene[5] + (scene[11] - scene[5]) * (1 - exponential(-dts / scene[12])) : scene[11];
  motions[2] = scene[5];
  for (A first = 0; first < 8; first += 4) {
    float elapsed[4], counts[4], hs[4];
    A ids[4], steps = 1;
    for (A k = 0; k < 4; k++) {
      float* m = motions + (first + k) * motionStride;
      elapsed[k] = (first + k == 6 ? dts / fm::max(.001f, slow) : dts);
      ids[k] = A(m[11]);
      counts[k] = fm::max(1, fm::ceil(elapsed[k] * 240));
      if (A(counts[k]) > steps)
        steps = A(counts[k]);
      hs[k] = elapsed[k] / counts[k];
      if (m[3] != m[12]) {
        m[12] = m[3];
        m[8] = m[0];
        m[9] = m[2];
        m[10] = 0;
      }
      if (A(m[3]) == 2 && m[2] != m[9]) {
        m[8] = m[0];
        m[9] = m[2];
        m[10] = 0;
      }
    }
    auto x0 = gather(motions, motionStride, first, 0), x = x0, v = gather(motions, motionStride, first, 1),
         target = gather(motions, motionStride, first, 2);
    auto type = gather(motions, motionStride, first, 3),
         active = wasm_f32x4_gt(gather(motions, motionStride, first, 13), splat(0));
    auto spring = wasm_v128_and(wasm_f32x4_eq(type, splat(0)), active);
    auto stiffness = wasm_f32x4_max(splat(.01f), gather(motions, motionStride, first, 4));
    auto damping =
        wasm_f32x4_mul(wasm_f32x4_mul(splat(2), wasm_f32x4_sqrt(stiffness)), gather(motions, motionStride, first, 5));
    auto h = wasm_v128_load(hs), stepCounts = wasm_v128_load(counts);
    for (A i = 0; i < steps; i++) {
      auto springStep = wasm_v128_and(spring, wasm_f32x4_gt(stepCounts, splat(float(i))));
      auto acceleration =
          wasm_f32x4_sub(wasm_f32x4_mul(stiffness, wasm_f32x4_sub(target, x)), wasm_f32x4_mul(damping, v));
      auto nv = wasm_f32x4_add(v, wasm_f32x4_mul(acceleration, h));
      v = wasm_v128_bitselect(nv, v, springStep);
      x = wasm_v128_bitselect(wasm_f32x4_add(x, wasm_f32x4_mul(v, h)), x, springStep);
    }
    float factors[4];
    for (A k = 0; k < 4; k++) {
      float* m = motions + (first + k) * motionStride;
      factors[k] = 1 - exponential(-elapsed[k] / fm::max(.005f, m[6]));
    }
    auto exponentialMask = wasm_v128_and(wasm_f32x4_eq(type, splat(1)), active);
    x = wasm_v128_bitselect(wasm_f32x4_add(x0, wasm_f32x4_mul(wasm_f32x4_sub(target, x0), wasm_v128_load(factors))), x,
                            exponentialMask);
    auto durations = wasm_f32x4_max(splat(.01f), gather(motions, motionStride, first, 7));
    auto progress = wasm_f32x4_min(splat(1), wasm_f32x4_add(gather(motions, motionStride, first, 10),
                                                            wasm_f32x4_div(wasm_v128_load(elapsed), durations)));
    auto eased = curve4(progress, ids), from = gather(motions, motionStride, first, 8),
         goal = gather(motions, motionStride, first, 9);
    auto tweenX = wasm_f32x4_add(from, wasm_f32x4_mul(wasm_f32x4_sub(goal, from), eased));
    tweenX = wasm_v128_bitselect(goal, tweenX, wasm_f32x4_ge(progress, splat(1)));
    auto tween = wasm_v128_and(wasm_f32x4_eq(type, splat(2)), active);
    x = wasm_v128_bitselect(tweenX, x, tween);
    auto velocities =
        wasm_f32x4_div(wasm_f32x4_sub(x, x0), wasm_f32x4_max(splat(.000000001f), wasm_v128_load(elapsed)));
    v = wasm_v128_bitselect(velocities, v,
                            wasm_v128_and(wasm_v128_not(spring), wasm_f32x4_gt(wasm_v128_load(elapsed), splat(0))));
    scatter(motions, motionStride, first, 0, x);
    scatter(motions, motionStride, first, 1, v);
    float pv[4];
    wasm_v128_store(pv, progress);
    for (A k = 0; k < 4; k++) {
      float* m = motions + (first + k) * motionStride;
      if (A(m[3]) == 0) {
        m[9] = m[2];
        m[10] = 1;
      } else if (A(m[3]) == 1)
        m[9] = m[2];
      else
        m[10] = pv[k];
    }
  }
  float page = motions[6 * motionStride], box = motions[7 * motionStride];
  scene[17] = page;
  scene[19] = box;
  float pt = fm::clamp(((scene[6] ? 1 - page : page) - .1f) / .8f, 0, 1),
        bt = fm::clamp(((scene[7] ? 1 - box : box) - .1f) / .8f, 0, 1);
  if (pt >= .999f) {
    scene[6] = scene[6] ? 0 : 1;
    pt = 0;
  }
  if (bt >= .999f) {
    scene[7] = scene[7] ? 0 : 1;
    bt = 0;
  }
  scene[16] = pt;
  scene[18] = bt;
  if (scene[14] == 1) {
    scene[6] = 0;
    scene[16] = 0;
  } else if (scene[14] == 2) {
    scene[6] = 1;
    scene[16] = 0;
  } else if (scene[14] == 3) {
    scene[6] = 0;
    scene[16] = scene[15];
  }
  scene[20] = .85f + .35f * noiseAt(scene[0] * .13f + 3) + .15f * fm::sin(scene[0] * .21f);
}
inline void evaluateRows(A count, float textTime, float uiTime) {
  for (A first = 0; first < count; first += 4) {
    float ages[4], durations[4], inputs[4], progresses[4];
    A ids[4];
    for (A k = 0; k < 4; k++) {
      const float* r = rows + (first + k) * rowStride;
      ages[k] = (r[0] == 0 ? textTime : uiTime) - r[2];
      durations[k] = fm::max(.001f, r[3]);
      progresses[k] = fm::clamp((ages[k] - r[4]) / durations[k], 0, 1);
      inputs[k] = progresses[k];
      ids[k] = A(r[1]);
      if (A(r[7]) == 1) {
        float split = fm::clamp(r[8], .001f, .999f);
        inputs[k] = progresses[k] < split ? progresses[k] / split : (progresses[k] - split) / (1 - split);
      }
    }
    float eased[4];
    wasm_v128_store(eased, curve4(wasm_v128_load(inputs), ids));
    auto from = gather(rows, rowStride, first, 5), to = gather(rows, rowStride, first, 6);
    for (A k = 0; k < 4; k++) {
      const float* r = rows + (first + k) * rowStride;
      A type = A(r[7]), flags = A(r[10]);
      if ((flags & 1) && progresses[k] <= 0)
        eased[k] = 0;
      if ((flags & 2) && progresses[k] >= 1)
        eased[k] = 1;
      if (type == 1) {
        if (progresses[k] >= r[8])
          eased[k] = 1 - eased[k];
        if (ages[k] - r[4] < 0 || ages[k] - r[4] >= durations[k])
          eased[k] = 0;
      }
      if (type == 2) {
        float age = fm::max(0, ages[k]), phase = (age - fm::floor(age / durations[k]) * durations[k]) / durations[k];
        progresses[k] = phase;
        eased[k] = phase >= r[8] ? 1 : 0;
      }
    }
    auto value = wasm_f32x4_add(from, wasm_f32x4_mul(wasm_f32x4_sub(to, from), wasm_v128_load(eased)));
    float values[4];
    wasm_v128_store(values, value);
    for (A k = 0; k < 4 && first + k < count; k++) {
      const float* r = rows + (first + k) * rowStride;
      float* o = output + (first + k) * outputStride;
      o[0] = progresses[k];
      o[1] = eased[k];
      o[2] = r[9] ? fm::clamp(values[k], 0, 1) : values[k];
      o[3] = ages[k];
    }
  }
}
} // namespace animation
extern "C" {
unsigned an_info() {
  using namespace animation;
  metadata[0] = (A)motions;
  metadata[1] = (A)rows;
  metadata[2] = (A)output;
  metadata[3] = (A)curves;
  metadata[4] = (A)scene;
  metadata[5] = rowCapacity;
  metadata[6] = curveCapacity;
  metadata[7] = motionStride;
  metadata[8] = rowStride;
  metadata[9] = curveStride;
  metadata[10] = outputStride;
  metadata[11] = sizeof(motions) + sizeof(rows) + sizeof(output) + sizeof(curves) + sizeof(scene) + sizeof(noise) +
                 sizeof(metadata);
  return (A)metadata;
}
unsigned an_frame(unsigned count, unsigned curveCount, float dt, float dts, float slow, float textTime, float uiTime) {
  if (count > animation::rowCapacity || !curveCount || curveCount > animation::curveCapacity ||
      !__builtin_isfinite(dt) || !__builtin_isfinite(dts) || !__builtin_isfinite(slow) || dt < 0 || dts < 0 ||
      slow <= 0)
    return 0;
  for (unsigned i = 0; i < count; i++)
    if (!(animation::rows[i * animation::rowStride + 1] >= 0 &&
          animation::rows[i * animation::rowStride + 1] < float(curveCount)))
      return 0;
  animation::stepMotions(dt, dts, slow);
  animation::evaluateRows(count, textTime, uiTime);
  return 1;
}
}
