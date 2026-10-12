constexpr U STAMP_FIELD_SIDE = 256, STAMP_FIELD_LAYERS = 2, STAMP_FIELD_N = 48;
constexpr U STAMP_FIELD_TEXELS = STAMP_FIELD_SIDE * STAMP_FIELD_SIDE;
struct StampFieldPoint {
  D x, y;
};
struct StampFieldSegment {
  D x, y, dx, dy, inverseLengthSquared;
};
alignas(16) static unsigned short stampFieldPixels[STAMP_FIELD_TEXELS * STAMP_FIELD_LAYERS * 4];
alignas(16) static D stampFieldDistances[STAMP_FIELD_TEXELS];
static U stampFieldBuildCount;

static unsigned short stampFieldHalf(D value) {
  union {
    D f;
    U u;
  } bits = {value};
  U sign = (bits.u >> 16) & 0x8000u, m = bits.u & 0x7fffffu;
  int exponent = (int)((bits.u >> 23) & 255u) - 112;
  if (exponent >= 31)
    return (unsigned short)(sign | 0x7c00u | (m ? 0x200u : 0u));
  if (exponent <= 0) {
    if (exponent < -10)
      return (unsigned short)sign;
    m |= 0x800000u;
    U shift = (U)(14 - exponent);
    return (unsigned short)(sign | ((m + ((1u << (shift - 1)) - 1u) + ((m >> shift) & 1u)) >> shift));
  }
  U rounded = m + 0xfffu + ((m >> 13) & 1u);
  return (unsigned short)(sign | ((U)(exponent + (int)(rounded >> 23)) << 10) | ((rounded >> 13) & 1023u));
}
static void stampFieldLine(StampFieldPoint* points, U& n, D x, D y) {
  points[n++] = {x, y};
}
static void stampFieldQuadratic(StampFieldPoint* points, U& n, D cx, D cy, D x, D y) {
  StampFieldPoint start = points[n - 1];
  for (U i = 1; i <= STAMP_FIELD_N; i++) {
    D t = (D)i / (D)STAMP_FIELD_N, a = 1.0f - t;
    stampFieldLine(points, n, a * a * start.x + 2.0f * a * t * cx + t * t * x,
                   a * a * start.y + 2.0f * a * t * cy + t * t * y);
  }
}
static void stampFieldCubic(StampFieldPoint* points, U& n, D ax, D ay, D bx, D by, D x, D y) {
  StampFieldPoint start = points[n - 1];
  for (U i = 1; i <= STAMP_FIELD_N; i++) {
    D t = (D)i / (D)STAMP_FIELD_N, a = 1.0f - t;
    stampFieldLine(points, n, a * a * a * start.x + 3.0f * a * a * t * ax + 3.0f * a * t * t * bx + t * t * t * x,
                   a * a * a * start.y + 3.0f * a * a * t * ay + 3.0f * a * t * t * by + t * t * t * y);
  }
}
static void stampFieldLayer(U layer) {
  StampFieldPoint points[195];
  U n = 0;
  if (layer == 0) {
    stampFieldLine(points, n, 0.0f, 0.0f);
    stampFieldCubic(points, n, .22f, -.2f, .5f, -.56f, .84f, -.42f);
    stampFieldQuadratic(points, n, 1.02f, -.33f, .99f, -.1f);
    stampFieldLine(points, n, .86f, -.01f);
    stampFieldLine(points, n, .99f, .09f);
    stampFieldQuadratic(points, n, 1.02f, .33f, .84f, .42f);
    stampFieldCubic(points, n, .5f, .56f, .22f, .2f, 0.0f, 0.0f);
  } else {
    stampFieldLine(points, n, -.75f, 0.0f);
    stampFieldQuadratic(points, n, -.2f, -.6f, .05f, -.35f);
    stampFieldQuadratic(points, n, -.1f, 0.0f, .05f, .35f);
    stampFieldQuadratic(points, n, -.2f, .6f, -.75f, 0.0f);
  }
  StampFieldSegment segments[194];
  U count = n - 1;
  for (U i = 0; i < count; i++) {
    D dx = points[i + 1].x - points[i].x, dy = points[i + 1].y - points[i].y;
    segments[i] = {points[i].x, points[i].y, dx, dy, 1.0f / (dx * dx + dy * dy)};
  }
  const D originX = layer == 0 ? -.3f : -1.15f, originY = -.8f, step = 1.6f / (D)STAMP_FIELD_SIDE;
  const auto zero = wasm_f32x4_splat(0.0f), one = wasm_f32x4_splat(1.0f);
  for (U y = 0; y < STAMP_FIELD_SIDE; y++) {
    const D py = originY + ((D)y + .5f) * step;
    D crossings[194];
    U crossingCount = 0;
    for (U i = 0; i < count; i++)
      if ((points[i].y > py) != (points[i + 1].y > py)) {
        auto& s = segments[i];
        D x = s.x + (py - s.y) * s.dx / s.dy;
        U at = crossingCount++;
        while (at && crossings[at - 1] > x) {
          crossings[at] = crossings[at - 1];
          at--;
        }
        crossings[at] = x;
      }
    U crossing = 0;
    bool inside = false;
    const auto vy = wasm_f32x4_splat(py);
    for (U x = 0; x < STAMP_FIELD_SIDE; x += 4) {
      auto vx = wasm_f32x4_make(originX + ((D)x + .5f) * step, originX + ((D)x + 1.5f) * step,
                                originX + ((D)x + 2.5f) * step, originX + ((D)x + 3.5f) * step);
      auto best = wasm_f32x4_splat(__builtin_inff());
      for (U i = 0; i < count; i++) {
        auto& s = segments[i];
        auto dx = wasm_f32x4_splat(s.dx), dy = wasm_f32x4_splat(s.dy);
        auto rx = wasm_f32x4_sub(vx, wasm_f32x4_splat(s.x)), ry = wasm_f32x4_sub(vy, wasm_f32x4_splat(s.y));
        auto dot = wasm_f32x4_add(wasm_f32x4_mul(rx, dx), wasm_f32x4_mul(ry, dy));
        auto t =
            wasm_f32x4_max(zero, wasm_f32x4_min(one, wasm_f32x4_mul(dot, wasm_f32x4_splat(s.inverseLengthSquared))));
        rx = wasm_f32x4_sub(rx, wasm_f32x4_mul(t, dx));
        ry = wasm_f32x4_sub(ry, wasm_f32x4_mul(t, dy));
        best = wasm_f32x4_min(best, wasm_f32x4_add(wasm_f32x4_mul(rx, rx), wasm_f32x4_mul(ry, ry)));
      }
      D distances[4], xs[4];
      wasm_v128_store(distances, wasm_f32x4_sqrt(best));
      wasm_v128_store(xs, vx);
      for (U j = 0; j < 4; j++) {
        while (crossing < crossingCount && crossings[crossing] <= xs[j]) {
          inside = !inside;
          crossing++;
        }
        stampFieldDistances[y * STAMP_FIELD_SIDE + x + j] = inside ? -distances[j] : distances[j];
      }
    }
  }
  for (U y = 0; y < STAMP_FIELD_SIDE; y++)
    for (U x = 0; x < STAMP_FIELD_SIDE; x++) {
      U left = x ? x - 1 : x, right = x + 1 < STAMP_FIELD_SIDE ? x + 1 : x, up = y ? y - 1 : y,
        down = y + 1 < STAMP_FIELD_SIDE ? y + 1 : y;
      D gx = (stampFieldDistances[y * STAMP_FIELD_SIDE + right] - stampFieldDistances[y * STAMP_FIELD_SIDE + left]) /
             (D)(right - left);
      D gy = (stampFieldDistances[down * STAMP_FIELD_SIDE + x] - stampFieldDistances[up * STAMP_FIELD_SIDE + x]) /
             (D)(down - up);
      D length = __builtin_sqrtf(gx * gx + gy * gy);
      if (length > 1e-12f) {
        gx /= length;
        gy /= length;
      } else {
        gx = 1.0f;
        gy = 0.0f;
      }
      U at = (layer * STAMP_FIELD_TEXELS + y * STAMP_FIELD_SIDE + x) * 4;
      stampFieldPixels[at] = stampFieldHalf(stampFieldDistances[y * STAMP_FIELD_SIDE + x]);
      stampFieldPixels[at + 1] = stampFieldHalf(gx);
      stampFieldPixels[at + 2] = stampFieldHalf(gy);
      stampFieldPixels[at + 3] = 0;
    }
}
extern "C" {
U stamp_field_build() {
  if (!stampFieldBuildCount) {
    stampFieldLayer(0);
    stampFieldLayer(1);
    stampFieldBuildCount = 1;
  }
  return 1;
}
U stamp_field_ptr() {
  return (U)stampFieldPixels;
}
U stamp_field_bytes() {
  return sizeof stampFieldPixels;
}
U stamp_field_builds() {
  return stampFieldBuildCount;
}
}
