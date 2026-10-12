#include "cpu-math.hpp"
struct XY {
  float x, y;
};
static XY xy(float x, float y) {
  return {x, y};
}
static XY xp(const float* m, XY p) {
  auto v = fm::transformPair(m, wasm_f32x4_make(p.x, p.y, 0, 0));
  return {wasm_f32x4_extract_lane(v, 0), wasm_f32x4_extract_lane(v, 1)};
}
static XY sub(XY a, XY b) {
  return {a.x - b.x, a.y - b.y};
}
static XY mid(XY a, XY b) {
  return {(a.x + b.x) * .5f, (a.y + b.y) * .5f};
}
static bool same(XY a, XY b) {
  return a.x == b.x && a.y == b.y;
}
static float cross(XY a, XY b) {
  return a.x * b.y - a.y * b.x;
}
static void ident(float* m) {
  m[0] = m[3] = 1;
  m[1] = m[2] = m[4] = m[5] = 0;
}
static bool inverse(float* o, const float* m) {
  float d = m[0] * m[3] - m[1] * m[2];
  if (!finite(d) || abs(d) < 1e-20f)
    return false;
  o[0] = m[3] / d;
  o[1] = -m[1] / d;
  o[2] = -m[2] / d;
  o[3] = m[0] / d;
  o[4] = (m[2] * m[5] - m[3] * m[4]) / d;
  o[5] = (m[1] * m[4] - m[0] * m[5]) / d;
  return true;
}
static float maxScale(const float* m) {
  float a = m[0] * m[0] + m[1] * m[1], b = m[2] * m[2] + m[3] * m[3], d = m[0] * m[2] + m[1] * m[3];
  return fm::sqrt(max(0, (a + b + fm::sqrt((a - b) * (a - b) + 4 * d * d)) * .5f));
}
struct MState {
  float m[6], width, miter;
  U cap, join;
};
struct MOp {
  U type, steps;
  float p[8], m[6];
};
struct MSub {
  U first, count, closed, curved, mixed;
};
struct MCanvas {
  U used, w, h, current, stackCount, gpu, analytic, ellipses;
  float tolerance;
  Array raw, subs;
  MState s, stack[32];
  U counts[16];
};
static MCanvas canvases[MAX_BANKS];
static U shapeFloats, shapeContours, subStart, shapeSteps, maxCurveDepth;
static float shapeBounds[4];
static void shapeReset() {
  shapeFloats = shapeContours = shapeSteps = maxCurveDepth = 0;
  empty(shapeBounds);
}
static bool putPoint(XY p) {
  if (shapeFloats + 2 > MAX_POINTS * 2) {
    error = 20;
    return false;
  }
  points[shapeFloats++] = p.x;
  points[shapeFloats++] = p.y;
  shapeBounds[0] = min(shapeBounds[0], p.x);
  shapeBounds[1] = min(shapeBounds[1], p.y);
  shapeBounds[2] = max(shapeBounds[2], p.x);
  shapeBounds[3] = max(shapeBounds[3], p.y);
  return true;
}
static bool appendPoint(XY p) {
  if (shapeFloats > subStart && same({points[shapeFloats - 2], points[shapeFloats - 1]}, p))
    return true;
  return putPoint(p);
}
static void startContour() {
  subStart = shapeFloats;
}
static void finishContour() {
  U n = (shapeFloats - subStart) / 2;
  if (n > 1 && same({points[subStart], points[subStart + 1]}, {points[shapeFloats - 2], points[shapeFloats - 1]})) {
    shapeFloats -= 2;
    n--;
  }
  if (shapeContours >= MAX_CONTOURS) {
    error = 21;
    return;
  }
  contours[shapeContours * 4] = subStart;
  contours[shapeContours * 4 + 1] = n;
  shapeContours++;
}
static float distanceSq(XY p, XY a, XY b) {
  XY d = sub(b, a), q = sub(p, a);
  float n = d.x * d.x + d.y * d.y;
  if (n < 1e-20f)
    return q.x * q.x + q.y * q.y;
  float t = fm::clamp((q.x * d.x + q.y * d.y) / n, 0, 1);
  q.x -= t * d.x;
  q.y -= t * d.y;
  return q.x * q.x + q.y * q.y;
}
static void quad(XY a, XY b, XY c, float tolerance, U depth = 0) {
  if (error)
    return;
  if (depth >= 16 || distanceSq(b, a, c) <= tolerance * tolerance) {
    appendPoint(c);
    shapeSteps++;
    maxCurveDepth = max(maxCurveDepth, depth);
    return;
  }
  XY ab = mid(a, b), bc = mid(b, c), q = mid(ab, bc);
  quad(a, ab, q, tolerance, depth + 1);
  quad(q, bc, c, tolerance, depth + 1);
}
static void cubic(XY a, XY b, XY c, XY d, float tolerance, U depth = 0) {
  if (error)
    return;
  if (depth >= 16 || max(distanceSq(b, a, d), distanceSq(c, a, d)) <= tolerance * tolerance) {
    appendPoint(d);
    shapeSteps++;
    maxCurveDepth = max(maxCurveDepth, depth);
    return;
  }
  XY ab = mid(a, b), bc = mid(b, c), cd = mid(c, d), abc = mid(ab, bc), bcd = mid(bc, cd), q = mid(abc, bcd);
  cubic(a, ab, abc, q, tolerance, depth + 1);
  cubic(q, bcd, cd, d, tolerance, depth + 1);
}
static U curveSteps(float radius, float angle, float tolerance) {
  float step = radius <= tolerance ? fm::pi * .5f : 2 * fm::acos(fm::clamp(1 - tolerance / radius, -1, 1));
  if (!(step > 0))
    step = .0001f;
  return U(max(2, ceil(abs(angle) / min(fm::pi * .5f, step))));
}
static XY endpoint(const MOp& o) {
  if (o.type == 3)
    return {o.p[4], o.p[5]};
  if (o.type == 2)
    return {o.p[2], o.p[3]};
  if (o.type != 4)
    return {o.p[0], o.p[1]};
  float a = o.p[5] + o.p[6], ca = fm::cos(o.p[4]), sa = fm::sin(o.p[4]), x = o.p[2] * fm::cos(a),
        y = o.p[3] * fm::sin(a);
  return {o.p[0] + ca * x - sa * y, o.p[1] + sa * x + ca * y};
}
static MSub* current(MCanvas& c) {
  return c.current == NONE ? nullptr : (MSub*)c.subs.ptr + c.current;
}
static bool appendRaw(MCanvas& c, U type, const float* p, U steps = 0) {
  auto s = current(c);
  if (!s) {
    error = 22;
    return false;
  }
  if (!reserve(c.raw, c.raw.n + 1))
    return false;
  auto o = (MOp*)c.raw.ptr + c.raw.n++;
  memset(o, 0, sizeof *o);
  o->type = type;
  o->steps = steps;
  memcpy(o->p, p, 32);
  memcpy(o->m, c.s.m, 24);
  auto first = (MOp*)c.raw.ptr + s->first;
  for (U i = 0; i < 6; i++)
    if (first->m[i] != c.s.m[i])
      s->mixed = 1;
  s->count++;
  if (type >= 2)
    s->curved = 1;
  return true;
}
static bool moveRaw(MCanvas& c, float x, float y) {
  if (!reserve(c.subs, c.subs.n + 1))
    return false;
  c.current = c.subs.n++;
  auto s = current(c);
  *s = {c.raw.n, 0, 0, 0, 0};
  float p[8] = {x, y};
  return appendRaw(c, 0, p);
}
static bool lineRaw(MCanvas& c, float x, float y) {
  if (!current(c))
    return moveRaw(c, x, y);
  auto s = current(c);
  auto prev = (MOp*)c.raw.ptr + s->first + s->count - 1;
  XY a = xp(prev->m, endpoint(*prev)), b = xp(c.s.m, {x, y});
  if (same(a, b))
    return true;
  float p[8] = {x, y};
  return appendRaw(c, 1, p);
}
static void flatten(MCanvas& c) {
  shapeReset();
  for (U ci = 0; ci < c.subs.n; ci++) {
    auto& s = ((MSub*)c.subs.ptr)[ci];
    startContour();
    for (U i = 0; i < s.count; i++) {
      auto& o = ((MOp*)c.raw.ptr)[s.first + i];
      if (o.type <= 1) {
        appendPoint(xp(o.m, {o.p[0], o.p[1]}));
        continue;
      }
      XY a = {points[shapeFloats - 2], points[shapeFloats - 1]};
      if (o.type == 2)
        quad(a, xp(o.m, {o.p[0], o.p[1]}), xp(o.m, {o.p[2], o.p[3]}), c.tolerance);
      else if (o.type == 3)
        cubic(a, xp(o.m, {o.p[0], o.p[1]}), xp(o.m, {o.p[2], o.p[3]}), xp(o.m, {o.p[4], o.p[5]}), c.tolerance);
      else {
        float ca = fm::cos(o.p[4]), sa = fm::sin(o.p[4]);
        for (U j = 1; j <= o.steps; j++) {
          float t = o.p[5] + o.p[6] * float(j) / float(o.steps), x = o.p[2] * fm::cos(t), y = o.p[3] * fm::sin(t);
          appendPoint(xp(o.m, {o.p[0] + ca * x - sa * y, o.p[1] + sa * x + ca * y}));
        }
        shapeSteps += o.steps;
      }
    }
    finishContour();
    if (error)
      return;
  }
  c.counts[6] += shapeSteps;
  c.counts[7] = max(c.counts[7], maxCurveDepth);
}
static bool outside(MCanvas& c, const float* b, float margin = 0) {
  return b[2] + margin < 0 || b[3] + margin < 0 || b[0] - margin > float(c.w) || b[1] - margin > float(c.h);
}
static bool convexShape() {
  if (shapeContours != 1)
    return false;
  U n = contours[1];
  float* p = points + contours[0];
  if (n < 3 || n > 64)
    return false;
  float span = max(shapeBounds[2] - shapeBounds[0], shapeBounds[3] - shapeBounds[1]),
        epsilon = max(1e-7f, span * span * 2e-7f);
  int winding = 0;
  for (U i = 0; i < n; i++) {
    U j = (i + 1) % n, k = (i + 2) % n;
    float z =
        cross({p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]}, {p[k * 2] - p[j * 2], p[k * 2 + 1] - p[j * 2 + 1]});
    if (!finite(z) || abs(z) <= epsilon)
      return false;
    int sign = z > 0 ? 1 : -1;
    if (!winding)
      winding = sign;
    else if (winding != sign)
      return false;
  }
  for (U i = 0; i < n; i++) {
    U next = (i + 1) % n;
    XY a = {p[i * 2], p[i * 2 + 1]}, d = {p[next * 2] - a.x, p[next * 2 + 1] - a.y};
    for (U j = 0; j < n; j++)
      if (j != i && j != next) {
        float z = cross(d, {p[j * 2] - a.x, p[j * 2 + 1] - a.y});
        if (!finite(z) || abs(z) <= epsilon || (z > 0 ? 1 : -1) != winding)
          return false;
      }
  }
  return true;
}
static bool visibleMaterial() {
  if (!(material[1] > 0))
    return false;
  for (U i = 0; i < U(material[2]); i++)
    if (material[20 + i * 5] > 0)
      return true;
  return false;
}
static bool emitShape(U handle, bool stroke = false) {
  auto& c = canvases[handle - 1];
  if (error)
    return false;
  if (!visibleMaterial())
    return true;
  if (outside(c, shapeBounds) || !valid(shapeBounds)) {
    c.counts[3]++;
    return true;
  }
  bool convex = !stroke && convexShape();
  float bounds[4];
  memcpy(bounds, shapeBounds, 16);
  U emitted = td_fans(handle, shapeContours, stroke ? 1 : 0);
  if (error)
    return false;
  if (!emitted)
    return true;
  memset(numbers, 0, sizeof numbers);
  memcpy(numbers, bounds, 16);
  if (!td_path(handle, 1, emitted, emitted / 2, convex ? 1 : 0))
    return false;
  c.counts[stroke ? 1 : 0]++;
  return true;
}
static void include(float* b, XY p) {
  b[0] = min(b[0], p.x);
  b[1] = min(b[1], p.y);
  b[2] = max(b[2], p.x);
  b[3] = max(b[3], p.y);
}
static float second(XY a, XY b, XY d) {
  return fm::hypot(a.x - 2 * b.x + d.x, a.y - 2 * b.y + d.y);
}
static float compactData[8192 * 16], compactMatrices[8192 * 8];
static bool compactFill(U handle) {
  auto& c = canvases[handle - 1];
  if (!c.gpu || !c.subs.n)
    return false;
  bool curved = false;
  for (U i = 0; i < c.subs.n; i++)
    curved |= ((MSub*)c.subs.ptr)[i].curved;
  if (!curved)
    return false;
  if (!c.ellipses && c.subs.n == 1) {
    auto& s = ((MSub*)c.subs.ptr)[0];
    auto o = (MOp*)c.raw.ptr + s.first;
    if (s.count >= 2 && o[1].type == 4 && s.count <= 3) {
      c.counts[9]++;
      c.counts[12]++;
      return false;
    }
  }
  U segmentCount = 0, count = 0, curveCount = 0, expandedBytes = 0;
  float bounds[4];
  empty(bounds);
  for (U ci = 0; ci < c.subs.n; ci++) {
    auto& s = ((MSub*)c.subs.ptr)[ci];
    auto raw = (MOp*)c.raw.ptr + s.first;
    float inv[6];
    if (s.mixed || !inverse(inv, raw->m)) {
      c.counts[9]++;
      return false;
    }
    XY anchor = endpoint(raw[0]), previous = anchor;
    U first = segmentCount, stepsTotal = 0;
    include(bounds, xp(raw->m, anchor));
    for (U i = 1; i < s.count; i++) {
      auto& o = raw[i];
      if (segmentCount >= 8192) {
        c.counts[9]++;
        return false;
      }
      float *d = compactData + segmentCount * 16, *m = compactMatrices + segmentCount * 8;
      memset(d, 0, 64);
      memset(m, 0, 32);
      memcpy(m, o.m, 24);
      d[0] = o.type;
      d[4] = anchor.x;
      d[5] = anchor.y;
      d[6] = previous.x;
      d[7] = previous.y;
      U n = 1;
      if (o.type == 1) {
        XY end = endpoint(o);
        d[8] = end.x;
        d[9] = end.y;
        include(bounds, xp(o.m, end));
        if (same(previous, anchor) || same(end, anchor)) {
          previous = end;
          continue;
        }
        previous = end;
      } else if (o.type == 2 || o.type == 3) {
        memcpy(d + 8, o.p, o.type == 2 ? 16 : 24);
        XY a = xp(o.m, previous), b = xp(o.m, {o.p[0], o.p[1]}), q = xp(o.m, {o.p[2], o.p[3]});
        include(bounds, a);
        include(bounds, b);
        include(bounds, q);
        float bound = second(a, b, q) * .25f;
        if (o.type == 3) {
          XY z = xp(o.m, {o.p[4], o.p[5]});
          include(bounds, z);
          bound = .75f * max(second(a, b, q), second(b, q, z));
        }
        n = U(max(1, ceil(fm::sqrt(bound / c.tolerance))));
        previous = endpoint(o);
        curveCount += n;
      } else if (o.type == 4) {
        float ca = fm::cos(o.p[4]), sa = fm::sin(o.p[4]);
        XY u = {ca * o.p[2], sa * o.p[2]}, v = {-sa * o.p[3], ca * o.p[3]}, center = xp(o.m, {o.p[0], o.p[1]});
        d[6] = o.p[0];
        d[7] = o.p[1];
        d[8] = u.x;
        d[9] = u.y;
        d[10] = v.x;
        d[11] = v.y;
        d[14] = o.p[5];
        d[15] = o.p[6];
        float ux = o.m[0] * u.x + o.m[2] * u.y, uy = o.m[1] * u.x + o.m[3] * u.y, vx = o.m[0] * v.x + o.m[2] * v.y,
              vy = o.m[1] * v.x + o.m[3] * v.y, bx = fm::hypot(ux, vx), by = fm::hypot(uy, vy);
        include(bounds, {center.x - bx, center.y - by});
        include(bounds, {center.x + bx, center.y + by});
        n = o.steps;
        previous = endpoint(o);
        curveCount += n;
      }
      if (n > 256 || !n) {
        c.counts[9]++;
        return false;
      }
      d[1] = float(n);
      stepsTotal += n;
      count += n * 3;
      segmentCount++;
    }
    expandedBytes += stepsTotal > 2 ? (stepsTotal - 2) * 24 : 0;
    if (s.count == 7 && segmentCount - first == 6 && same(anchor, {0, 0}) && stepsTotal <= 256) {
      constexpr U types[6] = {3, 2, 1, 1, 2, 3}, lengths[6] = {6, 4, 2, 2, 4, 6};
      constexpr float values[6][6] = {{.22f, -.2f, .5f, -.56f, .84f, -.42f},
                                      {1.02f, -.33f, .99f, -.1f},
                                      {.86f, -.01f},
                                      {.99f, .09f},
                                      {1.02f, .33f, .84f, .42f},
                                      {.5f, .56f, .22f, .2f, 0, 0}};
      float radius = raw[1].p[0] / .22f, epsilon = max(1, abs(radius)) * 2e-6f;
      bool canonical = radius > 0;
      for (U i = 0; i < 6 && canonical; i++) {
        canonical = raw[i + 1].type == types[i];
        for (U j = 0; j < lengths[i] && canonical; j++)
          canonical = abs(raw[i + 1].p[j] - values[i][j] * radius) <= epsilon;
      }
      if (canonical) {
        float steps[6];
        for (U i = 0; i < 6; i++)
          steps[i] = compactData[(first + i) * 16 + 1];
        float* d = compactData + first * 16;
        memset(d, 0, 64);
        d[0] = 5;
        d[1] = float(stepsTotal);
        memcpy(d + 8, steps, 24);
        float* m = compactMatrices + first * 8;
        for (U i = 0; i < 4; i++)
          m[i] *= radius;
        segmentCount = first + 1;
      }
    }
  }
  if (outside(c, bounds) || !valid(bounds)) {
    c.counts[3]++;
    return true;
  }
  if (!count || !visibleMaterial())
    return true;
  if (segmentCount * 96 > expandedBytes) {
    c.counts[9]++;
    c.counts[10]++;
    return false;
  }
  U first = banks[handle - 1].segments.n;
  for (U i = 0; i < segmentCount; i++) {
    memcpy(transform, compactMatrices + i * 8, 32);
    float saved[64];
    memcpy(saved, material, 256);
    memcpy(material, compactData + i * 16, 64);
    if (!td_segment(handle, U(material[1]))) {
      memcpy(material, saved, 256);
      return false;
    }
    memcpy(material, saved, 256);
  }
  memset(numbers, 0, sizeof numbers);
  memcpy(numbers, bounds, 16);
  if (!td_parametric(handle, first, count))
    return false;
  c.counts[0]++;
  c.counts[8] += curveCount;
  return true;
}
static XY strokeLocal[MAX_POINTS];
static U strokeStarts[MAX_CONTOURS], strokeCounts[MAX_CONTOURS], strokeClosed[MAX_CONTOURS];
static void polygon(MCanvas& c, const XY* p, U n) {
  startContour();
  for (U i = 0; i < n; i++)
    appendPoint(xp(c.s.m, p[i]));
  finishContour();
}
static void disc(MCanvas& c, XY p, float r) {
  U n = max(8, curveSteps(r * maxScale(c.s.m), fm::tau, c.tolerance));
  startContour();
  for (U i = 0; i < n; i++) {
    float t = float(i) * fm::tau / float(n);
    appendPoint(xp(c.s.m, {p.x + fm::cos(t) * r, p.y + fm::sin(t) * r}));
  }
  finishContour();
}
static bool analyticStroke(U handle) {
  auto& c = canvases[handle - 1];
  if (!c.analytic || c.s.cap != 1)
    return false;
  float* m = c.s.m;
  float l0 = m[0] * m[0] + m[1] * m[1], l1 = m[2] * m[2] + m[3] * m[3], dot = m[0] * m[2] + m[1] * m[3],
        metric = max(l0, l1);
  if (!(metric > 0) || abs(l0 - l1) > metric * 2e-6f || abs(dot) > metric * 2e-6f)
    return false;
  float radius = c.s.width * .5f * fm::sqrt((l0 + l1) * .5f), bounds[4];
  empty(bounds);
  float endpoints[132] = {};
  U n = 0;
  for (U ci = 0; ci < c.subs.n; ci++) {
    auto& s = ((MSub*)c.subs.ptr)[ci];
    if (s.closed || s.curved || s.count != 2 || n >= 32)
      return false;
    auto raw = (MOp*)c.raw.ptr + s.first;
    XY a = xp(raw[0].m, endpoint(raw[0])), b = xp(raw[1].m, endpoint(raw[1]));
    if (same(a, b))
      continue;
    endpoints[n * 4] = a.x;
    endpoints[n * 4 + 1] = a.y;
    endpoints[n * 4 + 2] = b.x;
    endpoints[n * 4 + 3] = b.y;
    n++;
    include(bounds, {min(a.x, b.x) - radius, min(a.y, b.y) - radius});
    include(bounds, {max(a.x, b.x) + radius, max(a.y, b.y) + radius});
  }
  if (!n)
    return false;
  if (outside(c, bounds)) {
    c.counts[3]++;
    return true;
  }
  if (!visibleMaterial())
    return true;
  U floats = ((n * 4 + 5) / 6) * 6, at = td_vertex_space(handle, floats);
  if (!at)
    return false;
  memcpy((void*)at, endpoints, floats * 4);
  memset(numbers, 0, sizeof numbers);
  memcpy(numbers, bounds, 16);
  numbers[4] = radius;
  if (!td_path(handle, 2, floats, n, 0))
    return false;
  c.counts[1]++;
  return true;
}
static bool strokeShape(U handle) {
  auto& c = canvases[handle - 1];
  float inv[6];
  if (!inverse(inv, c.s.m))
    return true;
  flatten(c);
  if (error)
    return false;
  U total = 0, nc = shapeContours;
  for (U ci = 0; ci < nc; ci++) {
    U at = contours[ci * 4], n = contours[ci * 4 + 1];
    strokeStarts[ci] = total;
    strokeCounts[ci] = n;
    strokeClosed[ci] = ((MSub*)c.subs.ptr)[ci].closed;
    for (U i = 0; i < n; i++)
      strokeLocal[total++] = xp(inv, {points[at + i * 2], points[at + i * 2 + 1]});
  }
  shapeReset();
  float r = c.s.width * .5f;
  for (U ci = 0; ci < nc; ci++) {
    XY* p = strokeLocal + strokeStarts[ci];
    U n = strokeCounts[ci], closed = strokeClosed[ci], edges = closed ? n : n > 0 ? n - 1 : 0;
    if (n < 2)
      continue;
    for (U i = 0; i < edges; i++) {
      XY a = p[i], b = p[(i + 1) % n], d = sub(b, a);
      float l = fm::hypot(d.x, d.y);
      if (!l)
        continue;
      d.x /= l;
      d.y /= l;
      XY normal = {-d.y * r, d.x * r};
      float e0 = !closed && i == 0 && c.s.cap == 2 ? r : 0, e1 = !closed && i == edges - 1 && c.s.cap == 2 ? r : 0;
      XY q[4] = {{a.x + normal.x - d.x * e0, a.y + normal.y - d.y * e0},
                 {b.x + normal.x + d.x * e1, b.y + normal.y + d.y * e1},
                 {b.x - normal.x + d.x * e1, b.y - normal.y + d.y * e1},
                 {a.x - normal.x - d.x * e0, a.y - normal.y - d.y * e0}};
      polygon(c, q, 4);
    }
    for (U i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      if (c.s.join == 1) {
        disc(c, p[i], r);
        continue;
      }
      XY before = sub(p[i], p[(i + n - 1) % n]), after = sub(p[(i + 1) % n], p[i]);
      float la = fm::hypot(before.x, before.y), lb = fm::hypot(after.x, after.y);
      if (!la || !lb)
        continue;
      before.x /= la;
      before.y /= la;
      after.x /= lb;
      after.y /= lb;
      float z = cross(before, after);
      if (abs(z) < 1e-7f)
        continue;
      float sign = z > 0 ? -1 : 1;
      XY a = {p[i].x - before.y * r * sign, p[i].y + before.x * r * sign},
         b = {p[i].x - after.y * r * sign, p[i].y + after.x * r * sign}, q[4] = {p[i], a};
      U count = 2;
      if (c.s.join == 0) {
        float t = cross(sub(b, a), after) / z;
        XY m = {a.x + t * before.x, a.y + t * before.y};
        if (fm::hypot(m.x - p[i].x, m.y - p[i].y) <= r * c.s.miter)
          q[count++] = m;
      }
      q[count++] = b;
      polygon(c, q, count);
    }
    if (!closed && c.s.cap == 1) {
      disc(c, p[0], r);
      disc(c, p[n - 1], r);
    }
    if (error)
      return false;
  }
  return emitShape(handle, true);
}
extern "C" {
U mc_create(U w, U h, float tolerance, U gpu, U analytic, U ellipses) {
  U handle = td_bank();
  if (!handle)
    return 0;
  auto& c = canvases[handle - 1];
  c = {};
  c.used = 1;
  c.w = w;
  c.h = h;
  c.tolerance = tolerance;
  c.gpu = gpu;
  c.analytic = analytic;
  c.ellipses = ellipses;
  c.raw.stride = sizeof(MOp);
  c.subs.stride = sizeof(MSub);
  c.current = NONE;
  ident(c.s.m);
  c.s.width = 1;
  c.s.miter = 10;
  return handle;
}
void mc_reset(U h, U w, U height) {
  auto& c = canvases[h - 1];
  td_clear(h);
  c.w = w;
  c.h = height;
  c.raw.n = c.subs.n = c.stackCount = 0;
  c.current = NONE;
  ident(c.s.m);
  c.s.width = 1;
  c.s.miter = 10;
  c.s.cap = c.s.join = 0;
  memset(c.counts, 0, sizeof c.counts);
}
void mc_reset_all() {
  for (auto& c : canvases)
    if (c.used) {
      give(c.raw.ptr, c.raw.cap * c.raw.stride);
      give(c.subs.ptr, c.subs.cap * c.subs.stride);
      c = {};
    }
  tileWorkBank = 0;
}
U mc_prepare_tile(U h) {
  if (!h || h > MAX_BANKS || !canvases[h - 1].used)
    return 0;
  if (tileWorkBank && tileWorkBank != h) {
    U old = tileWorkBank - 1, next = h - 1;
    td_clear(tileWorkBank);
    td_clear(h);
    Bank b = banks[old];
    banks[old] = banks[next];
    banks[next] = b;
    auto& a = canvases[old];
    auto& c = canvases[next];
    a.raw.n = a.subs.n = c.raw.n = c.subs.n = 0;
    a.current = c.current = NONE;
    Array raw = a.raw, subs = a.subs;
    a.raw = c.raw;
    a.subs = c.subs;
    c.raw = raw;
    c.subs = subs;
    hashBank = NONE;
    tileBankSwaps++;
  }
  tileWorkBank = h;
  return 1;
}
U mc_info(U h, U key) {
  return key == 0 ? (U)canvases[h - 1].s.m : (U)canvases[h - 1].counts;
}
U mc_matrix(U h, U multiply) {
  auto& c = canvases[h - 1];
  float* m = c.s.m;
  if (!multiply)
    memcpy(m, numbers, 24);
  else {
    float a[6];
    memcpy(a, m, 24);
    auto first = wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_make(a[0], a[1], a[0], a[1]),
                                               wasm_f32x4_make(numbers[0], numbers[0], numbers[2], numbers[2])),
                                wasm_f32x4_mul(wasm_f32x4_make(a[2], a[3], a[2], a[3]),
                                               wasm_f32x4_make(numbers[1], numbers[1], numbers[3], numbers[3])));
    wasm_v128_store(m, first);
    XY t = xp(a, {numbers[4], numbers[5]});
    m[4] = t.x;
    m[5] = t.y;
  }
  return 1;
}
U mc_rotate(U h, float angle) {
  numbers[0] = numbers[3] = fm::cos(angle);
  numbers[1] = fm::sin(angle);
  numbers[2] = -numbers[1];
  numbers[4] = numbers[5] = 0;
  return mc_matrix(h, 1);
}
U mc_save(U h) {
  auto& c = canvases[h - 1];
  if (c.stackCount == 32) {
    error = 23;
    return 0;
  }
  c.stack[c.stackCount++] = c.s;
  return 1;
}
void mc_restore(U h) {
  auto& c = canvases[h - 1];
  if (c.stackCount)
    c.s = c.stack[--c.stackCount];
}
void mc_pen(U h, float width, float miter, U cap, U join) {
  auto& s = canvases[h - 1].s;
  s.width = width;
  s.miter = miter;
  s.cap = cap;
  s.join = join;
}
void mc_begin(U h) {
  auto& c = canvases[h - 1];
  c.raw.n = c.subs.n = 0;
  c.current = NONE;
}
U mc_move(U h, float x, float y) {
  return moveRaw(canvases[h - 1], x, y);
}
U mc_line(U h, float x, float y) {
  return lineRaw(canvases[h - 1], x, y);
}
U mc_curve(U h, U type) {
  auto& c = canvases[h - 1];
  if (!current(c) && !moveRaw(c, numbers[0], numbers[1]))
    return 0;
  float p[8] = {};
  memcpy(p, numbers, type == 2 ? 16 : 24);
  return appendRaw(c, type, p);
}
U mc_close(U h) {
  auto& c = canvases[h - 1];
  auto s = current(c);
  if (!s)
    return 1;
  auto first = (MOp*)c.raw.ptr + s->first;
  s->closed = 1;
  float x = first->p[0], y = first->p[1], saved[6];
  memcpy(saved, c.s.m, 24);
  memcpy(c.s.m, first->m, 24);
  U ok = lineRaw(c, x, y);
  memcpy(c.s.m, saved, 24);
  return ok;
}
U mc_ellipse(U h, U anticlockwise) {
  auto& c = canvases[h - 1];
  float p[8];
  memcpy(p, numbers, 32);
  float raw = p[6] - p[5], delta;
  if (!anticlockwise)
    delta = raw >= fm::tau ? fm::tau : raw - fm::floor(raw / fm::tau) * fm::tau;
  else {
    float q = -raw;
    delta = q >= fm::tau ? -fm::tau : -(q - fm::floor(q / fm::tau) * fm::tau);
  }
  p[6] = delta;
  float ca = fm::cos(p[4]), sa = fm::sin(p[4]), x = p[2] * fm::cos(p[5]), y = p[3] * fm::sin(p[5]);
  if (!lineRaw(c, p[0] + ca * x - sa * y, p[1] + sa * x + ca * y))
    return 0;
  if (!delta || !p[2] || !p[3])
    return 1;
  U steps = curveSteps(max(p[2], p[3]) * maxScale(c.s.m), delta, c.tolerance);
  return appendRaw(c, 4, p, steps);
}
U mc_fill(U h) {
  if (compactFill(h))
    return !error;
  flatten(canvases[h - 1]);
  return emitShape(h);
}
U mc_stroke(U h) {
  if (analyticStroke(h))
    return !error;
  return strokeShape(h);
}
U mc_rect(U h, float x, float y, float w, float height, U fill) {
  auto& c = canvases[h - 1];
  if (fill) {
    shapeReset();
    XY p[4] = {{x, y}, {x + w, y}, {x + w, y + height}, {x, y + height}};
    polygon(c, p, 4);
    return emitShape(h);
  }
  return moveRaw(c, x, y) && lineRaw(c, x + w, y) && lineRaw(c, x + w, y + height) && lineRaw(c, x, y + height) &&
         mc_close(h);
}
void mc_clear(U h, U partial) {
  td_clear(h);
  auto& c = canvases[h - 1];
  memset(c.counts, 0, sizeof c.counts);
  c.counts[4] = 1;
  c.counts[5] = partial;
}
U mc_material_matrix(U h) {
  float inv[6];
  if (!inverse(inv, transform))
    return 0;
  memcpy(material + 4, inv, 24);
  return 1;
}
U mc_group(U h, U source) {
  auto& c = canvases[h - 1];
  float* m = c.s.m;
  if (abs(m[1]) > 1e-7f || abs(m[2]) > 1e-7f || m[0] <= 0 || m[3] <= 0) {
    error = 24;
    return 0;
  }
  numbers[4] = m[0] * numbers[4] + m[4];
  numbers[5] = m[3] * numbers[5] + m[5];
  numbers[6] *= m[0];
  numbers[7] *= m[3];
  U ok = td_group(h, source);
  if (ok)
    c.counts[2]++;
  return ok;
}
U mc_leaf(U h, float x, float y, float angle, float length, float width, float bend, float asym) {
  auto& c = canvases[h - 1];
  float ca = fm::cos(angle), sa = fm::sin(angle);
  XY up[17], lo[17];
  for (U i = 0; i <= 16; i++) {
    float s = float(i) / 16, cx = s * length, cy = bend * length * s * s, dy = 2 * bend * length * s,
          l = fm::hypot(length, dy), nx = -dy / l, ny = length / l,
          half = width * fm::pow(fm::sin(fm::pi * fm::pow(.035f + .965f * s, .62f)), 1.08f);
    up[i] = {cx + nx * half * (1 + asym), cy + ny * half * (1 + asym)};
    lo[i] = {cx - nx * half * (1 - asym), cy - ny * half * (1 - asym)};
  }
  mc_begin(h);
  for (U i = 0; i <= 16; i++) {
    XY p = {x + up[i].x * ca - up[i].y * sa, y + up[i].x * sa + up[i].y * ca};
    if (i)
      lineRaw(c, p.x, p.y);
    else
      moveRaw(c, p.x, p.y);
  }
  for (int i = 16; i >= 0; i--)
    lineRaw(c, x + lo[i].x * ca - lo[i].y * sa, y + lo[i].x * sa + lo[i].y * ca);
  return mc_close(h);
}
}
