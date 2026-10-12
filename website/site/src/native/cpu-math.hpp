#pragma once
#include <wasm_simd128.h>
namespace fm {
constexpr float pi = 3.14159265358979323846f, tau = 6.28318530717958647692f;
inline float abs(float x) {
  return __builtin_fabsf(x);
}
inline float sqrt(float x) {
  return __builtin_sqrtf(x);
}
inline float floor(float x) {
  return __builtin_floorf(x);
}
inline float ceil(float x) {
  return __builtin_ceilf(x);
}
inline float min(float a, float b) {
  return a < b ? a : b;
}
inline float max(float a, float b) {
  return a > b ? a : b;
}
inline float clamp(float x, float a, float b) {
  return min(b, max(a, x));
}
inline float lerp(float a, float b, float t) {
  return a + (b - a) * t;
}
inline float smooth(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
inline float hypot(float x, float y) {
  float m = max(abs(x), abs(y));
  if (!m)
    return 0;
  x /= m;
  y /= m;
  return m * sqrt(x * x + y * y);
}
inline float sin(float x) {
  x -= floor(x / tau + .5f) * tau;
  if (x > pi * .5f)
    x = pi - x;
  else if (x < -pi * .5f)
    x = -pi - x;
  float z = x * x;
  return x * (1 + z * (-.1666666716f +
                       z * (.0083333477f + z * (-.0001984090f + z * (.0000027526f + z * (-.0000000239f))))));
}
inline float cos(float x) {
  return sin(x + pi * .5f);
}
inline float log2(float x) {
  if (!(x > 0))
    return -__builtin_inff();
  union {
    float f;
    unsigned u;
  } b = {x};
  int e = int((b.u >> 23) & 255) - 127;
  if (e == -127) {
    x *= 8388608.0f;
    b.f = x;
    e = int((b.u >> 23) & 255) - 150;
  }
  b.u = (b.u & 0x7fffffu) | 0x3f800000u;
  float z = (b.f - 1) / (b.f + 1), q = z * z;
  return float(e) +
         2.8853900818f * z *
             (1 + q * (.3333333333f + q * (.2f + q * (.1428571429f + q * (.1111111111f + q * .0909090909f)))));
}
inline float exp2(float x) {
  if (x < -126)
    return 0;
  if (x > 127)
    return __builtin_inff();
  int n = int(floor(x));
  float t = (x - float(n)) * .69314718056f;
  float p =
      1 + t * (1 + t * (.5f + t * (.1666666667f +
                                   t * (.0416666667f + t * (.0083333333f + t * (.0013888889f + t * .0001984127f))))));
  union {
    unsigned u;
    float f;
  } b = {unsigned(n + 127) << 23};
  return p * b.f;
}
inline float pow(float x, float p) {
  if (x == 0)
    return p == 0 ? 1 : 0;
  return exp2(log2(x) * p);
}
inline float acos(float x) {
  x = clamp(x, -1, 1);
  float a = abs(x);
  float r = (((-.0187293f * a + .0742610f) * a - .2121144f) * a + 1.5707288f) * sqrt(1 - a);
  return x < 0 ? pi - r : r;
}
struct RNG {
  unsigned state;
  unsigned next() {
    unsigned t = state += 0x6d2b79f5u;
    t = (t ^ (t >> 15)) * (t | 1);
    t ^= t + (t ^ (t >> 7)) * (t | 61);
    return t ^ (t >> 14);
  }
  float operator()() { return float(next() >> 8) * (1.0f / 16777216.0f); }
  float range(float a, float b) { return a + (b - a) * (*this)(); }
};
inline v128_t transformPair(const float* m, v128_t xy) {
  auto x = wasm_i32x4_shuffle(xy, xy, 0, 0, 2, 2), y = wasm_i32x4_shuffle(xy, xy, 1, 1, 3, 3);
  return wasm_f32x4_add(wasm_f32x4_add(wasm_f32x4_mul(x, wasm_f32x4_make(m[0], m[1], m[0], m[1])),
                                       wasm_f32x4_mul(y, wasm_f32x4_make(m[2], m[3], m[2], m[3]))),
                        wasm_f32x4_make(m[4], m[5], m[4], m[5]));
}
} // namespace fm
