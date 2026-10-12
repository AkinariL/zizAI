static float brushInput[4096 * 4 + 32], brushNormals[4096 * 2], brushPressure[4096], brushNoise[128 * 128];
static bool brushNoiseReady;
static void noiseFill(float* out, U n, U seed) {
  fm::RNG r = {seed};
  for (U i = 0; i < n; i++)
    out[i] = r();
}
static float periodic(const float* g, U period, float x, float y) {
  int xi = int(fm::floor(x)), yi = int(fm::floor(y));
  float xf = x - float(xi), yf = y - float(yi), u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  U x0 = U((xi % int(period) + int(period)) % int(period)), y0 = U((yi % int(period) + int(period)) % int(period)),
    x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  return (g[x0 + y0 * period] * (1 - u) + g[x1 + y0 * period] * u) * (1 - v) +
         (g[x0 + y1 * period] * (1 - u) + g[x1 + y1 * period] * u) * v;
}
static float roundAlpha(float a) {
  return fm::floor(fm::clamp(a, 0, 1) * 1000 + .5f) * .001f;
}
static void solid(float* dst, const float* color, float alpha) {
  memset(dst, 0, 256);
  dst[1] = 1;
  dst[2] = 1;
  ident(dst + 4);
  dst[16] = 0;
  for (U k = 0; k < 3; k++)
    dst[17 + k] = float(int(color[k])) / 255;
  dst[20] = roundAlpha(alpha);
}
static void ribbonNative(U h, U n, const float* p, const float* normals, float u0, float u1) {
  mc_begin(h);
  for (U i = 0; i < n; i++) {
    XY q = {p[i * 4] + normals[i * 2] * p[i * 4 + 2] * u1, p[i * 4 + 1] + normals[i * 2 + 1] * p[i * 4 + 2] * u1};
    if (i)
      mc_line(h, q.x, q.y);
    else
      mc_move(h, q.x, q.y);
  }
  for (U j = n; j > 0;) {
    U i = --j;
    mc_line(h, p[i * 4] + normals[i * 2] * p[i * 4 + 2] * u0, p[i * 4 + 1] + normals[i * 2 + 1] * p[i * 4 + 2] * u0);
  }
  mc_close(h);
}
extern "C" {
U mc_brush_input() {
  return (U)brushInput;
}
U mc_brush(U h, U n, U seed) {
  if (n < 2 || n > 4096) {
    error = 25;
    return 0;
  }
  auto& c = canvases[h - 1];
  float *p = brushInput + 32, *o = brushInput;
  fm::RNG r = {seed};
  float width = 0, length = 0;
  if (!brushNoiseReady) {
    noiseFill(brushNoise, 128 * 128, 4242);
    brushNoiseReady = true;
  }
  for (U i = 0; i < n; i++) {
    U a = i ? i - 1 : 0, b = min(n - 1, i + 1);
    float dx = p[b * 4] - p[a * 4], dy = p[b * 4 + 1] - p[a * 4 + 1], l = fm::hypot(dx, dy);
    if (!l)
      l = 1;
    brushNormals[i * 2] = -dy / l;
    brushNormals[i * 2 + 1] = dx / l;
    width = max(width, p[i * 4 + 2]);
    if (i)
      length += fm::hypot(p[i * 4] - p[(i - 1) * 4], p[i * 4 + 1] - p[(i - 1) * 4 + 1]);
  }
  float head = o[4], tail = o[5], dry = o[6], body = o[7], alpha = o[3];
  if (body) {
    memset(material, 0, 256);
    material[0] = 1;
    material[1] = o[14];
    material[2] = 9;
    float inv[6];
    if (!inverse(inv, c.s.m))
      return 1;
    memcpy(material + 4, inv, 24);
    material[10] = p[0];
    material[11] = p[1];
    material[12] = p[(n - 1) * 4];
    material[13] = p[(n - 1) * 4 + 1];
    for (U k = 0; k <= 8; k++) {
      float s = float(k) / 8, fade = (head ? fm::smooth(head * .15f, head * .9f, s) : 1) *
                                     (tail ? fm::smooth(1 - tail * .15f, 1 - tail * .9f, s) : 1);
      U at = 16 + k * 5;
      material[at] = s;
      for (U j = 0; j < 3; j++)
        material[at + 1 + j] = float(int(o[j])) / 255;
      material[at + 4] = roundAlpha(alpha * body * fade * (1 - .6f * fm::clamp(dry * o[20 + k], 0, 1)));
    }
    ribbonNative(h, n, p, brushNormals, -.94f, .94f);
    if (!mc_fill(h))
      return 0;
  }
  U bristles = o[8] > 0 ? U(o[8]) : U(fm::clamp(fm::floor(width * 2 / (o[9] > 0 ? o[9] : 1.6f) + .5f), 4, 48));
  float cover = o[10] > 0 ? o[10] : 1.8f, streak = o[11], unit = o[12] > 0 ? o[12] : 40, edge = o[13], ox = r() * 90,
        oy = r() * 90;
  for (U k = 0; k < bristles; k++) {
    float u = (float(k) + .5f) / float(bristles) * 2 - 1 + (r() - .5f) * (1.1f / float(bristles)), au = abs(u),
          a = fm::clamp(alpha * (1 - streak * r()) * (1 + edge * (au * au * au * 1.7f - .45f)), 0, 1);
    float hbRel = cover / float(bristles) * (.7f + .6f * r()), s0 = head * fm::pow(r(), 1.6f) * (.45f + .9f * au),
          s1 = 1 - tail * fm::pow(r(), 1.6f) * (.45f + .9f * au), kb = ox + float(k) * .61f;
    for (U i = 0; i < n; i++) {
      float s = float(i) / float(n - 1), pv = fm::smooth(s0, s0 + .035f, s) * (1 - fm::smooth(s1 - .035f, s1, s));
      if (head == 0 && s < .035f)
        pv = 1;
      if (tail == 0 && s > .965f)
        pv = max(pv, s0 <= s ? 1 : 0);
      float d = dry * p[i * 4 + 3] * (.5f + .7f * au);
      if (d > 0 && pv > 0) {
        float g = periodic(brushNoise, 128, kb, oy + s * length / unit) * .7f +
                  periodic(brushNoise, 128, kb * 2.1f + 40, oy + s * length / (unit * .3f)) * .3f;
        pv *= fm::smooth(d - .06f, d + .06f, g);
      }
      brushPressure[i] = pv;
    }
    mc_begin(h);
    U i = 0;
    while (i < n) {
      while (i < n && brushPressure[i] < .05f)
        i++;
      U first = i;
      while (i < n && brushPressure[i] >= .05f)
        i++;
      if (i <= first + 1)
        continue;
      U last = i - 1;
      for (U j = first; j <= last; j++) {
        float w = p[j * 4 + 2], hb = hbRel * w * brushPressure[j], cx = p[j * 4] + brushNormals[j * 2] * u * w,
              cy = p[j * 4 + 1] + brushNormals[j * 2 + 1] * u * w;
        auto v = wasm_f32x4_add(wasm_f32x4_make(cx, cy, cx, cy),
                                wasm_f32x4_mul(wasm_f32x4_make(brushNormals[j * 2], brushNormals[j * 2 + 1],
                                                               -brushNormals[j * 2], -brushNormals[j * 2 + 1]),
                                               wasm_f32x4_splat(hb)));
        float x = wasm_f32x4_extract_lane(v, 0), y = wasm_f32x4_extract_lane(v, 1);
        if (j == first)
          mc_move(h, x, y);
        else
          mc_line(h, x, y);
      }
      for (U j = last + 1; j > first;) {
        j--;
        float w = p[j * 4 + 2], hb = hbRel * w * brushPressure[j], cx = p[j * 4] + brushNormals[j * 2] * u * w,
              cy = p[j * 4 + 1] + brushNormals[j * 2 + 1] * u * w;
        mc_line(h, cx - brushNormals[j * 2] * hb, cy - brushNormals[j * 2 + 1] * hb);
      }
      mc_close(h);
    }
    solid(material, o, a);
    material[1] = o[14];
    if (!mc_fill(h))
      return 0;
  }
  return !error;
}
}
