#pragma once
namespace painter {
struct Layer {
  float res, y0, y1, cell, reach, blur;
};
constexpr Layer layers[4] = {{.6f, .33f, .76f, .02f, .08f, 1.5f},
                             {.82f, .25f, .97f, .045f, .2f, .5f},
                             {1, .26f, 1.02f, .13f, .42f, 0},
                             {1, -.04f, 1.04f, .8f, 2.4f, 0}};
struct TileGeometry {
  float ts;
  Word T, n, Ht, pad, margin;
};
static TileGeometry tileGeometry[4];
struct CloseRef {
  Word entry, stroke;
};
constexpr Word maxCloseRefs = 32768;
static CloseRef closeRefs[maxCloseRefs];
struct PaintJob {
  Word handle, world, layer, phase, refCount, refIndex, slot, status;
  int tile, cell, last;
  float x0, x1;
};
static PaintJob job;
static Word paintResultSlot;
inline bool validHandle(Word h) {
  return h && h <= MAX_BANKS && canvases[h - 1].used && banks[h - 1].used;
}
inline void configureGeometry() {
  const float Tc = fm::max(180, fm::floor(fm::min(config.W, 1.5f * config.H) * .38f + .5f)),
              margin = fm::floor(.04f * config.W + 24 + .5f);
  for (Word i = 0; i < 4; i++) {
    const auto L = layers[i];
    float ts = L.res * config.s;
    Word T, n;
    for (Word count = 0;; count++) {
      T = Word(fm::max(48, fm::floor(Tc * ts + .5f)));
      n = Word(fm::ceil((config.W + 2 * margin) * ts / float(T))) + 2;
      if (n * T <= config.maxTex || ts < .3f || count == 64)
        break;
      ts *= .85f;
    }
    tileGeometry[i] = {ts,
                       T,
                       n,
                       Word(fm::max(2, fm::floor((L.y1 - L.y0) * config.H * ts + .5f))),
                       L.blur ? Word(fm::ceil(3 * L.blur * (config.H / 900) * ts)) + 2 : 0,
                       Word(margin)};
  }
}
inline void releasePlanRefs() {
  for (Word i = 0; i < 160; i++)
    closeEntries[i].pins = 0;
  job.refCount = job.refIndex = 0;
}
inline bool paintFail(Word code) {
  job.status = cellStatus = code ? code : 1;
  if (!error)
    error = job.status;
  job.phase = 4;
  releasePlanRefs();
  painterObjectDepth = 0;
  return false;
}
inline bool refLess(const CloseRef& a, const CloseRef& b) {
  const Stroke& x = entryStrokes(a.entry)[a.stroke];
  const Stroke& y = entryStrokes(b.entry)[b.stroke];
  return x.z < y.z || (x.z == y.z && (x.j < y.j || (x.j == y.j && x.i < y.i)));
}
inline void siftRefs(Word at, Word n) {
  for (;;) {
    Word child = at * 2 + 1;
    if (child >= n)
      return;
    if (child + 1 < n && refLess(closeRefs[child], closeRefs[child + 1]))
      child++;
    if (!refLess(closeRefs[at], closeRefs[child]))
      return;
    const CloseRef v = closeRefs[at];
    closeRefs[at] = closeRefs[child];
    closeRefs[child] = v;
    at = child;
  }
}
inline void sortRefs() {
  const Word n = job.refCount;
  for (Word i = n / 2; i > 0; i--)
    siftRefs(i - 1, n);
  for (Word i = n; i > 1; i--) {
    const CloseRef v = closeRefs[0];
    closeRefs[0] = closeRefs[i - 1];
    closeRefs[i - 1] = v;
    siftRefs(0, i - 1);
  }
}
inline bool collectCell(int j) {
  Word id = findClose(job.world, j);
  if (id == NONE) {
    closeScratch.reset(j);
    Random r(cellSeed(job.world ? 20261009 : 20261008, 3, j));
    cellStatus = 0;
    const bool ok = job.world ? planSakura(closeScratch, j, r) : planBamboo(closeScratch, j, r);
    cellState = r.state();
    cellDraws = r.draws;
    if (!ok || error || closeScratch.status)
      return paintFail(error ? error : closeScratch.status ? closeScratch.status : cellStatus ? cellStatus : 80);
    id = cacheClose(job.world, closeScratch, cellState, cellDraws);
    if (id == NONE)
      return paintFail(cellStatus ? cellStatus : 80);
  } else {
    cellState = closeEntries[id].state;
    cellDraws = closeEntries[id].draws;
  }
  const auto* strokes = entryStrokes(id);
  bool pinned = false;
  for (Word i = 0; i < closeEntries[id].strokeCount; i++)
    if (strokes[i].x1 >= job.x0 - 2 && strokes[i].x0 <= job.x1 + 2) {
      if (job.refCount == maxCloseRefs)
        return paintFail(81);
      closeRefs[job.refCount++] = {id, i};
      pinned = true;
    }
  if (pinned)
    closeEntries[id].pins = 1;
  return true;
}
inline void finishJob() {
  job.phase = 3;
  releasePlanRefs();
  painterObjectDepth = 0;
}
} // namespace painter

