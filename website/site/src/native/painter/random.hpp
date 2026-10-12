#pragma once
#include "../cpu-math.hpp"

namespace painter {
using Word = unsigned int;
using Wide = unsigned long long;
constexpr float inverse32 = 1.0f / 4294967296.0f;
constexpr float inverse24 = 1.0f / 16777216.0f;

struct Random {
  fm::RNG rng;
  Word draws = 0;
  explicit Random(Word state) : rng{state} {}
  Word raw() {
    ++draws;
    return rng.next();
  }
  float r() { return float(raw() >> 8) * inverse24; }
  float range(float a, float b) { return a + (b - a) * r(); }
  Word state() const { return rng.state; }
  void setState(Word value) { rng.state = value; }
  Word bucket(Word n) { return Word((Wide(raw()) * n) >> 32); }
  bool chance(Word numerator, Word denominator) { return Wide(raw()) * denominator < (Wide(numerator) << 32); }
  Word seedOf() { return raw(); }
  Word brushSeed() { return Word((Wide(raw()) * 1000000000ull) >> 32); }
  bool less(float threshold) {
    const Word bits = raw();
    if (!(threshold > 0))
      return false;
    if (threshold >= 1)
      return true;
    return Wide(bits) < Wide(fm::ceil(threshold * 4294967296.0f));
  }
  bool greater(float threshold) {
    const Word bits = raw();
    if (threshold < 0)
      return true;
    if (!(threshold < 1))
      return false;
    return Wide(bits) > Wide(fm::floor(threshold * 4294967296.0f));
  }
};

static Word worldSalt = 0;
inline Word cellSeed(Word a, Word b, int c) {
  Word h = (a ^ worldSalt ^ 0x9e3779b9u) * 0x85ebca6bu ^ (b + 0x632be5abu) * 0xc2b2ae35u ^ Word(c) * 0x27d4eb2fu;
  h ^= h >> 15;
  h *= 0x2c1b3c6du;
  h ^= h >> 12;
  h *= 0x297a2d39u;
  h ^= h >> 15;
  return h;
}

struct Noise1 {
  float values[1024];
  bool ready = false;
  Word salt = 0;
  void reseed(Word value) {
    if (value != salt) {
      salt = value;
      ready = false;
    }
  }
  void init() {
    if (ready)
      return;
    fm::RNG r{1337u ^ salt};
    for (float& value : values)
      value = float(r.next()) * inverse32;
    ready = true;
  }
  float at(float x) {
    init();
    const int i = int(fm::floor(x));
    const float f = x - float(i), u = f * f * (3 - 2 * f);
    return values[Word(i) & 1023] * (1 - u) + values[(Word(i) + 1) & 1023] * u;
  }
  v128_t four(v128_t x) {
    init();
    const v128_t base = wasm_f32x4_floor(x);
    const v128_t f = wasm_f32x4_sub(x, base);
    const v128_t u = wasm_f32x4_mul(wasm_f32x4_mul(f, f),
                                    wasm_f32x4_sub(wasm_f32x4_splat(3), wasm_f32x4_mul(wasm_f32x4_splat(2), f)));
    const Word i0 = Word(int(wasm_f32x4_extract_lane(base, 0))) & 1023;
    const Word i1 = Word(int(wasm_f32x4_extract_lane(base, 1))) & 1023;
    const Word i2 = Word(int(wasm_f32x4_extract_lane(base, 2))) & 1023;
    const Word i3 = Word(int(wasm_f32x4_extract_lane(base, 3))) & 1023;
    const v128_t a = wasm_f32x4_make(values[i0], values[i1], values[i2], values[i3]);
    const v128_t b = wasm_f32x4_make(values[(i0 + 1) & 1023], values[(i1 + 1) & 1023], values[(i2 + 1) & 1023],
                                     values[(i3 + 1) & 1023]);
    return wasm_f32x4_add(wasm_f32x4_mul(a, wasm_f32x4_sub(wasm_f32x4_splat(1), u)), wasm_f32x4_mul(b, u));
  }
};

template <Word Period> struct PeriodicNoise {
  static_assert(Period > 0 && Period <= 128, "Painter noise grid is bounded");
  float values[Period * Period];
  Word seed = 0;
  bool ready = false;
  void init(Word value) {
    if (ready && seed == value)
      return;
    fm::RNG r{value};
    for (float& cell : values)
      cell = float(r.next()) * inverse32;
    seed = value;
    ready = true;
  }
  float at(float x, float y) const {
    const int xi = int(fm::floor(x)), yi = int(fm::floor(y));
    const float xf = x - float(xi), yf = y - float(yi);
    const float u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const Word x0 = Word((xi % int(Period) + int(Period)) % int(Period));
    const Word y0 = Word((yi % int(Period) + int(Period)) % int(Period));
    const Word x1 = (x0 + 1) % Period, y1 = (y0 + 1) % Period;
    return (values[x0 + y0 * Period] * (1 - u) + values[x1 + y0 * Period] * u) * (1 - v) +
           (values[x0 + y1 * Period] * (1 - u) + values[x1 + y1 * Period] * u) * v;
  }
};
} // namespace painter
