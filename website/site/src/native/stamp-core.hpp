static float stampInput[40];
extern "C" {
U mc_stamp_input() {
  return (U)stampInput;
}
U mc_stamp(U h, U kind) {
  if (!h || h > MAX_BANKS || !canvases[h - 1].used || error)
    return 0;
  auto& c = canvases[h - 1];
  auto& b = banks[h - 1];
  const float* p = stampInput;
  const float* m = c.s.m;
  for (U i = 0; i < 6; i++)
    if (!finite(m[i])) {
      c.counts[13]++;
      return 0;
    }
  if (m[1] != 0 || m[2] != 0 || m[0] <= 0 || m[3] != m[0]) {
    c.counts[13]++;
    return 0;
  }
  if (kind != 1 && kind != 2 && kind != 4 && kind != 5 && kind != 6 &&
      (kind != 3 || (p[5] != 0 && p[5] != 1 && p[5] != 2))) {
    c.counts[14]++;
    return 0;
  }
  if (kind == 4 && (!finite(p[2]) || p[2] < 1 || p[2] > 11 || fm::floor(p[2]) != p[2])) {
    c.counts[14]++;
    return 0;
  }
  U inputs = kind == 1   ? 22
             : kind == 2 ? ((p[6] == 2 || p[6] == 3) ? 19 : 16)
             : kind == 3 ? (p[5] == 2 ? 19 : 15)
             : kind == 5 ? (p[7] == 2 ? 16 : 12)
             : kind == 6 ? 21
                         : 6 + U(p[2]) * 2;
  for (U i = 0; i < inputs; i++)
    if (!finite(p[i])) {
      c.counts[14]++;
      return 0;
    }
  if (!finite(p[39]) || p[39] < 0 || p[39] > 1) {
    c.counts[14]++;
    return 0;
  }
  float s[32] = {};
  s[0] = float(kind);
  s[2] = p[39];
  s[4] = m[0] * p[0] + m[4];
  s[5] = m[0] * p[1] + m[5];
  float hx = 0, hy = 0, weight = 0, leafWork = 0;
  if (kind == 3) {
    if (p[2] <= 0 || p[3] <= 0) {
      c.counts[14]++;
      return 0;
    }
    for (U i = 7; i < 15; i++)
      if (p[i] < 0 || p[i] > 1) {
        c.counts[14]++;
        return 0;
      }
    if (p[39] == 0 || p[10] == 0)
      return 1;
    float rx = m[0] * p[2], ry = m[0] * p[3], ca = fm::cos(p[4]), sa = fm::sin(p[4]);
    hx = fm::hypot(rx * ca, ry * sa);
    hy = fm::hypot(rx * sa, ry * ca);
    s[8] = ca / rx;
    s[9] = sa / rx;
    s[10] = -sa / ry;
    s[11] = ca / ry;
    s[12] = s[4];
    s[13] = s[5];
    s[14] = p[5];
    s[15] = p[6];
    memcpy(s + 16, p + 7, 16);
    memcpy(s + 20, p + 11, 16);
    weight = .5f;
    if (p[5] == 2) {
      if (p[18] <= 0) {
        c.counts[14]++;
        return 0;
      }
      float r = m[0] * p[18], bc = fm::cos(p[17]), bs = fm::sin(p[17]);
      wasm_v128_store(s + 24, wasm_f32x4_div(wasm_f32x4_make(bc, bs, -bs, bc), wasm_f32x4_splat(r)));
      s[28] = m[0] * p[15] + m[4];
      s[29] = m[0] * p[16] + m[5];
    }
  } else if (kind == 2) {
    if (p[3] <= 0 || p[4] <= 0 || (p[5] != 0 && p[5] != 1) || (p[6] != 0 && p[6] != 2 && p[6] != 3) ||
        (p[5] == 1 && (p[6] != 0 || p[9] != 0)) || p[9] < 0) {
      c.counts[14]++;
      return 0;
    }
    for (U i = 12; i < 16; i++)
      if (p[i] < 0 || p[i] > 1) {
        c.counts[14]++;
        return 0;
      }
    if (p[6] != 0) {
      if (p[8] <= 0) {
        c.counts[14]++;
        return 0;
      }
      for (U i = 16; i < 19; i++)
        if (p[i] < 0 || p[i] > 1) {
          c.counts[14]++;
          return 0;
        }
      s[16] = m[0] * p[8];
      wasm_v128_store(s + 24, wasm_f32x4_make(p[16], p[17], p[18], 0));
    }
    if (p[9] > 0) {
      if (p[10] < 0 || p[10] > 1 || p[11] != 4) {
        c.counts[14]++;
        return 0;
      }
      s[17] = m[0] * p[9] * .5f;
      s[18] = p[10];
      s[19] = p[11];
    }
    if (p[39] == 0 ||
        ((p[6] == 0 ? p[15] == 0 : (p[16] == 0 && p[17] == 0 && p[18] == 0)) && (p[9] == 0 || p[10] == 0)))
      return 1;
    float r = m[0] * p[4], sy = p[3], ca = fm::cos(p[2]), sa = fm::sin(p[2]);
    s[3] = p[5];
    wasm_v128_store(s + 8, wasm_f32x4_div(wasm_f32x4_make(ca, sa, -sa, ca), wasm_f32x4_make(r, r, r * sy, r * sy)));
    s[12] = s[4];
    s[13] = s[5];
    s[14] = p[6];
    s[15] = p[7];
    memcpy(s + 20, p + 12, 16);
    float ex = p[5] == 0 ? 1.02f : .75f, ey = p[5] == 0 ? .56f : .6f;
    hx = r * (fm::abs(ca) * ex + fm::abs(sa) * ey * sy) + s[17];
    hy = r * (fm::abs(sa) * ex + fm::abs(ca) * ey * sy) + s[17];
    weight = 1;
  } else if (kind == 5) {
    if (p[3] <= 0 || p[4] <= 0 || fm::abs(p[6]) >= 1 || (p[7] != 0 && p[7] != 1 && p[7] != 2)) {
      c.counts[14]++;
      return 0;
    }
    if (p[7] == 2 && (p[12] < 0 || p[12] >= 1 || !(p[13] > 0) || p[14] < 0 || p[14] > 1 || p[15] < 0 || p[15] > 1)) {
      c.counts[14]++;
      return 0;
    }
    for (U i = 8; i < 12; i++)
      if (p[i] < 0 || p[i] > 1) {
        c.counts[14]++;
        return 0;
      }
    if (p[39] == 0 || p[11] == 0)
      return 1;
    float rootX = s[4], rootY = s[5], ca = fm::cos(p[2]), sa = fm::sin(p[2]), len = m[0] * p[3], wid = m[0] * p[4];
    s[3] = p[7];
    wasm_v128_store(s + 8, wasm_f32x4_make(rootX, rootY, ca, sa));
    wasm_v128_store(s + 12, wasm_f32x4_make(len, wid, p[5], p[6]));
    memcpy(s + 16, p + 8, 16);
    if (p[7] == 2) {
      wasm_v128_store(s + 20, wasm_f32x4_make(m[4], m[5], p[12], p[13] * m[0]));
      wasm_v128_store(s + 24, wasm_f32x4_make(p[14], p[15], 0, 0));
    }
    float w = wid * (1 + fm::abs(p[6])), bendLen = p[5] * len, ylo = min(0, bendLen) - w, yhi = max(0, bendLen) + w;
    auto x = wasm_f32x4_make(0, len, 0, len), y = wasm_f32x4_make(ylo, ylo, yhi, yhi);
    auto dx = wasm_f32x4_sub(wasm_f32x4_mul(x, wasm_f32x4_splat(ca)), wasm_f32x4_mul(y, wasm_f32x4_splat(sa)));
    auto dy = wasm_f32x4_add(wasm_f32x4_mul(x, wasm_f32x4_splat(sa)), wasm_f32x4_mul(y, wasm_f32x4_splat(ca)));
    float xlo = min(min(wasm_f32x4_extract_lane(dx, 0), wasm_f32x4_extract_lane(dx, 1)),
                    min(wasm_f32x4_extract_lane(dx, 2), wasm_f32x4_extract_lane(dx, 3)));
    float xhi = max(max(wasm_f32x4_extract_lane(dx, 0), wasm_f32x4_extract_lane(dx, 1)),
                    max(wasm_f32x4_extract_lane(dx, 2), wasm_f32x4_extract_lane(dx, 3)));
    float ylow = min(min(wasm_f32x4_extract_lane(dy, 0), wasm_f32x4_extract_lane(dy, 1)),
                     min(wasm_f32x4_extract_lane(dy, 2), wasm_f32x4_extract_lane(dy, 3)));
    float yhigh = max(max(wasm_f32x4_extract_lane(dy, 0), wasm_f32x4_extract_lane(dy, 1)),
                      max(wasm_f32x4_extract_lane(dy, 2), wasm_f32x4_extract_lane(dy, 3)));
    s[4] = rootX + (xlo + xhi) * .5f;
    s[5] = rootY + (ylow + yhigh) * .5f;
    hx = (xhi - xlo) * .5f;
    hy = (yhigh - ylow) * .5f;
    leafWork = 6 + (len + 3) * (yhi - ylo + 3) * .05f * (p[7] == 0 ? 2 : 1);
  } else if (kind == 6) {
    if (!(p[6] > 0) || !(p[7] > 0) || p[12] < 0 || p[12] >= 1 || !(p[13] > 0) || (p[16] != 0 && p[16] != 1) ||
        p[17] < 0 || p[17] > 3 || fm::floor(p[17]) != p[17] || p[18] < 0 || p[18] > 1 || p[19] < 0 || p[19] > 1 ||
        (p[20] != 1 && p[20] != -1)) {
      c.counts[14]++;
      return 0;
    }
    for (U i = 8; i < 12; i++)
      if (p[i] < 0 || p[i] > 1) {
        c.counts[14]++;
        return 0;
      }
    if (p[39] == 0 || p[11] == 0)
      return 1;
    float x0 = s[4], y0 = s[5], x1 = m[0] * p[2] + m[4], y1 = m[0] * p[3] + m[5], x2 = m[0] * p[4] + m[4],
          y2 = m[0] * p[5] + m[5], w0 = m[0] * p[6], w1 = m[0] * p[7], pu = m[0] * p[13];
    s[3] = p[16];
    wasm_v128_store(s + 8, wasm_f32x4_make(x0, y0, x1, y1));
    wasm_v128_store(s + 12, wasm_f32x4_make(x2, y2, w0, w1));
    memcpy(s + 16, p + 8, 16);
    wasm_v128_store(s + 20, wasm_f32x4_make(m[4], m[5], p[12], pu));
    wasm_v128_store(s + 24, wasm_f32x4_make(p[14], p[15], 0, p[17]));
    wasm_v128_store(s + 28, wasm_f32x4_make(p[18], p[19], p[20], 0));
    float xlo = min(x0, min(x1, x2)), xhi = max(x0, max(x1, x2)), ylo = min(y0, min(y1, y2)),
          yhi = max(y0, max(y1, y2)), pad = 1.7f * max(w0, w1) + 2.5f * pu + 1;
    s[4] = (xlo + xhi) * .5f;
    s[5] = (ylo + yhi) * .5f;
    hx = (xhi - xlo) * .5f + pad;
    hy = (yhi - ylo) * .5f + pad;
    weight = 1.5f;
  } else if (kind == 4) {
    if (p[3] <= 0 || p[4] < 0 || p[4] > 1 || p[5] != 5) {
      c.counts[14]++;
      return 0;
    }
    if (p[39] == 0 || p[4] == 0)
      return 1;
    U n = U(p[2]);
    s[2] *= p[4];
    s[3] = p[5];
    s[8] = float(n);
    s[9] = m[0] * p[3] * .5f;
    U k = 0;
    for (; k + 1 < n; k += 2) {
      auto d = wasm_f32x4_mul(wasm_f32x4_sub(wasm_v128_load(p + 6 + k * 2), wasm_f32x4_make(p[0], p[1], p[0], p[1])),
                              wasm_f32x4_splat(m[0]));
      wasm_v128_store(s + 10 + k * 2, d);
      auto q = wasm_f32x4_abs(d);
      hx = max(hx, max(wasm_f32x4_extract_lane(q, 0), wasm_f32x4_extract_lane(q, 2)));
      hy = max(hy, max(wasm_f32x4_extract_lane(q, 1), wasm_f32x4_extract_lane(q, 3)));
    }
    if (k < n) {
      s[10 + k * 2] = m[0] * (p[6 + k * 2] - p[0]);
      s[11 + k * 2] = m[0] * (p[7 + k * 2] - p[1]);
      hx = max(hx, fm::abs(s[10 + k * 2]));
      hy = max(hy, fm::abs(s[11 + k * 2]));
    }
    hx += s[9];
    hy += s[9];
    weight = float(n) * .5f;
  } else {
    if (p[2] <= 0) {
      c.counts[14]++;
      return 0;
    }
    for (U i = 20; i < 22; i++)
      if (p[i] < 0 || p[i] > 1025000.0f || fm::floor(p[i]) != p[i] || (U(p[i]) & 1023u) > 1000u ||
          (U(p[i]) >> 10) > 1000u) {
        c.counts[14]++;
        return 0;
      }
    float radius = m[0] * p[2];
    s[3] = p[20];
    s[8] = radius;
    s[9] = p[4];
    s[10] = m[0] * max(.45f, .17f * p[2]);
    s[11] = p[21];
    for (U k = 0; k < 5; k++) {
      U j = 5 + k * 3;
      if (p[j + 1] <= 0 || p[j + 2] <= 0) {
        c.counts[14]++;
        return 0;
      }
      float a = p[3] + float(k) * (fm::tau / 5.0f) + p[j], ca = fm::cos(a), sa = fm::sin(a);
      float r = radius * p[j + 2], sy = p[j + 1];
      wasm_v128_store(s + 12 + k * 4,
                      wasm_f32x4_div(wasm_f32x4_make(ca, sa, -sa, ca), wasm_f32x4_make(r, r, r * sy, r * sy)));
      hx = max(hx, r * (fm::abs(ca) * 1.02f + fm::abs(sa) * .56f * sy));
      hy = max(hy, r * (fm::abs(sa) * 1.02f + fm::abs(ca) * .56f * sy));
    }
    hx = max(hx, s[10]);
    hy = max(hy, s[10]);
    weight = 5;
    if (p[39] == 0 || (p[20] == 0 && p[21] == 0))
      return 1;
  }
  s[6] = hx + 1.5f;
  s[7] = hy + 1.5f;
  float bounds[4] = {s[4] - s[6], s[5] - s[7], s[4] + s[6], s[5] + s[7]};
  float work = kind == 5 ? leafWork : 6.0f + (4.0f * s[6] * s[7]) * .05f * weight;
  for (U i = 0; i < 32; i++)
    if (!finite(s[i])) {
      c.counts[14]++;
      return 0;
    }
  if (!finite(work) || !valid(bounds)) {
    c.counts[14]++;
    return 0;
  }
  if (outside(c, bounds)) {
    c.counts[3]++;
    return 1;
  }
  U first = b.stamps.n;
  Raw* last = b.cmd.n ? (Raw*)b.cmd.ptr + b.cmd.n - 1 : nullptr;
  bool merge = last && b.cmd.n - 1 >= b.stampMergeFloor && last->kind == 5 && last->first + last->count == first &&
               last->v[4] + work <= 4000.0f;
  if (!reserve(b.stamps, first + 1) || (!merge && !reserve(b.cmd, b.cmd.n + 1)))
    return 0;
  memcpy((float*)b.stamps.ptr + first * 32, s, 128);
  b.stamps.n++;
  if (merge) {
    last = (Raw*)b.cmd.ptr + b.cmd.n - 1;
    last->count++;
    unite(last->v, bounds);
    last->v[4] += work;
  } else {
    auto cmd = (Raw*)b.cmd.ptr + b.cmd.n++;
    memset(cmd, 0, sizeof *cmd);
    cmd->kind = 5;
    cmd->first = first;
    cmd->count = 1;
    memcpy(cmd->v, bounds, 16);
    cmd->v[4] = work;
  }
  return 1;
}
}