extern "C" {
U pt_config(float W, float H, float kc, float hero, U stamps, U objects) {
  using namespace painter;
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  if (!finite(W) || !finite(H) || !finite(kc) || !finite(hero) || W <= 0 || H <= 0 || kc <= 0 || stamps > 255) {
    cellStatus = 73;
    return 0;
  }
  if (config.W != W || config.H != H || config.kc != kc || config.hero != hero)
    clearCloseCache();
  config.W = W;
  config.H = H;
  config.kc = kc;
  config.hero = hero;
  config.stamps = stamps;
  config.objects = objects ? 1 : 0;
  cellStatus = job.status = 0;
  error = 0;
  configureGeometry();
  return 1;
}
U pt_seed(U salt) {
  using namespace painter;
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  if (worldSalt != salt) {
    worldSalt = salt;
    noise.reseed(salt);
    clearCloseCache();
  }
  mountain::salt = salt;
  return 1;
}
U pt_anchors(float zhMid, float jaTop, float jaRight) {
  using namespace painter;
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  if (!finite(zhMid) || !finite(jaTop) || !finite(jaRight)) {
    cellStatus = 73;
    return 0;
  }
  if (config.zhMid != zhMid || config.jaTop != jaTop || config.jaRight != jaRight)
    clearCloseCache();
  config.zhMid = zhMid;
  config.jaTop = jaTop;
  config.jaRight = jaRight;
  return 1;
}
U pt_world(float s, U maxTex) {
  using namespace painter;
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  if (!finite(s) || s <= 0 || maxTex < 48) {
    cellStatus = 73;
    return 0;
  }
  config.s = s;
  config.maxTex = maxTex;
  configureGeometry();
  return 1;
}
U pt_tile_geometry(U li, float ts, U T, U Ht, U pad, U n, U margin) {
  using namespace painter;
  if (li > 3 || !finite(ts) || ts <= 0 || !T || !Ht || !n || T + 2 * pad > config.maxTex ||
      Ht + 2 * pad > config.maxTex) {
    cellStatus = 73;
    return 0;
  }
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  tileGeometry[li] = {ts, T, n, Ht, pad, margin};
  return 1;
}
float pt_geo(U li, U key) {
  using namespace painter;
  if (li > 3)
    return 0;
  const auto g = tileGeometry[li];
  switch (key) {
  case 0:
    return g.ts;
  case 1:
    return float(g.T);
  case 2:
    return float(g.Ht);
  case 3:
    return float(g.pad);
  case 4:
    return float(g.T + 2 * g.pad);
  case 5:
    return float(g.Ht + 2 * g.pad);
  case 6:
    return float(g.n);
  case 7:
    return float(g.n * g.T);
  case 8:
    return float(g.margin);
  }
  return 0;
}
U pt_result_slot(U slot) {
  if (slot > 1) {
    painter::cellStatus = 73;
    return 0;
  }
  if (painter::job.phase == 1 || painter::job.phase == 2) {
    painter::cellStatus = 74;
    return 0;
  }
  painter::paintResultSlot = slot;
  return 1;
}
U pt_begin(U handle, U sc, U li, int k) {
  using namespace painter;
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  if (!validHandle(handle) || sc > 1 || li > 3 || !(config.W > 0 && config.H > 0 && config.kc > 0)) {
    cellStatus = 73;
    return 0;
  }
  error = cellStatus = cellDraws = 0;
  objectOrdinal = 0;
  job = {};
  job.handle = handle;
  job.world = sc;
  job.layer = li;
  job.tile = k;
  job.slot = paintResultSlot;
  const auto g = tileGeometry[li];
  mc_reset(handle, g.T + 2 * g.pad, g.Ht + 2 * g.pad);
  const float m[6] = {
      g.ts, 0, 0, g.ts, float(g.pad) - float(k) * float(g.T), float(g.pad) - layers[li].y0 * config.H * g.ts};
  if (!pc::setTransform(handle, m))
    return paintFail(error ? error : 73);
  banks[handle - 1].objectWorld = sc;
  banks[handle - 1].objectLayer = li;
  close_sakura::logicalPen = {};
  job.x0 = (float(k) * float(g.T) - float(g.pad)) / g.ts;
  job.x1 = (float(k + 1) * float(g.T) + float(g.pad)) / g.ts;
  const float cw = layers[li].cell * config.H * (li == 3 ? config.kc * config.kc : 1),
              reach = layers[li].reach * config.H;
  const float j0 = fm::floor((job.x0 - reach) / cw), j1 = fm::floor((job.x1 + reach) / cw);
  if (!finite(j0) || !finite(j1) || j0 < -2147483520.f || j1 > 2147483520.f || j1 < j0 || j1 - j0 > 65536)
    return paintFail(73);
  job.cell = int(j0);
  job.last = int(j1);
  job.phase = 1;
  return 1;
}
U pt_step() {
  using namespace painter;
  if (job.phase == 3)
    return 2;
  if (!job.phase || job.phase == 4)
    return 0;
  if (error)
    return paintFail(error);
  if (job.layer == 3) {
    if (job.phase == 1) {
      if (job.cell <= job.last) {
        const int j = job.cell++;
        if (!collectCell(j))
          return 0;
        return 1;
      }
      sortRefs();
      job.phase = 2;
    }
    if (job.refIndex == job.refCount) {
      finishJob();
      return 2;
    }
    const auto ref = closeRefs[job.refIndex++];
    const Stroke stroke = entryStrokes(ref.entry)[ref.stroke];
    const float* data = entryData(ref.entry) + stroke.first;
    setObjectContext(job.world, 3, stroke.j, stroke.i);
    cellStatus = 0;
    const bool ok = job.world ? drawSakuraStroke(job.handle, stroke, data) : drawBambooStroke(job.handle, stroke, data);
    if (!ok || error || cellStatus)
      return paintFail(error ? error : cellStatus ? cellStatus : 83);
    return 1;
  }
  if (job.cell > job.last) {
    finishJob();
    return 2;
  }
  const int j = job.cell++;
  Random r(cellSeed(job.world ? 20261009 : 20261008, job.layer, j));
  setObjectContext(job.world, job.layer, j);
  cellStatus = 0;
  bool ok = true;
  if (job.world) {
    if (job.layer == 0)
      ok = sakuraFar(job.handle, j, r);
    else if (job.layer == 1)
      ok = sakuraMid(job.handle, j, r);
    else {
      sakuraNear(job.handle, j, r);
      ok = !error && !painter::geometry.status;
    }
  } else
    ok = paintBamboo(job.handle, job.layer, j, r);
  cellState = r.state();
  cellDraws = r.draws;
  if (!ok || error || cellStatus)
    return paintFail(error                      ? error
                     : cellStatus               ? cellStatus
                     : painter::geometry.status ? painter::geometry.status
                                                : 83);
  return 1;
}
void pt_abort() {
  using namespace painter;
  releasePlanRefs();
  if ((job.phase == 1 || job.phase == 2 || job.phase == 4) && validHandle(job.handle))
    mc_reset(job.handle, canvases[job.handle - 1].w, canvases[job.handle - 1].h);
  job.phase = 0;
  painterObjectDepth = 0;
}
U pt_status() {
  return painter::job.phase == 3 ? 2 : painter::job.phase == 1 || painter::job.phase == 2 ? 1 : 0;
}
U pt_error() {
  return painter::job.status ? painter::job.status : painter::cellStatus ? painter::cellStatus : error;
}
U pt_objects_count() {
  const U h = painter::job.handle;
  return painter::validHandle(h) ? banks[h - 1].objects.n : 0;
}
U pt_objects_ptr() {
  const U h = painter::job.handle;
  return painter::validHandle(h) ? banks[h - 1].objects.ptr : 0;
}
U pt_objects_stride() {
  return 32;
}
U pt_object_identity(U key) {
  const U h = painter::job.handle;
  return painter::validHandle(h) ? td_object_identity(h, key) : 0;
}
U pt_cache_clear() {
  using namespace painter;
  if (job.phase == 1 || job.phase == 2) {
    cellStatus = 74;
    return 0;
  }
  clearCloseCache();
  groupScratch = 0;
  return 1;
}
U pt_cache_info(U key) {
  using namespace painter;
  switch (key) {
  case 0: {
    U n = 0;
    for (auto& e : closeEntries)
      n += e.used != 0;
    return n;
  }
  case 1:
    return closeUsed;
  case 2:
    return closePeak;
  case 3:
    return closeEvictions;
  case 4:
    return 160;
  case 5:
    return closePoolBytes;
  case 6:
    return sizeof(Stroke);
  case 7:
    return maxCloseRefs;
  }
  return 0;
}
U pt_supports(U sc, U li) {
  return sc <= 1 && li <= 2;
}
U pt_cell(U h, U sc, U li, int j, U seed) {
  using namespace painter;
  if (!validHandle(h) || sc > 1 || li > 2 || job.phase == 1 || job.phase == 2) {
    cellStatus = 73;
    return 0;
  }
  error = cellStatus = 0;
  Random r(seed);
  setObjectContext(sc, li, j);
  bool ok = true;
  if (sc) {
    if (li == 0)
      ok = sakuraFar(h, j, r);
    else if (li == 1)
      ok = sakuraMid(h, j, r);
    else {
      sakuraNear(h, j, r);
      ok = !error && !painter::geometry.status;
    }
  } else
    ok = paintBamboo(h, li, j, r);
  cellState = r.state();
  cellDraws = r.draws;
  cellStatus = error ? error : !ok ? painter::geometry.status ? painter::geometry.status : 83 : 0;
  return cellStatus ? 0 : 1;
}
U pt_cell_state() {
  return painter::cellState;
}
U pt_cell_draws() {
  return painter::cellDraws;
}
U pt_geometry_info(U key) {
  switch (key) {
  case 0:
    return (U)painter::geometry.points;
  case 1:
    return painter::geometry.pointFloats;
  case 2:
    return (U)painter::geometry.branches;
  case 3:
    return painter::geometry.branchCount;
  case 4:
    return (U)painter::geometry.blooms;
  case 5:
    return painter::geometry.bloomCount;
  case 6:
    return painter::geometry.status;
  case 7:
    return painter::geometry.simdBatches;
  }
  return 0;
}
}
