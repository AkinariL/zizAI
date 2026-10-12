#pragma once
namespace painter {
inline void setObjectContext(Word sc, Word li, int cell, Word stroke = NONE) {
  painterObjectSc = sc;
  painterObjectLayer = li;
  painterObjectCell = cell;
  painterObjectBase = stroke == NONE ? 0 : stroke * 65536u;
  painterObjectOrdinal = 0;
  painterObjectDepth = 0;
  objectOrdinal = 0;
  painterObjectsEnabled = config.objects != 0;
}
inline void objectAdvance(Word n = 1) {
  painterObjectOrdinal += n;
  objectOrdinal += n;
}
inline void objectBegin(Word h, Word kind) {
  const Word ordinal = painterObjectBase + painterObjectOrdinal;
  objectAdvance();
  if (!painterObjectsEnabled)
    return;
  if (painterObjectDepth == 16) {
    error = 78;
    return;
  }
  auto& o = painterObjectStack[painterObjectDepth++];
  o = {};
  o.h = h;
  o.first = banks[h - 1].stamps.n;
  o.ordinal = ordinal;
  o.kind = kind;
  o.cell = painterObjectCell;
  empty(o.bounds);
}
inline void objectEnd(Word h) {
  if (!painterObjectsEnabled || !painterObjectDepth)
    return;
  const auto o = painterObjectStack[--painterObjectDepth];
  auto& b = banks[h - 1];
  if (o.h != h) {
    error = 78;
    return;
  }
  const Word count = b.stamps.n - o.first;
  if (!count)
    return;
  if (count > 65535 || !valid(o.bounds) || !reserve(b.objects, b.objects.n + 1)) {
    if (!error)
      error = 78;
    return;
  }
  auto f = (float*)b.objects.ptr + b.objects.n * 8;
  auto u = (Word*)f;
  const float dx = o.bounds[2] - o.bounds[0], dy = o.bounds[3] - o.bounds[1];
  u[0] = Word(o.cell);
  u[1] = o.ordinal;
  f[2] = (o.bounds[0] + o.bounds[2]) * .5f;
  f[3] = (o.bounds[1] + o.bounds[3]) * .5f;
  f[4] = fm::hypot(dx, dy) * .5f + .00001f;
  f[5] = 1;
  u[6] = o.first;
  u[7] = count | (o.kind << 16);
  b.objects.n++;
}
inline Word stationDraw(int j) {
  Random r(cellSeed(7777, 3, j));
  r.range(.2f, .8f);
  const Word u = r.raw();
  return Wide(u) * 100 < (Wide(45) << 32) ? 0 : Wide(u) * 100 < (Wide(85) << 32) ? 1 : 2;
}
inline Word stationKind(int j) {
  const Word k = stationDraw(j), a = stationDraw(j - 1);
  if (k == 2 && a == 2)
    return (j & 1) ? 0 : 1;
  if (k == a && a == stationDraw(j - 2))
    return k == 0 ? 1 : 0;
  return k;
}
struct Stroke {
  float z, x0, x1;
  Word kind, seed, first, count;
  int j;
  Word i;
};
constexpr Word maxCloseStrokes = 1024, maxCloseFloats = 131072, closePoolBytes = 2097152;
struct ClosePlan {
  Stroke strokes[maxCloseStrokes];
  float data[maxCloseFloats];
  Word strokeCount = 0, dataCount = 0, status = 0;
  int cell = 0;
  void reset(int j) {
    strokeCount = dataCount = status = 0;
    cell = j;
  }
  bool add(Word kind, float z, float x0, float x1, Word seed, const float* p, Word n) {
    if (strokeCount == maxCloseStrokes || n > maxCloseFloats - dataCount) {
      status = 80;
      return false;
    }
    strokes[strokeCount] = {z, x0, x1, kind, seed, dataCount, n, cell, strokeCount};
    if (n)
      memcpy(data + dataCount, p, n * 4);
    dataCount += n;
    strokeCount++;
    return true;
  }
};
struct CloseEntry {
  Word used, world, offset, bytes, strokeCount, dataCount, pins, serial, state, draws;
  int cell;
};
static ClosePlan closeScratch;
alignas(16) static unsigned char closePool[closePoolBytes];
static CloseEntry closeEntries[160];
static Word closeSerial, closeUsed, closePeak, closeEvictions;
inline void clearCloseCache() {
  for (auto& e : closeEntries)
    e = {};
  closeUsed = closeSerial = 0;
}
inline void evictClose(Word id) {
  auto& e = closeEntries[id];
  closeUsed -= e.bytes;
  e = {};
  closeEvictions++;
}
inline Word closeGap(Word bytes) {
  Word at = 0;
  for (Word loop = 0; loop <= 160; loop++) {
    Word next = closePoolBytes, end = at;
    bool overlap = false;
    for (auto& e : closeEntries)
      if (e.used) {
        if (e.offset <= at && at < e.offset + e.bytes) {
          end = e.offset + e.bytes;
          overlap = true;
        } else if (e.offset > at)
          next = fm::min(float(next), float(e.offset));
      }
    if (overlap) {
      at = end;
      continue;
    }
    if (bytes <= next - at)
      return at;
    at = next;
  }
  return NONE;
}
inline Word cacheClose(Word sc, const ClosePlan& p, Word state = 0, Word draws = 0) {
  const Word bytes = align16(p.strokeCount * sizeof(Stroke) + p.dataCount * 4);
  if (bytes > closePoolBytes) {
    cellStatus = 80;
    return NONE;
  }
  Word slot = NONE, at = NONE;
  for (Word loop = 0; loop <= 160; loop++) {
    for (Word i = 0; i < 160; i++)
      if (!closeEntries[i].used) {
        slot = i;
        break;
      }
    at = closeGap(bytes ? bytes : 16);
    if (slot != NONE && at != NONE)
      break;
    Word oldest = NONE;
    for (Word i = 0; i < 160; i++)
      if (closeEntries[i].used && !closeEntries[i].pins &&
          (oldest == NONE || closeEntries[i].serial < closeEntries[oldest].serial))
        oldest = i;
    if (oldest == NONE) {
      cellStatus = 80;
      return NONE;
    }
    evictClose(oldest);
    slot = NONE;
  }
  if (slot == NONE || at == NONE) {
    cellStatus = 80;
    return NONE;
  }
  auto& e = closeEntries[slot];
  e = {1, sc, at, bytes ? bytes : 16, p.strokeCount, p.dataCount, 0, ++closeSerial, state, draws, p.cell};
  memcpy(closePool + at, p.strokes, p.strokeCount * sizeof(Stroke));
  memcpy(closePool + at + p.strokeCount * sizeof(Stroke), p.data, p.dataCount * 4);
  closeUsed += e.bytes;
  closePeak = Word(fm::max(float(closePeak), float(closeUsed)));
  return slot;
}
inline Word findClose(Word sc, int j) {
  for (Word i = 0; i < 160; i++)
    if (closeEntries[i].used && closeEntries[i].world == sc && closeEntries[i].cell == j)
      return i;
  return NONE;
}
inline const Stroke* entryStrokes(Word id) {
  return (const Stroke*)(closePool + closeEntries[id].offset);
}
inline const float* entryData(Word id) {
  auto& e = closeEntries[id];
  return (const float*)(closePool + e.offset + e.strokeCount * sizeof(Stroke));
}
static Word groupScratch = 0;
inline Word scratchCanvas(Word width, Word height) {
  if (!groupScratch || !canvases[groupScratch - 1].used)
    groupScratch = mc_create(width, height, .25f, 1, 1, 0);
  else
    mc_reset(groupScratch, width, height);
  return groupScratch;
}
inline void clearScratch() {
  if (groupScratch && canvases[groupScratch - 1].used)
    mc_reset(groupScratch, canvases[groupScratch - 1].w, canvases[groupScratch - 1].h);
}
struct NativeCanvas {
  Word h;
  float alpha = 1;
  pc::Pen pen;
};
inline bool nativeBrush(Word h, const pc::Path& path, pc::Brush b) {
  return pc::brush(h, path, b) && !error;
}
inline void ribbon(Word h, const float* xs, const float* ys, const float* ws, Word n, float u0, float u1) {
  pc::begin(h);
  for (Word side = 0; side < 2; side++)
    for (Word q = 0; q < n; q++) {
      Word i = side ? n - 1 - q : q, i0 = i ? i - 1 : 0, i1 = i + 1 < n ? i + 1 : n - 1;
      float dx = xs[i1] - xs[i0], dy = ys[i1] - ys[i0], len = fm::hypot(dx, dy);
      if (!len)
        len = 1;
      const float u = side ? u1 : u0, x = xs[i] - dy / len * ws[i] * u, y = ys[i] + dx / len * ws[i] * u;
      if (!side && !q)
        pc::move(h, x, y);
      else
        pc::line(h, x, y);
    }
  pc::close(h);
}
} // namespace painter
