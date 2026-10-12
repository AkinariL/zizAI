const GPU_STAMP_SHAPES_WGSL = `
struct Stamp { head: vec4f, box: vec4f, v: array<vec4f, 6> }

const STAMP_SHAPE_ORIGIN = array<vec2f, 2>(vec2f(-0.3, -0.8), vec2f(-1.15, -0.8));
const STAMP_SMALL_COLORS = array<vec3f, 4>(vec3f(221,131,156)/255.0, vec3f(241,186,201)/255.0, vec3f(251,229,234)/255.0, vec3f(176,66,98)/255.0);
const STAMP_LINE_COLORS = array<vec3f, 2>(vec3f(192,104,128)/255.0, vec3f(44,31,34)/255.0);

fn stampShape(m: vec4f, d: vec2f, layer: i32, unit: f32) -> vec2f {
  let u = vec2f(dot(m.xy, d), dot(m.zw, d));
  let uv = (u - STAMP_SHAPE_ORIGIN[layer]) / 1.6;
  let t = textureSampleLevel(stampShapes, stampSampler, uv, layer, 0.0);
  let beyond = max(max(-uv.x, uv.x - 1.0), max(-uv.y, uv.y - 1.0));
  let sd = t.r + max(beyond, 0.0) * 1.6;
  let grow = length(vec2f(m.x * t.g + m.z * t.b, m.y * t.g + m.w * t.b));
  let px = sd / max(grow, 1e-6) / unit;
  return vec2f(clamp(0.5 - px, 0.0, 1.0), px);
}

fn stampSmallAlphas(s: Stamp) -> vec4f {
  let ab = u32(s.head.w); let ch = u32(s.v[0].w);
  return vec4f(f32(ab & 1023u), f32(ab >> 10u), f32(ch & 1023u), f32(ch >> 10u)) / 1000.0;
}

fn stampSmallGradient(t: f32, alpha: vec4f) -> vec4f {
  let a = vec4f(STAMP_SMALL_COLORS[0], alpha.x);
  let b = vec4f(STAMP_SMALL_COLORS[1], alpha.y);
  let c = vec4f(STAMP_SMALL_COLORS[2], alpha.z);
  var color: vec4f;
  if (t < 0.36) { color = mix(a, b, clamp(t / 0.36, 0.0, 1.0)); }
  else { color = mix(b, c, clamp((t - 0.36) / 0.64, 0.0, 1.0)); }
  return vec4f(color.rgb * color.a, color.a);
}

fn stampLeafProfile(s: f32) -> f32 {
  return pow(max(sin(3.14159265 * pow(0.035 + 0.965 * s, 0.62)), 0.0), 1.08);
}

fn stampLeafBand(a: f32, b: f32, unit: f32) -> f32 {
  return max(clamp(0.5 + a / unit, 0.0, 1.0) + clamp(0.5 + b / unit, 0.0, 1.0) - 1.0, 0.0);
}

fn stampLeafCover(q: vec2f, len: f32, wid: f32, bend: f32, asym: f32, unit: f32) -> f32 {
  var s = clamp(q.x / len, 0.0, 1.0);
  for (var k = 0u; k < 2u; k++) {
    let c = vec2f(s * len, bend * len * s * s);
    let t = vec2f(len, 2.0 * bend * len * s);
    s += dot(q - c, t) / dot(t, t);
  }
  let sc = clamp(s, 0.0, 1.0);
  let c = vec2f(sc * len, bend * len * sc * sc);
  let t = vec2f(len, 2.0 * bend * len * sc);
  let tl = length(t);
  let off = dot(q - c, vec2f(-t.y, t.x)) / tl;
  let h = wid * stampLeafProfile(sc);
  return stampLeafBand(h * (1.0 + asym) - off, h * (1.0 - asym) + off, unit)
    * stampLeafBand(s * tl, (1.0 - s) * tl, unit);
}

fn stampLeafQ3(a: f32) -> f32 {
  return floor(a * 1000.0 + 0.5) / 1000.0;
}

fn inkHash(c: vec2i) -> f32 {
  var h = bitcast<u32>(c.x) * 0x9E3779B1u + bitcast<u32>(c.y) * 0x85EBCA77u;
  h ^= h >> 15u; h *= 0x2C1B3C6Du; h ^= h >> 12u; h *= 0x297A2D39u; h ^= h >> 15u;
  return f32(h >> 8u) / 16777216.0;
}

fn inkNoise(p: vec2f) -> f32 {
  let c = floor(p); let f = p - c; let u = f * f * (3.0 - 2.0 * f); let i = vec2i(c);
  return mix(mix(inkHash(i), inkHash(i + vec2i(1, 0)), u.x), mix(inkHash(i + vec2i(0, 1)), inkHash(i + vec2i(1, 1)), u.x), u.y);
}

fn inkPaper(density: f32, wp: vec2f, pu: f32, tooth: f32) -> f32 {
  let th = 0.55 * inkNoise(wp / max(1.5 * pu, 2.0)) + 0.45 * inkNoise(wp / max(6.0 * pu, 4.0) + vec2f(17.0, 43.0));
  return clamp(density * (1.0 - tooth * pow(max(1.0 - density, 0.0), 1.4) * 1.7 * (th - 0.45)), 0.0, 1.0);
}


fn inkStreak(t: f32, s: f32, seed: f32) -> f32 {
  return smoothstep(0.42, 0.62, inkNoise(vec2f((t * 0.5 + 0.5) * 39.0 + seed * 977.0, s * 4.0 + seed * 131.0)));
}

fn stampInkLeaf(s: Stamp, p: vec2f, unit: f32) -> vec4f {
  let d = p - s.v[0].xy; let dir = s.v[0].zw;
  let q = vec2f(dot(d, dir), dot(d, vec2f(-dir.y, dir.x)));
  let len = s.v[1].x; let wid = s.v[1].y; let bend = s.v[1].z; let col = s.v[2];
  let seed = s.v[3].z; let pu = s.v[3].w; let wp = p - s.v[3].xy; let rim = s.v[4].x; let dry = s.v[4].y;
  var a = clamp(q.x / len, 0.0, 1.0);
  for (var k = 0u; k < 2u; k++) {
    let c = vec2f(a * len, bend * len * a * a); let t = vec2f(len, 2.0 * bend * len * a);
    a += dot(q - c, t) / dot(t, t);
  }
  let sc = clamp(a, 0.0, 1.0);
  let c = vec2f(sc * len, bend * len * sc * sc); let tg = vec2f(len, 2.0 * bend * len * sc); let tl = length(tg);
  let off = dot(q - c, vec2f(-tg.y, tg.x)) / tl;
  var profile = pow(max(1.0 - sc, 0.0) / 0.8, 1.25);
  if (sc < 0.2) { profile = pow(sc / 0.2, 0.45); }
  let h = wid * profile * (1.0 + 0.04 * (2.0 * inkNoise(wp / max(2.2 * pu, 2.0)) - 1.0));
  let cover = stampLeafBand(h - off, h + off, unit) * stampLeafBand(a * tl, (1.0 - a) * tl, unit);
  if (cover <= 0.0) { return vec4f(0); }
  let t = clamp(off / max(h, 1e-4), -1.0, 1.0);
  let side = select(-1.0, 1.0, fract(seed * 7.31) < 0.5);
  let tone = col.a * (1.1 - 0.3 * sc) * (1.0 + 0.2 * side * t) + rim * smoothstep(0.6, 0.95, abs(t)) * (1.0 - sc);
  var density = cover * clamp(tone, 0.0, 1.0);
  density *= 1.0 - dry * smoothstep(0.5, 1.0, sc) * inkStreak(t, sc, seed);
  let alpha = inkPaper(density, wp, pu, select(0.5, 1.0, col.a < 0.5)) * s.head.z;
  return vec4f(col.rgb * alpha, alpha);
}

fn stampInkStroke(s: Stamp, p: vec2f, unit: f32) -> vec4f {
  let P0 = s.v[0].xy; let P1 = s.v[0].zw; let P2 = s.v[1].xy;
  let A = P1 - P0; let B = P0 - 2.0 * P1 + P2; let C = P2 - P1; let flags = u32(s.v[4].w);
  let e0 = dot(p - P0, A) / max(length(A), 1e-4); let e2 = dot(P2 - p, C) / max(length(C), 1e-4);
  var ends = 1.0;
  if ((flags & 1u) != 0u) { ends *= clamp(0.5 + e0 / unit, 0.0, 1.0); } else if (e0 < 0.0) { return vec4f(0); }
  if ((flags & 2u) != 0u) { ends *= clamp(0.5 + e2 / unit, 0.0, 1.0); } else if (e2 <= 0.0) { return vec4f(0); }
  let chord = P2 - P0;
  var u = clamp(dot(p - P0, chord) / max(dot(chord, chord), 1e-6), 0.0, 1.0);
  for (var k = 0u; k < 3u; k++) {
    let c = P0 + (2.0 * A + B * u) * u; let t = A + B * u;
    u = clamp(u + 0.5 * dot(p - c, t) / max(dot(t, t), 1e-6), 0.0, 1.0);
  }
  let c = P0 + (2.0 * A + B * u) * u; let tv = A + B * u; let tg = tv / max(length(tv), 1e-4);
  let off = dot(p - c, vec2f(-tg.y, tg.x));
  var w = mix(s.v[1].z, s.v[1].w, u);
  let stalk = u32(s.head.w) == 1u;
  if ((flags & 1u) != 0u && !stalk) { w *= pow(clamp(e0 / (3.0 * w), 0.0, 1.0), 0.6); }
  let seed = s.v[3].z; let pu = s.v[3].w; let wp = p - s.v[3].xy;
  let sa = mix(s.v[4].x, s.v[4].y, u) + seed * 613.0;
  let ink = s.v[5].x; let bleed = s.v[5].y; let side = s.v[5].z; let base = s.v[2].a;
  let rag = 2.0 * inkNoise(wp / max(2.2 * pu, 2.0)) - 1.0;
  let wan = 2.0 * inkNoise(wp / max(16.0 * pu, 8.0) + vec2f(seed * 53.0, 7.0)) - 1.0;
  var density = 0.0;
  let thin = 1.0 - smoothstep(1.5, 5.0, w / pu);
  let h = w * (1.0 + (0.012 + 0.03 * ink + (0.05 + 0.08 * thin) * bleed) * rag + 0.1 * ink * wan);
  var hf = (1.25 * w + 1.6 * pu) * (1.0 + 0.14 * rag + 0.15 * wan);
  if (stalk) { hf = (1.1 * w + 3.0 * pu) * (1.0 + 0.1 * rag + 0.12 * wan); }
  let crept = stampLeafBand(hf - off, hf + off, unit);
  if (crept <= 0.0) { return vec4f(0); }
  let t = clamp(off / max(h, 1e-4), -1.0, 1.0) * side; let tf = clamp(off / hf, -1.0, 1.0);
  var tone = base * (1.0 + (0.16 + 0.25 * ink) * t) * (0.9 + 0.1 * t * t) * (1.0 + (0.1 + 0.14 * ink) * sin(sa / 40.0));
  if (stalk) { tone = base * (0.6 + 0.4 * pow(abs(t), 1.6) + 0.14 * smoothstep(0.72, 0.97, abs(t))) * (1.0 + 0.15 * t) * (1.0 + 0.08 * sin(sa / 40.0)); }
  var body = stampLeafBand(h - off, h + off, unit) * clamp(tone, 0.0, 1.0);
  let hairs = inkNoise(vec2f(off / max(1.3 * pu, 1.7 * unit) + seed * 977.0, sa / 70.0));
  body *= 1.0 - (0.1 + 0.25 * ink) * smoothstep(0.42, 0.62, hairs);
  body = inkPaper(body, wp, pu, 0.35 + 0.4 * ink);
  let fringe = inkPaper(crept * select(0.17, 0.36, stalk) * bleed * pow(max(1.0 - tf * tf, 0.0), 0.6), wp, pu, 1.0);
  density = body + fringe * (1.0 - body);
  let alpha = density * ends * s.head.z;
  return vec4f(s.v[2].rgb * alpha, alpha);
}

fn stampLeafColor(s: Stamp, p: vec2f, unit: f32) -> vec4f {
  if (u32(s.head.w) == 2u) { return stampInkLeaf(s, p, unit); }
  let d = p - s.v[0].xy;
  let dir = s.v[0].zw;
  let q = vec2f(dot(d, dir), dot(d, vec2f(-dir.y, dir.x)));
  let len = s.v[1].x; let wid = s.v[1].y;
  let bend = s.v[1].z; let asym = s.v[1].w;
  let col = s.v[2];
  let cover = stampLeafCover(q, len, wid, bend, asym, unit);
  if (u32(s.head.w) == 1u) {
    let alpha = cover * col.a * s.head.z;
    return vec4f(col.rgb * alpha, alpha);
  }
  let along = clamp(q.x / len, 0.0, 1.0);
  let a = stampLeafQ3(col.a); let b = stampLeafQ3(col.a * 0.93);
  let c = stampLeafQ3(col.a * 0.62);
  var gradientAlpha: f32;
  if (along < 0.45) { gradientAlpha = mix(a, b, along / 0.45); }
  else { gradientAlpha = mix(b, c, (along - 0.45) / 0.55); }
  let baseAlpha = cover * gradientAlpha * s.head.z;
  let overlayAlpha = stampLeafCover(q - vec2f(0.04 * len, 0.0), 0.8 * len, 0.55 * wid, bend, 0.6 * asym, unit)
    * stampLeafQ3(col.a * 0.1) * s.head.z;
  let alpha = overlayAlpha + baseAlpha * (1.0 - overlayAlpha);
  return vec4f(col.rgb * alpha, alpha);
}

fn stampColor(s: Stamp, p: vec2f, unit: f32) -> vec4f {
  if (u32(s.head.x) == 5u) { return stampLeafColor(s, p, unit); }
  if (u32(s.head.x) == 6u) { return stampInkStroke(s, p, unit); }
  if (u32(s.head.x) == 1u) {
    let d = p - s.box.xy; var cover = 0.0;
    for (var k = 0u; k < 5u; k++) { cover = min(1.0, cover + stampShape(s.v[1u + k], d, 0, unit).x); }
    let r = length(d); let alpha = stampSmallAlphas(s);
    let petals = stampSmallGradient(r / s.v[0].x, alpha) * cover * s.head.z;
    let heartAlpha = alpha.w * clamp(0.5 - (r - s.v[0].z) / unit, 0.0, 1.0) * s.head.z;
    let heart = vec4f(STAMP_SMALL_COLORS[3] * heartAlpha, heartAlpha);
    return heart + petals * (1.0 - heart.a);
  }
  if (u32(s.head.x) == 2u && (u32(s.v[1].z) == 2u || s.v[2].y > 0.0)) {
    let shape = stampShape(s.v[0], p - s.v[1].xy, i32(s.head.w), unit);
    let gradient = u32(s.v[1].z);
    var color = s.v[3];
    if (gradient == 2u || gradient == 3u) {
      let t = length(p - s.v[1].xy) / s.v[2].x;
      let middle = select(0.4, 0.3, gradient == 2u);
      let a = vec4f(STAMP_SMALL_COLORS[0], s.v[4].x);
      let b = vec4f(STAMP_SMALL_COLORS[1], s.v[4].y);
      let c = vec4f(STAMP_SMALL_COLORS[2], s.v[4].z);
      if (t < middle) { color = mix(a, b, clamp(t / middle, 0.0, 1.0)); }
      else { color = mix(b, c, clamp((t - middle) / (1.0 - middle), 0.0, 1.0)); }
    }
    let fill = vec4f(color.rgb * color.a, color.a) * shape.x * s.head.z;
    if (s.v[2].y <= 0.0) { return fill; }
    let lineCover = clamp(0.5 - (abs(shape.y) - s.v[2].y / unit), 0.0, 1.0);
    let lineAlpha = lineCover * s.v[2].z * s.head.z;
    let line = vec4f(STAMP_LINE_COLORS[u32(s.v[2].w) - 4u] * lineAlpha, lineAlpha);
    return line + fill * (1.0 - line.a);
  }
  if (u32(s.head.x) == 2u) {
    let cover = stampShape(s.v[0], p - s.v[1].xy, i32(s.head.w), unit).x;
    if (u32(s.v[1].z) == 3u) {
      let t = length(p - s.v[1].xy) / s.v[2].x;
      let a = vec4f(STAMP_SMALL_COLORS[0], s.v[4].x);
      let b = vec4f(STAMP_SMALL_COLORS[1], s.v[4].y);
      let c = vec4f(STAMP_SMALL_COLORS[2], s.v[4].z);
      var color: vec4f;
      if (t < 0.4) { color = mix(a, b, clamp(t / 0.4, 0.0, 1.0)); }
      else { color = mix(b, c, clamp((t - 0.4) / 0.6, 0.0, 1.0)); }
      return vec4f(color.rgb * color.a, color.a) * cover * s.head.z;
    }
    let color = s.v[3];
    return vec4f(color.rgb * color.a, color.a) * cover * s.head.z;
  }
  if (u32(s.head.x) == 4u) {
    let d = p - s.box.xy;
    let count = min(u32(s.v[0].x), 11u);
    var distance = 1e30;
    for (var k = 0u; k < count; k++) {
      let fields = s.v[(2u + k * 2u) / 4u];
      let end = select(fields.xy, fields.zw, k % 2u == 0u);
      let along = clamp(dot(d, end) / max(dot(end, end), 1e-12), 0.0, 1.0);
      distance = min(distance, length(d - end * along) - s.v[0].y);
    }
    let alpha = clamp(0.5 - distance / unit, 0.0, 1.0) * s.head.z;
    return vec4f(STAMP_LINE_COLORS[u32(s.head.w) - 4u] * alpha, alpha);
  }
  if (u32(s.head.x) == 3u && u32(s.v[1].z) == 0u) {
    let m = s.v[0];
    let d = p - s.v[1].xy;
    let u = vec2f(dot(m.xy, d), dot(m.zw, d));
    let r = length(u);
    let g = u / max(r, 1e-6);
    let grow = length(vec2f(m.x * g.x + m.z * g.y, m.y * g.x + m.w * g.y));
    let px = (r - 1.0) / max(grow, 1e-6) / unit;
    let cover = clamp(0.5 - px, 0.0, 1.0);
    let color = s.v[2];
    return vec4f(color.rgb * color.a, color.a) * cover * s.head.z;
  }
  if (u32(s.head.x) == 3u && u32(s.v[1].z) == 2u) {
    let m = s.v[0];
    let d = p - s.v[1].xy;
    let u = vec2f(dot(m.xy, d), dot(m.zw, d));
    let r = length(u);
    let g = u / max(r, 1e-6);
    let grow = length(vec2f(m.x * g.x + m.z * g.y, m.y * g.x + m.w * g.y));
    let px = (r - 1.0) / max(grow, 1e-6) / unit;
    let cover = clamp(0.5 - px, 0.0, 1.0);
    let gradientMatrix = s.v[4];
    let relative = p - s.v[5].xy;
    let q = vec2f(dot(gradientMatrix.xy, relative), dot(gradientMatrix.zw, relative));
    let focus = vec2f(0.3, -0.2);
    let delta = vec2f(0.0) - focus;
    let v = q - focus;
    let r0 = 0.0; let dr = 1.3;
    let aa = dot(delta, delta) - dr * dr;
    let bb = -2.0 * (dot(v, delta) + r0 * dr);
    let cc = dot(v, v) - r0 * r0;
    var t: f32;
    if (abs(aa) < 1e-8) {
      if (abs(bb) < 1e-8) { return vec4f(0); }
      t = -cc / bb; if (r0 + t * dr < 0.0) { return vec4f(0); }
    } else {
      let disc = bb * bb - 4.0 * aa * cc;
      if (disc < 0.0) { return vec4f(0); }
      let root = sqrt(max(0.0, disc));
      let ta = (-bb - root) / (2.0 * aa); let tb = (-bb + root) / (2.0 * aa);
      let va = r0 + ta * dr >= 0.0; let vb = r0 + tb * dr >= 0.0;
      if (!va && !vb) { return vec4f(0); }
      t = select(tb, ta, va); if (va && vb) { t = max(ta, tb); }
    }
    let color = mix(s.v[2], s.v[3], clamp(t, 0.0, 1.0));
    return vec4f(color.rgb * color.a, color.a) * cover * s.head.z;
  }
  if (u32(s.head.x) != 3u || u32(s.v[1].z) != 1u) { return vec4f(0); }
  let d = p - s.v[1].xy;
  let m = s.v[0];
  let t = length(vec2f(dot(m.xy, d), dot(m.zw, d)));
  let a = s.v[2];
  let b = s.v[3];
  var c: vec4f;
  if (t < 0.55) { c = mix(a, b, clamp(t / 0.55, 0.0, 1.0)); }
  else { c = mix(b, vec4f(b.rgb, 0.0), clamp((t - 0.55) / 0.45, 0.0, 1.0)); }
  let alpha = c.a * s.head.z;
  return vec4f(c.rgb * alpha, alpha);
}
`;
