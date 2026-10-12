#ifndef SITE_PAINTER_CANVAS_HPP
#define SITE_PAINTER_CANVAS_HPP

namespace pc {
struct Color {
  float r, g, b, a;
};
struct Paint {
  float data[64], matrix[6];
  bool gradient;
};
struct Pen {
  float width = 1, miter = 10;
  U cap = 0, join = 0;
};
struct Path {
  U n;
  const float *x, *y, *w, *dry = nullptr;
};
struct Brush {
  float col[3], alpha, head = 0, tail = 0, dry = 0, body = 0, bristles = 0, bw = 0, cover = 0, streak = .45f, unit = 0,
                       edge = 0;
  U seed = 0;
  const float* dryGrid = nullptr;
};

inline float q3(U q) {
  return float(q > 1000 ? 1000 : q) / 1000.f;
}
inline Color colorBytes(int r, int g, int b, U q = 1000) {
  return {float(r < 0     ? 0
                : r > 255 ? 255
                          : r) /
              255.f,
          float(g < 0     ? 0
                : g > 255 ? 255
                          : g) /
              255.f,
          float(b < 0     ? 0
                : b > 255 ? 255
                          : b) /
              255.f,
          q3(q)};
}
inline char lower(char c) {
  return c >= 'A' && c <= 'Z' ? char(c + 'a' - 'A') : c;
}
inline bool space(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f';
}
inline void skip(const char*& p) {
  while (space(*p))
    p++;
}
inline bool name(const char* p, const char* wanted) {
  while (*wanted)
    if (lower(*p++) != *wanted++)
      return false;
  skip(p);
  return !*p;
}
inline int hex(char c) {
  c = lower(c);
  return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}
inline bool integer(const char*& p, int& value) {
  skip(p);
  bool neg = false;
  if (*p == '-' || *p == '+') {
    neg = *p == '-';
    p++;
  }
  if (*p < '0' || *p > '9')
    return false;
  U n = 0;
  while (*p >= '0' && *p <= '9') {
    if (n > 1000000)
      return false;
    n = n * 10 + U(*p++ - '0');
  }
  value = neg ? -int(n) : int(n);
  skip(p);
  return true;
}
inline bool alphaQ3(const char*& p, U& value) {
  skip(p);
  bool neg = false;
  if (*p == '-' || *p == '+') {
    neg = *p == '-';
    p++;
  }
  U whole = 0, fraction = 0, digits = 0;
  bool any = false;
  while (*p >= '0' && *p <= '9') {
    any = true;
    if (whole > 1000000)
      return false;
    whole = whole * 10 + U(*p++ - '0');
  }
  if (*p == '.') {
    p++;
    while (*p >= '0' && *p <= '9') {
      any = true;
      if (digits == 3)
        return false;
      fraction = fraction * 10 + U(*p++ - '0');
      digits++;
    }
  }
  if (!any)
    return false;
  while (digits++ < 3)
    fraction *= 10;
  value = neg ? 0 : whole >= 1 ? 1000 : fraction;
  skip(p);
  return true;
}
inline bool color(const char* text, Color& out) {
  const char* p = text;
  if (!p)
    return false;
  skip(p);
  if (name(p, "black")) {
    out = {0, 0, 0, 1};
    return true;
  }
  if (name(p, "white")) {
    out = {1, 1, 1, 1};
    return true;
  }
  if (name(p, "transparent")) {
    out = {0, 0, 0, 0};
    return true;
  }
  if (*p == '#') {
    p++;
    U bytes[8], n = 0;
    while (hex(*p) >= 0) {
      if (n == 8)
        return false;
      bytes[n++] = U(hex(*p++));
    }
    skip(p);
    if (*p || (n != 3 && n != 4 && n != 6 && n != 8))
      return false;
    U r, g, b, a = 255;
    if (n <= 4) {
      r = bytes[0] * 17;
      g = bytes[1] * 17;
      b = bytes[2] * 17;
      if (n == 4)
        a = bytes[3] * 17;
    } else {
      r = bytes[0] * 16 + bytes[1];
      g = bytes[2] * 16 + bytes[3];
      b = bytes[4] * 16 + bytes[5];
      if (n == 8)
        a = bytes[6] * 16 + bytes[7];
    }
    out = {float(r) / 255.f, float(g) / 255.f, float(b) / 255.f, float(a) / 255.f};
    return true;
  }
  if (lower(p[0]) != 'r')
    return false;
  p++;
  if (lower(*p++) != 'g' || lower(*p++) != 'b')
    return false;
  if (lower(*p) == 'a')
    p++;
  if (*p++ != '(')
    return false;
  int r, g, b;
  if (!integer(p, r) || *p++ != ',' || !integer(p, g) || *p++ != ',' || !integer(p, b))
    return false;
  U q = 1000;
  if (*p == ',') {
    p++;
    if (!alphaQ3(p, q))
      return false;
  }
  if (*p++ != ')')
    return false;
  skip(p);
  if (*p)
    return false;
  out = colorBytes(r, g, b, q);
  return true;
}
inline Paint solid(Color c) {
  Paint p = {};
  p.data[1] = p.data[2] = p.data[4] = p.data[7] = 1;
  p.data[17] = c.r;
  p.data[18] = c.g;
  p.data[19] = c.b;
  p.data[20] = c.a;
  return p;
}
inline Paint gradient(U h, U type, const float* args, U n) {
  Paint p = {};
  p.gradient = true;
  p.data[0] = float(type);
  p.data[1] = 1;
  memcpy(p.matrix, canvases[h - 1].s.m, 24);
  memcpy(p.data + 10, args, n * 4);
  return p;
}
inline Paint linear(U h, float x0, float y0, float x1, float y1) {
  float v[4] = {x0, y0, x1, y1};
  return gradient(h, 1, v, 4);
}
inline Paint radial(U h, float x0, float y0, float r0, float x1, float y1, float r1) {
  float v[6] = {x0, y0, x1, y1, r0, r1};
  return gradient(h, 2, v, 6);
}
inline bool stop(Paint& p, float t, Color c) {
  U n = U(p.data[2]);
  if (!p.gradient || !finite(t) || t < 0 || t > 1 || n == 9)
    return false;
  U i = n;
  while (i && p.data[16 + (i - 1) * 5] > t) {
    memcpy(p.data + 16 + i * 5, p.data + 16 + (i - 1) * 5, 20);
    i--;
  }
  float v[5] = {t, c.r, c.g, c.b, c.a};
  memcpy(p.data + 16 + i * 5, v, 20);
  p.data[2] = float(n + 1);
  return true;
}
inline void writeNumbers(const float* v, U n) {
  memset(numbers, 0, sizeof numbers);
  for (U i = 0; i < n; i++)
    numbers[i] = v[i] == 0 ? 0 : v[i];
}
inline U paint(U h, const Paint& p, float alpha) {
  memcpy(material, p.data, 256);
  if (p.gradient) {
    memset(transform, 0, sizeof transform);
    memcpy(transform, p.matrix, 24);
    if (!mc_material_matrix(h))
      return 0;
  }
  material[1] = alpha;
  return 1;
}
inline U setTransform(U h, const float* m) {
  writeNumbers(m, 6);
  return mc_matrix(h, 0);
}
inline U transformBy(U h, const float* m) {
  writeNumbers(m, 6);
  return mc_matrix(h, 1);
}
inline U resetTransform(U h) {
  float m[6] = {1, 0, 0, 1, 0, 0};
  return setTransform(h, m);
}
inline U translate(U h, float x, float y) {
  float m[6] = {1, 0, 0, 1, x, y};
  return transformBy(h, m);
}
inline U scale(U h, float x, float y) {
  float m[6] = {x, 0, 0, y, 0, 0};
  return transformBy(h, m);
}
inline U rotate(U h, float a) {
  return mc_rotate(h, a);
}
inline U save(U h) {
  return mc_save(h);
}
inline void restore(U h) {
  mc_restore(h);
}
inline void begin(U h) {
  mc_begin(h);
}
inline U move(U h, float x, float y) {
  return mc_move(h, x, y);
}
inline U line(U h, float x, float y) {
  return mc_line(h, x, y);
}
inline U close(U h) {
  return mc_close(h);
}
inline U quadratic(U h, float x1, float y1, float x2, float y2) {
  float v[4] = {x1, y1, x2, y2};
  writeNumbers(v, 4);
  return mc_curve(h, 2);
}
inline U cubic(U h, float x1, float y1, float x2, float y2, float x3, float y3) {
  float v[6] = {x1, y1, x2, y2, x3, y3};
  writeNumbers(v, 6);
  return mc_curve(h, 3);
}
inline U rect(U h, float x, float y, float w, float height) {
  return mc_rect(h, x, y, w, height, 0);
}
inline U ellipse(U h, float x, float y, float rx, float ry, float angle, float start, float end, U ccw = 0) {
  float v[7] = {x, y, rx, ry, angle, start, end};
  writeNumbers(v, 7);
  return mc_ellipse(h, ccw);
}
inline U arc(U h, float x, float y, float radius, float start, float end, U ccw = 0) {
  return ellipse(h, x, y, radius, radius, 0, start, end, ccw);
}
inline U fill(U h, const Paint& p, float alpha = 1) {
  return paint(h, p, alpha) && mc_fill(h);
}
inline U stroke(U h, const Paint& p, float alpha, const Pen& pen) {
  if (!paint(h, p, alpha))
    return 0;
  mc_pen(h, pen.width, pen.miter, pen.cap, pen.join);
  return mc_stroke(h);
}
inline U fillRect(U h, const Paint& p, float alpha, float x, float y, float w, float height) {
  if (!finite(x) || !finite(y) || !finite(w) || !finite(height) || !w || !height)
    return 1;
  return paint(h, p, alpha) && mc_rect(h, x, y, w, height, 1);
}
inline void clearRect(U h, float x, float y, float w, float height) {
  if (!finite(x) || !finite(y) || !finite(w) || !finite(height) || !w || !height)
    return;
  auto& c = canvases[h - 1];
  mc_clear(h, x != 0 || y != 0 || w != float(c.w) || height != float(c.h));
}
inline U drawImage(U h, U source, const float* sr, const float* dr, float alpha) {
  for (U i = 0; i < 4; i++)
    if (!finite(sr[i]) || !finite(dr[i]))
      return 1;
  if (sr[2] <= 0 || sr[3] <= 0 || dr[2] <= 0 || dr[3] <= 0 || alpha <= 0)
    return 1;
  float v[9] = {sr[0], sr[1], sr[2], sr[3], dr[0], dr[1], dr[2], dr[3], alpha};
  writeNumbers(v, 9);
  return mc_group(h, source);
}
inline U imageAt(U h, U source, float x, float y, float alpha = 1) {
  auto& s = canvases[source - 1];
  float sr[4] = {0, 0, float(s.w), float(s.h)}, dr[4] = {x, y, float(s.w), float(s.h)};
  return drawImage(h, source, sr, dr, alpha);
}
inline U imageScaled(U h, U source, float x, float y, float w, float height, float alpha = 1) {
  auto& s = canvases[source - 1];
  float sr[4] = {0, 0, float(s.w), float(s.h)}, dr[4] = {x, y, w, height};
  return drawImage(h, source, sr, dr, alpha);
}
inline U stamp(U h, U kind, const float* v, U n, float alpha = 1) {
  if (n > 40)
    return 0;
  memset(stampInput, 0, sizeof stampInput);
  memcpy(stampInput, v, n * 4);
  stampInput[39] = alpha;
  return mc_stamp(h, kind);
}
inline U brush(U h, const Path& path, const Brush& b, float alpha = 1) {
  if (path.n > 4096)
    return 0;
  memset(brushInput, 0, 32 * 4);
  float o[15] = {b.col[0],   b.col[1], b.col[2], b.alpha,  b.head, b.tail, b.dry, b.body,
                 b.bristles, b.bw,     b.cover,  b.streak, b.unit, b.edge, alpha};
  memcpy(brushInput, o, 60);
  for (U k = 0; k <= 8; k++)
    brushInput[20 + k] = b.dryGrid ? b.dryGrid[k] : 1;
  for (U i = 0; i < path.n; i++) {
    float* p = brushInput + 32 + i * 4;
    p[0] = path.x[i];
    p[1] = path.y[i];
    p[2] = path.w[i];
    p[3] = path.dry ? path.dry[i] : 1;
  }
  return mc_brush(h, path.n, b.seed);
}
} // namespace pc
#endif
