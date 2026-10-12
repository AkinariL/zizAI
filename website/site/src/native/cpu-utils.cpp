#include "cpu-math.hpp"
#include "animation-core.hpp"
using U = unsigned int;
static float grids[32 * 32 + 128 * 128 + 512 * 512], small[4096], grainValues[13 * 13 + 55 * 55 + 220 * 220 * 2],
    fibres[8192 * 16], scratch[4096 * 20], rects[4096 * 4];
alignas(16) static unsigned char paper[512 * 512 * 4];
static U histogram[256], info[16], placements[4096 * 2], grainRows;
static U assetControl[2], glyphControl[2], paperMade, paperQuantile, grainMade, grainCount, numericRole;
static void fill(float* p, U n, U seed) {
  fm::RNG r = {seed};
  for (U i = 0; i < n; i++)
    p[i] = r();
}
static float noise(const float* g, U period, float x, float y) {
  int xi = int(fm::floor(x)), yi = int(fm::floor(y));
  float xf = x - float(xi), yf = y - float(yi), u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  U x0 = U((xi % int(period) + int(period)) % int(period)), y0 = U((yi % int(period) + int(period)) % int(period)),
    x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  return (g[x0 + y0 * period] * (1 - u) + g[x1 + y0 * period] * u) * (1 - v) +
         (g[x0 + y1 * period] * (1 - u) + g[x1 + y1 * period] * u) * v;
}
static unsigned char byte(float x) {
  x = fm::clamp(x, 0, 255);
  U n = U(fm::floor(x));
  float f = x - float(n);
  return static_cast<unsigned char>(n + (f > .5f || (f == .5f && (n & 1))));
}
static void rasterFibre(const float* xs, const float* ys, float width, bool light, float alpha) {
  float x0 = xs[0], y0 = ys[0], x1 = x0, y1 = y0;
  for (U i = 1; i < 7; i++) {
    x0 = fm::min(x0, xs[i]);
    x1 = fm::max(x1, xs[i]);
    y0 = fm::min(y0, ys[i]);
    y1 = fm::max(y1, ys[i]);
  }
  float r = width * .5f;
  int left = int(fm::max(0, fm::floor(x0 - r - 1))), right = int(fm::min(512, fm::ceil(x1 + r + 1))),
      top = int(fm::max(0, fm::floor(y0 - r - 1))), bottom = int(fm::min(512, fm::ceil(y1 + r + 1)));
  for (int y = top; y < bottom; y++)
    for (int x = left; x < right; x += 4) {
      auto px = wasm_f32x4_make(float(x) + .5f, float(x) + 1.5f, float(x) + 2.5f, float(x) + 3.5f),
           py = wasm_f32x4_splat(float(y) + .5f), best = wasm_f32x4_splat(1e20f);
      for (U i = 0; i < 6; i++) {
        float dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i], n = dx * dx + dy * dy;
        if (!n)
          continue;
        auto qx = wasm_f32x4_sub(px, wasm_f32x4_splat(xs[i])), qy = wasm_f32x4_sub(py, wasm_f32x4_splat(ys[i]));
        auto t = wasm_f32x4_div(
            wasm_f32x4_add(wasm_f32x4_mul(qx, wasm_f32x4_splat(dx)), wasm_f32x4_mul(qy, wasm_f32x4_splat(dy))),
            wasm_f32x4_splat(n));
        t = wasm_f32x4_min(wasm_f32x4_splat(1), wasm_f32x4_max(wasm_f32x4_splat(0), t));
        qx = wasm_f32x4_sub(qx, wasm_f32x4_mul(t, wasm_f32x4_splat(dx)));
        qy = wasm_f32x4_sub(qy, wasm_f32x4_mul(t, wasm_f32x4_splat(dy)));
        best = wasm_f32x4_min(best, wasm_f32x4_add(wasm_f32x4_mul(qx, qx), wasm_f32x4_mul(qy, qy)));
      }
      auto coverage = wasm_f32x4_min(
          wasm_f32x4_splat(1),
          wasm_f32x4_max(wasm_f32x4_splat(0), wasm_f32x4_sub(wasm_f32x4_splat(r + .5f), wasm_f32x4_sqrt(best))));
      float a[4];
      wasm_v128_store(a, wasm_f32x4_mul(coverage, wasm_f32x4_splat(alpha)));
      for (U k = 0; k < 4 && x + int(k) < right; k++) {
        U at = (U(y) * 512 + U(x) + k) * 4;
        paper[at] = byte(float(paper[at]) * (1 - a[k]) + (light ? 255 : 0) * a[k]);
        paper[at + 1] = paper[at + 2] = paper[at];
      }
    }
}
extern "C" {
U cu_info() {
  return (U)info;
}
U cu_asset_control() {
  return (U)assetControl;
}
U cu_glyph_control() {
  return (U)glyphControl;
}
U cu_role(U role) {
  if (numericRole && numericRole != role)
    return 0;
  numericRole = role;
  return 1;
}
U cu_scratch() {
  return (U)scratch;
}
U cu_rects() {
  return (U)rects;
}
U cu_placements() {
  return (U)placements;
}
U cu_paper() {
  if (numericRole == 2)
    return 0;
  if (paperMade) {
    info[0] = (U)paper;
    info[1] = (U)histogram;
    info[2] = paperQuantile;
    return 1;
  }
  U periods[3] = {32, 128, 512}, offsets[3] = {0, 1024, 17408};
  for (U i = 0; i < 3; i++)
    fill(grids + offsets[i], periods[i] * periods[i], 5 + i);
  fm::RNG r = {8};
  for (U y = 0; y < 512; y++)
    for (U x = 0; x < 512; x += 4) {
      float samples[4][4];
      for (U k = 0; k < 4; k++) {
        float u = float(x + k) / 512, v = float(y) / 512;
        for (U i = 0; i < 3; i++)
          samples[i][k] = noise(grids + offsets[i], periods[i], u * float(periods[i]), v * float(periods[i]));
        samples[3][k] = r();
      }
      auto half = wasm_f32x4_splat(.5f), val = half;
      const float amps[4] = {.26f, .2f, .16f, .13f};
      for (U i = 0; i < 4; i++)
        val = wasm_f32x4_add(
            val, wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(samples[i]), half), wasm_f32x4_splat(amps[i])));
      float values[4];
      wasm_v128_store(values, wasm_f32x4_mul(val, wasm_f32x4_splat(255)));
      for (U k = 0; k < 4; k++) {
        U at = (x + k + y * 512) * 4;
        paper[at] = paper[at + 1] = paper[at + 2] = byte(values[k]);
        paper[at + 3] = 255;
      }
    }
  for (U k = 0; k < 512 * 512 / 380; k++) {
    float x = r() * 512, y = r() * 512, len = r.range(5, 30), a0 = r() * fm::tau, curve = r.range(-.12f, .12f);
    bool light = r() < .55f;
    float alpha = fm::floor(r.range(light ? .1f : .04f, light ? .3f : .12f) * 1000 + .5f) * .001f,
          width = r.range(.4f, 1.1f);
    for (int ox = -512; ox <= 512; ox += 512)
      for (int oy = -512; oy <= 512; oy += 512) {
        float px = x + float(ox), py = y + float(oy), angle = a0;
        if (px < -40 || px > 552 || py < -40 || py > 552)
          continue;
        float xs[7] = {px}, ys[7] = {py};
        for (U s = 0; s < 6; s++) {
          angle += curve;
          xs[s + 1] = xs[s] + fm::cos(angle) * len / 6;
          ys[s + 1] = ys[s] + fm::sin(angle) * len / 6;
        }
        rasterFibre(xs, ys, width, light, alpha);
      }
  }
  const U pp[4] = {4, 8, 16, 32}, off[4] = {0, 16, 80, 336};
  for (U i = 0; i < 4; i++) {
    fill(grids + off[i], pp[i] * pp[i], 70 + i);
    fill(grids + 1360 + off[i], pp[i] * pp[i], 90 + i);
  }
  for (U y = 0; y < 512; y++)
    for (U x = 0; x < 512; x++) {
      float u = float(x) / 512, v = float(y) / 512, a = 0, b = 0, amp = .5f, total = 0;
      for (U i = 0; i < 4; i++) {
        a += noise(grids + off[i], pp[i], u * float(pp[i]), v * float(pp[i])) * amp;
        b += noise(grids + 1360 + off[i], pp[i], u * float(pp[i]), v * float(pp[i])) * amp;
        total += amp;
        amp *= .5f;
      }
      U at = (x + y * 512) * 4;
      paper[at + 1] = byte(fm::clamp((a / total - .5f) * 1.6f + .5f, 0, 1) * 255);
      paper[at + 2] = byte(fm::clamp((b / total - .5f) * 1.6f + .5f, 0, 1) * 255);
    }
  for (U i = 0; i < 256; i++)
    histogram[i] = 0;
  for (U i = 0; i < 512 * 512; i++)
    histogram[paper[i * 4]]++;
  U value = 0, acc = 0;
  for (; value < 255 && (acc += histogram[value]) < 196608; value++)
    ;
  paperMade = 1;
  paperQuantile = value;
  info[0] = (U)paper;
  info[1] = (U)histogram;
  info[2] = value;
  return 1;
}
U cu_grain() {
  if (numericRole == 2)
    return 0;
  if (grainMade) {
    info[0] = (U)grainValues;
    info[1] = grainCount;
    info[2] = (U)fibres;
    info[3] = grainRows * 16;
    return 1;
  }
  U at = 0;
  const U pp[3] = {13, 55, 220};
  for (U i = 0; i < 3; i++) {
    fill(grainValues + at, pp[i] * pp[i], 9 + i);
    at += pp[i] * pp[i];
  }
  fm::RNG r = {12};
  for (U i = 0; i < 220 * 220; i++)
    grainValues[at++] = r();
  grainRows = 0;
  for (U k = 0; k < 220 * 220 / 380; k++) {
    float x = r() * 220, y = r() * 220, len = r.range(5, 30), a0 = r() * fm::tau, curve = r.range(-.12f, .12f);
    bool light = r() < .55f;
    float alpha = fm::floor(r.range(light ? .1f : .04f, light ? .3f : .12f) * 1000 + .5f) * .001f,
          width = r.range(.4f, 1.1f);
    for (int ox = -220; ox <= 220; ox += 220)
      for (int oy = -220; oy <= 220; oy += 220) {
        float px = x + float(ox), py = y + float(oy), angle = a0;
        if (px < -40 || px > 260 || py < -40 || py > 260)
          continue;
        for (U s = 0; s < 6; s++) {
          angle += curve;
          float nx = px + fm::cos(angle) * len / 6, ny = py + fm::sin(angle) * len / 6, pad = width * .5f + .5f;
          if (grainRows >= 8192)
            return 0;
          float* p = fibres + grainRows++ * 16;
          p[0] = fm::min(px, nx) - pad;
          p[1] = fm::min(py, ny) - pad;
          p[2] = fm::abs(nx - px) + pad * 2;
          p[3] = fm::abs(ny - py) + pad * 2;
          p[4] = px;
          p[5] = py;
          p[6] = nx;
          p[7] = ny;
          p[8] = p[9] = p[10] = light ? 1 : 0;
          p[11] = alpha;
          p[12] = 2;
          p[13] = width;
          p[14] = p[15] = 0;
          px = nx;
          py = ny;
        }
      }
  }
  grainMade = 1;
  grainCount = at;
  info[0] = (U)grainValues;
  info[1] = at;
  info[2] = (U)fibres;
  info[3] = grainRows * 16;
  return 1;
}
U cu_glyph_input() {
  return (U)scratch;
}
U cu_run_input() {
  return (U)fibres;
}
static void clearFloats(float* p, U n) {
  auto zero = wasm_f32x4_splat(0);
  U i = 0;
  for (; i + 4 <= n; i += 4)
    wasm_v128_store(p + i, zero);
  for (; i < n; i++)
    p[i] = 0;
}
static void uniform8(float* p, float a, float b, float c, float d, float e = 0, float f = 0, float g = 0, float h = 0) {
  wasm_v128_store(p, wasm_f32x4_make(a, b, c, d));
  wasm_v128_store(p + 4, wasm_f32x4_make(e, f, g, h));
}
U cu_text_prewarm(U runCount, U glyphCount, U alignment, float atlasW, float atlasH) {
  if (numericRole != 2 || glyphCount > 10240 || runCount > 8192 || alignment < 256 || alignment % 16 || atlasW <= 0 ||
      atlasH <= 0)
    return 0;
  U vertexFloats = (glyphCount ? glyphCount : 1) * 8, slots = runCount ? runCount * 12 : 1;
  if (slots > sizeof(paper) / alignment || vertexFloats > sizeof(grids) / 4)
    return 0;
  float* uniforms = (float*)paper;
  U stride = alignment / 4, uniformFloats = slots * stride;
  clearFloats(grids, vertexFloats);
  clearFloats(uniforms, uniformFloats);
  float maxW = 1, maxH = 1;
  for (U i = 0; i < runCount; i++) {
    maxW = fm::max(maxW, fibres[i * 16]);
    maxH = fm::max(maxH, fibres[i * 16 + 1]);
  }
  U gi = 0, ui = 0;
  for (U i = 0; i < runCount; i++) {
    const float* run = fibres + i * 16;
    U count = U(run[11]);
    if (count > glyphCount - gi)
      return 0;
    for (U j = 0; j < count; j++, gi++) {
      const float* g = scratch + gi * 8;
      float* out = grids + gi * 8;
      float x = run[2] + (g[0] + g[2]) * run[3], y = run[2] + (run[4] + g[1] + g[3]) * run[3];
      wasm_v128_store(out, wasm_f32x4_make(x, y, g[4], g[5]));
      wasm_v128_store(out + 4, wasm_f32x4_div(wasm_f32x4_make(g[6], g[7], g[4], g[5]),
                                              wasm_f32x4_make(atlasW, atlasH, atlasW, atlasH)));
    }
    uniform8(uniforms + ui++ * stride, run[0], run[1], 0, 0);
    const float op[9] = {0, 1, 2, 3, 4, 2, 3, 2, 3},
                amount[9] = {run[5], run[5], run[6], run[6], 0, 6 * run[3], 6 * run[3], run[7], run[7]};
    for (U j = 0; j < 9; j++)
      uniform8(uniforms + ui++ * stride, maxW, maxH, run[0], run[1], op[j], amount[j]);
    uniform8(uniforms + ui++ * stride, run[8], run[9], run[0], run[1]);
  }
  if (gi != glyphCount)
    return 0;
  info[0] = (U)grids;
  info[1] = vertexFloats;
  info[2] = (U)paper;
  info[3] = uniformFloats;
  info[4] = U(maxW);
  info[5] = U(maxH);
  return 1;
}
U cu_ui_prewarm(U count, U alignment, float atlasW, float atlasH) {
  if (numericRole != 2 || count > 10240 || alignment < 256 || alignment % 16 || atlasW <= 0 || atlasH <= 0)
    return 0;
  U vertexFloats = count * 16, slots = count * 2;
  if (slots > sizeof(paper) / alignment || vertexFloats > sizeof(grids) / 4)
    return 0;
  float* parameters = (float*)paper;
  U stride = alignment / 4;
  clearFloats(grids, vertexFloats);
  clearFloats(parameters, slots * stride);
  float maxW = 1, maxH = 1;
  for (U i = 0; i < count; i++) {
    maxW = fm::max(maxW, scratch[i * 8]);
    maxH = fm::max(maxH, scratch[i * 8 + 1]);
  }
  for (U i = 0; i < count; i++) {
    const float* g = scratch + i * 8;
    float* out = grids + i * 16;
    float blur = g[2] * g[3];
    uniform8(parameters + i * 2 * stride, maxW, maxH, maxW, maxH);
    uniform8(parameters + (i * 2 + 1) * stride, atlasW, atlasH, maxW, maxH, 1, g[4], g[5]);
    uniform8(out, 0, 0, g[0], g[1], blur);
    uniform8(out + 8, g[4], g[5], g[0], g[1], blur);
  }
  info[0] = (U)grids;
  info[1] = vertexFloats;
  info[2] = (U)paper;
  info[3] = slots * stride;
  info[4] = U(maxW);
  info[5] = U(maxH);
  return 1;
}
U cu_pack(U count, U gutter, U limit, U trim) {
  if (count > 4096 || !limit)
    return 0;
  float area = 0;
  U widest = trim ? 1 : 4;
  for (U i = 0; i < count; i++) {
    U w = U(rects[i * 4]), h = U(rects[i * 4 + 1]);
    if (w + gutter * 2 > widest)
      widest = w + gutter * 2;
    area += float(w + gutter * 2) * float(h + gutter * 2);
  }
  if (widest > limit)
    return 0;
  float target = fm::max(float(widest), fm::sqrt(area));
  U width = 64;
  while (float(width) < target)
    width *= 2;
  if (width > limit)
    width = limit;
  for (;;) {
    U x = gutter, y = gutter, row = 0, used = 1;
    for (U i = 0; i < count; i++) {
      U w = U(rects[i * 4]), h = U(rects[i * 4 + 1]);
      if (x + w + gutter > width) {
        x = gutter;
        y += row + gutter * 2;
        row = 0;
      }
      placements[i * 2] = x;
      placements[i * 2 + 1] = y;
      x += w + gutter * 2;
      row = h > row ? h : row;
      used = x > used ? x : used;
    }
    U height = y + row + gutter;
    if (height <= limit) {
      info[0] = trim ? (width < used ? width : used) : width;
      info[1] = height ? height : 1;
      return 1;
    }
    if (width == limit)
      return 0;
    width = width * 2 > limit ? limit : width * 2;
  }
}
U cu_particle_hash(U count) {
  if (count > 4096)
    return 0;
  auto u = (U*)scratch;
  for (U n = 0; n < count; n += 4) {
    auto hash = wasm_i32x4_make(0x811c9dc5u ^ n, 0x811c9dc5u ^ (n + 1), 0x811c9dc5u ^ (n + 2), 0x811c9dc5u ^ (n + 3));
    for (U k = 0; k < 16; k++) {
      auto value = wasm_i32x4_make(u[n * 20 + k], n + 1 < count ? u[(n + 1) * 20 + k] : 0,
                                   n + 2 < count ? u[(n + 2) * 20 + k] : 0, n + 3 < count ? u[(n + 3) * 20 + k] : 0);
      hash = wasm_i32x4_mul(wasm_v128_xor(hash, value), wasm_i32x4_splat(0x01000193));
    }
    U values[4];
    wasm_v128_store(values, hash);
    for (U k = 0; k < 4 && n + k < count; k++)
      u[(n + k) * 20 + 19] = values[k];
  }
  return 1;
}
}
