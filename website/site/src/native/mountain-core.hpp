namespace mountain {
static Array pixels;
static U control[2], lease, pw, ph;
static float ridgeValues[2][448], noiseValues[2][4096], ridgeMin[2], ridgeMax[2];
static constexpr U base[2] = {4, 7};
static float sample(U which, float u) {
  float sum = 0, amp = 1, total = 0;
  U off = 0;
  for (U o = 0; o < 6; o++) {
    U n = base[which] << o;
    float x = u * float(n), q = x - fm::floor(x), w = q * q * (3 - 2 * q);
    int i = int(fm::floor(x));
    U a = U((i % int(n) + int(n)) % int(n)), b = (a + 1) % n;
    sum += amp * fm::lerp(ridgeValues[which][off + a], ridgeValues[which][off + b], w);
    total += amp;
    amp *= .52f;
    off += n;
  }
  return sum / total;
}
static float ridge(U which, float u) {
  return fm::pow(fm::clamp((sample(which, u) - ridgeMin[which]) / (ridgeMax[which] - ridgeMin[which]), 0, 1),
                 which ? 1.35f : 1.75f);
}
static float noise(U which, float x, float y) {
  int ix = int(fm::floor(x)), iy = int(fm::floor(y));
  float q = x - float(ix), r = y - float(iy), u = q * q * (3 - 2 * q), v = r * r * (3 - 2 * r);
  U x0 = U(ix) & 63u, y0 = U(iy) & 63u, x1 = (x0 + 1) & 63u, y1 = (y0 + 1) & 63u;
  auto p = noiseValues[which];
  return fm::lerp(fm::lerp(p[x0 + y0 * 64], p[x1 + y0 * 64], u), fm::lerp(p[x0 + y1 * 64], p[x1 + y1 * 64], u), v);
}
static U salt = 0;
static void prepare() {
  for (U a = 0; a < 2; a++) {
    fm::RNG r = {(a ? 57u : 31u) ^ salt};
    U n = base[a] * 63;
    for (U i = 0; i < n; i++)
      ridgeValues[a][i] = r();
    ridgeMin[a] = 1;
    ridgeMax[a] = 0;
    for (U i = 0; i < 2048; i++) {
      float q = sample(a, float(i) / 2048);
      ridgeMin[a] = fm::min(ridgeMin[a], q);
      ridgeMax[a] = fm::max(ridgeMax[a], q);
    }
    fm::RNG noiseR = {(88 + a) ^ salt};
    for (U i = 0; i < 4096; i++)
      noiseValues[a][i] = noiseR();
  }
}
} // namespace mountain
extern "C" {
U mt_build(float W, float H) {
  using namespace mountain;
  if (lease || !(W > 0 && H > 0))
    return 0;
  pw = U(fm::max(96, fm::floor(fm::max(3 * H, 1.7f * W) * .35f + .5f)));
  ph = U(fm::max(16, fm::floor(.59f * H * .35f + .5f)));
  if (pw > 8192 || ph > 4096 || pw * ph > 4194304) {
    error = 31;
    return 0;
  }
  pixels.stride = 4;
  if (!reserve(pixels, pw * ph * 2))
    return 0;
  prepare();
  float* out = (float*)pixels.ptr;
  float PH = float(pw) / .35f / H, du = .5f / float(pw);
  for (U x = 0; x < pw; x++) {
    float u = float(x) / float(pw), ya = .475f - .2f * ridge(0, u), yb = .565f - .105f * ridge(1, u);
    float sa = fm::clamp(-.2f * (ridge(0, u + du) - ridge(0, u - du)) / (2 * du * PH) * 2.2f, -1, 1),
          sb = fm::clamp(-.105f * (ridge(1, u + du) - ridge(1, u - du)) / (2 * du * PH) * 3, -1, 1);
    for (U y = 0; y < ph; y += 4) {
      float aa[4] = {}, bb[4] = {};
      for (U k = 0; k < 4 && y + k < ph; k++) {
        float yy = .17f + (float(y + k) + .5f) / float(ph) * .59f, ta = yy - ya, tb = yy - yb,
              cloud = 1 - .7f * fm::smooth(.52f, .78f, noise(0, u * 128, yy * 9 + 3));
        if (ta > -.008f) {
          float t = fm::max(0, ta),
                tex = .6f + .4f * (.5f * noise(0, u * 192, yy * 34) + .5f * noise(1, u * 896, yy * 5));
          aa[k] = fm::smooth(-.008f, .004f, ta) *
                  (.3f * fm::exp2(-t / .08f * 1.44269504089f) + .28f * fm::exp2(-t / .011f * 1.44269504089f)) * tex *
                  (t > .015f ? cloud : 1);
        }
        if (tb > -.007f) {
          float t = fm::max(0, tb),
                tex = .56f + .44f * (.5f * noise(1, u * 256, yy * 36) + .5f * noise(0, u * 1152, yy * 6));
          bb[k] = fm::smooth(-.007f, .004f, tb) *
                  (.4f * fm::exp2(-t / .06f * 1.44269504089f) + .32f * fm::exp2(-t / .009f * 1.44269504089f)) * tex *
                  (t > .012f ? fm::lerp(1, cloud, .8f) : 1);
        }
      }
      float a[4], b[4];
      wasm_v128_store(a, wasm_f32x4_mul(wasm_v128_load(aa), wasm_f32x4_splat(1 + .35f * sa)));
      wasm_v128_store(b, wasm_f32x4_mul(wasm_v128_load(bb), wasm_f32x4_splat(1 + .4f * sb)));
      for (U k = 0; k < 4 && y + k < ph; k++) {
        U at = (y + k) * pw + x;
        out[at] = a[k];
        out[pw * ph + at] = b[k];
      }
    }
  }
  lease = 1;
  return 1;
}
U mt_info(U key) {
  using namespace mountain;
  return key == 0 ? pixels.ptr : key == 1 ? pw : key == 2 ? ph : key == 3 ? (U)control : key == 4 ? pixels.cap * 4 : 0;
}
void mt_release() {
  using namespace mountain;
  if (!lease)
    return;
  give(pixels.ptr, pixels.cap * pixels.stride);
  pixels = {};
  lease = 0;
}
}
