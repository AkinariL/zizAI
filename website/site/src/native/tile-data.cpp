#include <wasm_simd128.h>
using U = unsigned int;
using D = float;
constexpr U NONE = 0xffffffffu, MAX_BANKS = 64, MAX_OPS = 32768, MAX_NODES = 8192, MAX_PAGES = 4096;
constexpr U MAX_POINTS = 65536, MAX_CONTOURS = 4096, HASH_SIZE = 32768;
constexpr U STAMP_RANGE_INVALID = 12;
extern "C" unsigned char __heap_base;
extern "C" void* memcpy(void* out, const void* in, unsigned long n) {
  auto a = (unsigned char*)out;
  auto b = (const unsigned char*)in;
  unsigned long i = 0;
  for (; i + 16 <= n; i += 16)
    wasm_v128_store(a + i, wasm_v128_load(b + i));
  for (; i < n; i++)
    a[i] = b[i];
  return out;
}
extern "C" void* memset(void* out, int v, unsigned long n) {
  auto a = (unsigned char*)out;
  for (unsigned long i = 0; i < n; i++)
    a[i] = (unsigned char)v;
  return out;
}
static U align16(U n) {
  return (n + 15) & ~15u;
}
static D min(D a, D b) {
  return a < b ? a : b;
}
static D max(D a, D b) {
  return a > b ? a : b;
}
static D abs(D a) {
  return __builtin_fabsf(a);
}
static D floor(D a) {
  return __builtin_floorf(a);
}
static D ceil(D a) {
  return __builtin_ceilf(a);
}
static bool finite(D a) {
  return __builtin_isfinite(a);
}
struct Block {
  U at, bytes;
};
static Block freeBlocks[4096];
static U freeCount, heapTop;
static U allocations, reuses, growths, released, highWater, error, fanBatches, fanFloats;
static U tileWorkBank, tileBankSwaps;
static U heapLimit = 33554432u;

static U take(U bytes) {
  bytes = align16(bytes);
  if (!bytes)
    return 0;
  U best = NONE;
  for (U i = 0; i < freeCount; i++)
    if (freeBlocks[i].bytes >= bytes && (best == NONE || freeBlocks[i].bytes < freeBlocks[best].bytes))
      best = i;
  if (best != NONE) {
    U p = freeBlocks[best].at;
    freeBlocks[best].at += bytes;
    freeBlocks[best].bytes -= bytes;
    if (!freeBlocks[best].bytes)
      freeBlocks[best] = freeBlocks[--freeCount];
    reuses++;
    return p;
  }
  if (!heapTop)
    heapTop = align16((U)&__heap_base);
  U end = heapTop + bytes, cap = __builtin_wasm_memory_size(0) * 65536;
  if (end < heapTop || end > heapLimit) {
    error = 1;
    return 0;
  }
  if (end > cap) {
    U target = end > cap + 4194304u ? end : cap + 4194304u;
    if (target > heapLimit)
      target = end;
    U pages = (target - cap + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, pages) == (unsigned long)-1) {
      error = 1;
      return 0;
    }
    growths++;
  }
  U at = heapTop;
  heapTop = end;
  highWater = max(highWater, heapTop);
  allocations++;
  return at;
}
static void give(U at, U bytes) {
  if (!at || !bytes)
    return;
  bytes = align16(bytes);
  released++;
  for (U i = 0; i < freeCount;) {
    auto b = freeBlocks[i];
    if (b.at + b.bytes == at || at + bytes == b.at) {
      at = at < b.at ? at : b.at;
      bytes += b.bytes;
      freeBlocks[i] = freeBlocks[--freeCount];
      i = 0;
    } else
      i++;
  }
  if (at + bytes == heapTop) {
    heapTop = at;
    return;
  }
  if (freeCount < 4096)
    freeBlocks[freeCount++] = {at, bytes};
}
struct Array {
  U ptr, n, cap, stride;
};
static bool reserve(Array& a, U n) {
  if (n <= a.cap)
    return true;
  U cap = max(n, max(16, a.cap * 2)), ptr = take(cap * a.stride);
  if (!ptr)
    return false;
  if (a.n)
    memcpy((void*)ptr, (void*)a.ptr, a.n * a.stride);
  give(a.ptr, a.cap * a.stride);
  a.ptr = ptr;
  a.cap = cap;
  return true;
}
struct Raw {
  U kind, first, count, paint, flags, segmentFirst, segmentCount, end;
  D v[9];
};
struct Bank {
  Array cmd, vertices, paints, segments, transforms, stamps, objects;
  U generated, stampMergeFloor, used, objectWorld, objectLayer;
};
static Bank banks[MAX_BANKS];
static float material[64], transform[8];
static D numbers[9], points[MAX_POINTS * 2];
static U contours[MAX_CONTOURS * 4];
static U paintHash[HASH_SIZE], matrixHash[HASH_SIZE];
static U hashBank = NONE;
static U hash(const float* p, U n) {
  U h = 2166136261u;
  auto u = (const U*)p;
  for (U i = 0; i < n; i++)
    h = (h ^ (p[i] == 0 ? 0 : u[i])) * 16777619u;
  return h;
}
static bool equal(const float* a, const float* b, U n) {
  for (U i = 0; i < n; i++)
    if (a[i] != b[i])
      return false;
  return true;
}
static void rebuildHash(U id) {
  hashBank = id;
  memset(paintHash, 0, sizeof paintHash);
  memset(matrixHash, 0, sizeof matrixHash);
  auto& b = banks[id];
  for (U i = 0; i < b.paints.n; i++) {
    auto p = (float*)b.paints.ptr + i * 64;
    U h = hash(p, 64) % HASH_SIZE;
    while (paintHash[h])
      h = (h + 1) % HASH_SIZE;
    paintHash[h] = i + 1;
  }
  for (U i = 0; i < b.transforms.n; i++) {
    auto p = (float*)b.transforms.ptr + i * 8;
    U h = hash(p, 8) % HASH_SIZE;
    while (matrixHash[h])
      h = (h + 1) % HASH_SIZE;
    matrixHash[h] = i + 1;
  }
}
static U intern(U id, const float* p, bool matrix) {
  auto& b = banks[id];
  if (hashBank != id)
    rebuildHash(id);
  auto& a = matrix ? b.transforms : b.paints;
  auto table = matrix ? matrixHash : paintHash;
  U stride = matrix ? 8 : 64, h = hash(p, stride) % HASH_SIZE;
  for (U attempt = 0; attempt < HASH_SIZE; attempt++, h = (h + 1) % HASH_SIZE) {
    U i = table[h];
    if (!i) {
      if (a.n >= HASH_SIZE / 2 || !reserve(a, a.n + 1)) {
        error = 2;
        return NONE;
      }
      memcpy((float*)a.ptr + a.n * stride, p, stride * 4);
      table[h] = ++a.n;
      return a.n - 1;
    }
    if (equal((float*)a.ptr + (i - 1) * stride, p, stride))
      return i - 1;
  }
  error = 2;
  return NONE;
}
static Raw* add(U id, U kind, U count, U flags) {
  auto& b = banks[id];
  if (!reserve(b.cmd, b.cmd.n + 1))
    return nullptr;
  U p = intern(id, material, false);
  if (p == NONE)
    return nullptr;
  auto c = (Raw*)b.cmd.ptr + b.cmd.n++;
  memset(c, 0, sizeof *c);
  c->kind = kind;
  c->count = count;
  c->flags = flags;
  c->paint = p;
  memcpy(c->v, numbers, sizeof numbers);
  return c;
}
extern "C" {
U td_scratch(U kind) {
  return kind == 0   ? (U)material
         : kind == 1 ? (U)numbers
         : kind == 2 ? (U)transform
         : kind == 3 ? (U)points
                     : (U)contours;
}
U td_bank() {
  for (U i = 0; i < MAX_BANKS; i++)
    if (!banks[i].used) {
      auto& b = banks[i];
      b = {};
      b.used = 1;
      b.cmd.stride = sizeof(Raw);
      b.vertices.stride = 4;
      b.paints.stride = 256;
      b.segments.stride = 64;
      b.transforms.stride = 32;
      b.stamps.stride = 128;
      b.objects.stride = 32;
      return i + 1;
    }
  error = 3;
  return 0;
}
U td_reserve(U handle, U commands, U floats, U segments, U paints, U matrices, U stamps) {
  auto& b = banks[handle - 1];
  return reserve(b.cmd, commands) && reserve(b.vertices, floats) && reserve(b.segments, segments) &&
         reserve(b.paints, paints) && reserve(b.transforms, matrices) && reserve(b.stamps, stamps);
}
void td_clear(U handle) {
  auto& b = banks[handle - 1];
  b.cmd.n = b.vertices.n = b.paints.n = b.segments.n = b.transforms.n = b.stamps.n = b.objects.n = b.generated =
      b.stampMergeFloor = 0;
  if (hashBank == handle - 1)
    hashBank = NONE;
}
void td_reset() {
  for (auto& b : banks)
    if (b.used) {
      Array arrays[7] = {b.cmd, b.vertices, b.paints, b.segments, b.transforms, b.stamps, b.objects};
      for (auto a : arrays)
        give(a.ptr, a.cap * a.stride);
      b = {};
    }
  hashBank = NONE;
}
U td_info(U handle, U key) {
  auto& b = banks[handle - 1];
  auto a = key < 4                 ? b.cmd
           : key < 8               ? b.vertices
           : key < 12              ? b.paints
           : key < 16              ? b.segments
           : key >= 24 && key < 28 ? b.stamps
           : key >= 28 && key < 32 ? b.objects
                                   : b.transforms;
  return key == 20 ? b.generated : (key % 4 == 0 ? a.ptr : key % 4 == 1 ? a.n : key % 4 == 2 ? a.cap : a.stride);
}
U td_vertex_space(U handle, U n) {
  auto& b = banks[handle - 1];
  return reserve(b.vertices, b.vertices.n + n) ? b.vertices.ptr + b.vertices.n * 4 : 0;
}
U td_path(U handle, U kind, U floats, U count, U flags) {
  auto& b = banks[handle - 1];
  if (b.vertices.n + floats > b.vertices.cap)
    return 0;
  Raw* c = add(handle - 1, kind, count, flags);
  if (!c)
    return 0;
  c->first = b.vertices.n / 2;
  b.vertices.n += floats;
  return 1;
}
U td_fans(U handle, U contourCount, U forcePositive) {
  auto& b = banks[handle - 1];
  U triangles = 0;
  for (U i = 0; i < contourCount; i++)
    triangles += contours[i * 4 + 1] > 2 ? contours[i * 4 + 1] - 2 : 0;
  if (!reserve(b.vertices, b.vertices.n + triangles * 6))
    return 0;
  float* out = (float*)b.vertices.ptr + b.vertices.n;
  U first = b.vertices.n;
  for (U ci = 0; ci < contourCount; ci++) {
    U k = ci * 4, n = contours[k + 1];
    float* p = points + contours[k];
    if (n < 3)
      continue;
    float area = 0;
    if (forcePositive)
      for (U i = 0, j = n - 1; i < n; j = i++)
        area += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
    bool reverse = forcePositive && area < 0;
    auto a = wasm_f32x4_make(p[0], p[1], p[0], p[1]);
    for (U i = 1; i < n - 1; i += 2) {
      U bi = reverse ? n - i : i, cj = reverse ? bi - 1 : i + 1;
      bool two = i + 1 < n - 1;
      U bj = two ? (reverse ? n - i - 1 : i + 1) : bi, ck = two ? (reverse ? bj - 1 : i + 2) : cj;
      auto bv = wasm_f32x4_make(p[bi * 2], p[bi * 2 + 1], p[bj * 2], p[bj * 2 + 1]);
      auto cv = wasm_f32x4_make(p[cj * 2], p[cj * 2 + 1], p[ck * 2], p[ck * 2 + 1]);
      auto ab = wasm_f32x4_sub(bv, a), ac = wasm_f32x4_sub(cv, a);
      auto product = wasm_f32x4_mul(ab, wasm_i32x4_shuffle(ac, ac, 1, 0, 3, 2));
      float cross = wasm_f32x4_extract_lane(product, 0) - wasm_f32x4_extract_lane(product, 1);
      if (abs(cross) >= 1e-12f) {
        wasm_v128_store64_lane(out, a, 0);
        wasm_v128_store64_lane(out + 2, bv, 0);
        wasm_v128_store64_lane(out + 4, cv, 0);
        out += 6;
        b.vertices.n += 6;
      }
      if (two) {
        cross = wasm_f32x4_extract_lane(product, 2) - wasm_f32x4_extract_lane(product, 3);
        if (abs(cross) >= 1e-12f) {
          wasm_v128_store64_lane(out, a, 0);
          wasm_v128_store64_lane(out + 2, bv, 1);
          wasm_v128_store64_lane(out + 4, cv, 1);
          out += 6;
          b.vertices.n += 6;
        }
      }
    }
  }
  U emitted = b.vertices.n - first;
  b.vertices.n = first;
  fanBatches++;
  fanFloats += emitted;
  return emitted;
}
U td_segment(U handle, U steps) {
  auto& b = banks[handle - 1];
  if (!reserve(b.segments, b.segments.n + 1))
    return 0;
  U m = intern(handle - 1, transform, true);
  if (m == NONE)
    return 0;
  auto p = (float*)b.segments.ptr + b.segments.n * 16;
  memcpy(p, material, 64);
  p[2] = b.generated;
  p[3] = m;
  b.generated += steps * 3;
  b.segments.n++;
  return 1;
}
U td_parametric(U handle, U firstSegment, U count) {
  auto& b = banks[handle - 1];
  if (firstSegment >= b.segments.n)
    return 0;
  Raw* c = add(handle - 1, 4, count, 0);
  if (!c)
    return 0;
  c->first = b.generated - count;
  c->segmentFirst = firstSegment;
  c->segmentCount = b.segments.n - firstSegment;
  return 1;
}
U td_object_identity(U handle, U key) {
  return key ? banks[handle - 1].objectLayer : banks[handle - 1].objectWorld;
}
U td_group(U handle, U source) {
  U id = handle - 1, sid = source - 1;
  if (id == sid) {
    error = 4;
    return 0;
  }
  auto& b = banks[id];
  auto& s = banks[sid];
  if (!s.cmd.n)
    return 1;
  U at = b.cmd.n, vertex = b.vertices.n, segment = b.segments.n, generated = b.generated, stamp = b.stamps.n,
    object = b.objects.n;
  if (!reserve(b.cmd, at + s.cmd.n + 1) || !reserve(b.vertices, vertex + s.vertices.n) ||
      !reserve(b.segments, segment + s.segments.n) || !reserve(b.stamps, stamp + s.stamps.n) ||
      !reserve(b.objects, object + s.objects.n))
    return 0;
  auto g = (Raw*)b.cmd.ptr + at;
  memset(g, 0, sizeof *g);
  g->kind = 3;
  g->end = at + s.cmd.n + 1;
  memcpy(g->v, numbers, sizeof numbers);
  b.cmd.n = g->end;
  memcpy((float*)b.vertices.ptr + vertex, (void*)s.vertices.ptr, s.vertices.n * 4);
  b.vertices.n += s.vertices.n;
  memcpy((float*)b.stamps.ptr + stamp * 32, (void*)s.stamps.ptr, s.stamps.n * 128);
  b.stamps.n += s.stamps.n;
  memcpy((float*)b.objects.ptr + object * 8, (void*)s.objects.ptr, s.objects.n * 32);
  b.objects.n += s.objects.n;
  for (U j = 0; j < s.objects.n; j++) {
    auto f = (float*)b.objects.ptr + (object + j) * 8;
    auto u = (U*)f;
    u[6] += stamp;
    f[5] *= numbers[8];
  }
  for (U j = 0; j < s.stamps.n; j++)
    ((float*)b.stamps.ptr)[(stamp + j) * 32 + 1] = 0;
  for (U j = 0; j < s.segments.n; j++) {
    auto p = (float*)s.segments.ptr + j * 16;
    U m = intern(id, (float*)s.transforms.ptr + (U)p[3] * 8, true);
    if (m == NONE)
      return 0;
    auto d = (float*)b.segments.ptr + (segment + j) * 16;
    memcpy(d, p, 64);
    d[2] += generated;
    d[3] = m;
  }
  b.segments.n += s.segments.n;
  b.generated += s.generated;
  for (U j = 0; j < s.cmd.n; j++) {
    auto c = (Raw*)s.cmd.ptr + j;
    auto d = (Raw*)b.cmd.ptr + at + 1 + j;
    *d = *c;
    if (c->kind == 3)
      d->end += at + 1;
    else if (c->kind == 5)
      d->first += stamp;
    else {
      U p = intern(id, (float*)s.paints.ptr + c->paint * 64, false);
      if (p == NONE)
        return 0;
      d->paint = p;
      d->first += c->kind == 4 ? generated : vertex / 2;
      d->segmentFirst += segment;
    }
  }
  b.stampMergeFloor = b.cmd.n;
  return 1;
}
}

struct Node {
  U parent, command, depth, page, x, y, firstOp, opCount, firstLevel, nextLevel;
  D bounds[4], crop[4];
};
struct Page {
  U width, height, x, y, row, firstNode, lastNode, count, depth;
};
static Node nodes[MAX_NODES];
static Page pages[MAX_PAGES];
static U nextPage[MAX_PAGES], nodeNext[MAX_NODES], levelFirst[33], levelLast[33], levelWidth[33];
static D levelArea[33];
#include "tile-plan-storage.hpp"
static U gpuOps[MAX_OPS], opRaw[MAX_OPS];
static U opNext[MAX_OPS], nodeLastOp[MAX_NODES], stackNode[33], stackEnd[33], depth, rawIndex;
static U opCount, nodeCount, pageCount, gpuCount, stageCount, stageNodeCount, workPhase, workIndex, bankId, width,
    height, limitTex, gpuEnabled, convexEnabled, iterations, generatedCount, ownedSegments, batchIndex, geometryIndex;
static U packDepth, packNode, packPage, levelPage[33], levelPageLast[33];
static U stats[24];
static bool valid(const D* b) {
  return b[2] > b[0] && b[3] > b[1];
}
static void empty(D* b) {
  b[0] = b[1] = __builtin_inff();
  b[2] = b[3] = -__builtin_inff();
}
static void unite(D* a, const D* b) {
  if (!valid(b))
    return;
  a[0] = min(a[0], b[0]);
  a[1] = min(a[1], b[1]);
  a[2] = max(a[2], b[2]);
  a[3] = max(a[3], b[3]);
}
static void map(D* out, const D* b, const Raw& c) {
  D sx = c.v[6] / c.v[2], sy = c.v[7] / c.v[3];
  out[0] = c.v[4] + (b[0] - c.v[0]) * sx;
  out[1] = c.v[5] + (b[1] - c.v[1]) * sy;
  out[2] = c.v[4] + (b[2] - c.v[0]) * sx;
  out[3] = c.v[5] + (b[3] - c.v[1]) * sy;
}
static U newPage(U d) {
  if (pageCount >= MAX_PAGES) {
    error = 5;
    return NONE;
  }
  U p = pageCount++;
  pages[p] = {};
  pages[p].width = levelWidth[d];
  pages[p].firstNode = pages[p].lastNode = NONE;
  pages[p].depth = d;
  nextPage[p] = NONE;
  if (levelPageLast[d] != NONE)
    nextPage[levelPageLast[d]] = p;
  else
    levelPage[d] = p;
  levelPageLast[d] = p;
  return p;
}
static void finishNode(U id) {
  auto& n = nodes[id];
  auto c = (Raw*)banks[bankId].cmd.ptr + n.command;
  if (valid(n.bounds)) {
    n.crop[0] = max(c->v[0], floor(n.bounds[0] - 1));
    n.crop[1] = max(c->v[1], floor(n.bounds[1] - 1));
    n.crop[2] = min(c->v[0] + c->v[2], ceil(n.bounds[2] + 1));
    n.crop[3] = min(c->v[1] + c->v[3], ceil(n.bounds[3] + 1));
  } else
    memset(n.crop, 0, sizeof n.crop);
  if (valid(n.crop)) {
    D b[4];
    map(b, n.crop, *c);
    unite(nodes[n.parent].bounds, b);
    U d = n.depth;
    nodeNext[id] = NONE;
    if (levelLast[d] != NONE)
      nodeNext[levelLast[d]] = id;
    else
      levelFirst[d] = id;
    levelLast[d] = id;
    U w = ceil(n.crop[2] - n.crop[0]) + 2, h = ceil(n.crop[3] - n.crop[1]) + 2;
    levelWidth[d] = max(levelWidth[d], w);
    levelArea[d] += w * h;
  }
}
static void walk() {
  auto& b = banks[bankId];
  if (depth && rawIndex == stackEnd[depth]) {
    finishNode(stackNode[depth]);
    depth--;
    return;
  }
  if (rawIndex == b.cmd.n) {
    workPhase = 2;
    packDepth = 32;
    packNode = NONE;
    packPage = NONE;
    return;
  }
  Raw& c = ((Raw*)b.cmd.ptr)[rawIndex];
  U raw = rawIndex++, parent = stackNode[depth];
  if (c.kind == 5 && (c.first > b.stamps.n || c.count > b.stamps.n - c.first)) {
    error = STAMP_RANGE_INVALID;
    return;
  }
  if (c.kind != 3 && (!c.count || !valid(c.v)))
    return;
  if (c.kind == 3 && c.v[8] == 0) {
    rawIndex = c.end;
    return;
  }
  if (opCount >= MAX_OPS) {
    error = 6;
    return;
  }
  U oi = opCount++, k = oi * 12;
  memset(opData + k, 0, 48);
  opData[k] = c.kind == 4 ? 1 : c.kind;
  opData[k + 1] = (c.flags ? 2 : 0) | (c.kind == 4 ? 4 : 0);
  opData[k + 2] = c.first + (c.kind == 4 ? b.vertices.n / 2 : 0);
  opData[k + 3] = c.count;
  opData[k + 4] = parent;
  opData[k + 5] = NONE;
  opData[k + 6] = NONE;
  opData[k + 7] = 1;
  opData[k + 8] = c.kind == 1 || c.kind == 4 ? c.count : 6;
  opData[k + 9] = nodes[parent].opCount++;
  opData[k + 10] = c.paint;
  opData[k + 11] = generatedCount;
  opRaw[oi] = raw;
  opNext[oi] = NONE;
  if (nodeLastOp[parent] != NONE)
    opNext[nodeLastOp[parent]] = oi;
  else
    nodes[parent].firstOp = oi;
  nodeLastOp[parent] = oi;
  if (gpuEnabled && c.kind != 1 && c.kind != 5) {
    opData[k + 6] = gpuCount;
    gpuOps[gpuCount++] = oi;
  }
  if (c.kind == 3) {
    if (depth >= 32 || nodeCount >= MAX_NODES) {
      error = 7;
      return;
    }
    U ni = nodeCount++;
    nodes[ni] = {};
    auto& n = nodes[ni];
    n.parent = parent;
    n.command = raw;
    n.depth = depth + 1;
    n.page = NONE;
    n.firstOp = NONE;
    empty(n.bounds);
    nodeLastOp[ni] = NONE;
    opData[k + 5] = ni;
    stats[4]++;
    stackNode[++depth] = ni;
    stackEnd[depth] = c.end;
    return;
  }
  unite(nodes[parent].bounds, c.v);
  if (c.kind == 5) {
    stats[14]++;
    stats[15] += c.count;
    return;
  }
  stats[0]++;
  if (c.kind == 2) {
    stats[2]++;
    stats[3] += c.count;
    stats[8] += 2;
  } else {
    stats[8] += c.count / 3;
    if (c.flags)
      stats[1]++;
    if (c.kind == 4) {
      generatedCount += c.count;
      stats[7]++;
    } else {
      stats[5]++;
      stats[6] += c.count;
    }
  }
}
static void pack() {
  while (packDepth > 0 && levelFirst[packDepth] == NONE)
    packDepth--;
  if (!packDepth) {
    if (pageCount >= MAX_PAGES) {
      error = 5;
      return;
    }
    U p = pageCount++;
    pages[p] = {};
    pages[p].width = width;
    pages[p].height = height;
    pages[p].firstNode = pages[p].lastNode = 0;
    pages[p].count = 1;
    nodes[0].page = p;
    stageData[stageCount * 6] = width;
    stageData[stageCount * 6 + 1] = height;
    stageData[stageCount * 6 + 2] = stageNodeCount;
    stageData[stageCount * 6 + 3] = 1;
    stageData[stageCount * 6 + 4] = 1;
    stageData[stageCount * 6 + 5] = 0;
    stageNodes[stageNodeCount++] = 0;
    stageCount++;
    workPhase = 3;
    workIndex = 0;
    U at = 0;
    for (U i = 0; i < nodeCount; i++) {
      U k = i * 8;
      nodeData[k] = nodes[i].page;
      nodeData[k + 1] = nodes[i].x;
      nodeData[k + 2] = nodes[i].y;
      nodeData[k + 3] = valid(nodes[i].crop) ? ceil(nodes[i].crop[2] - nodes[i].crop[0]) : 0;
      nodeData[k + 4] = valid(nodes[i].crop) ? ceil(nodes[i].crop[3] - nodes[i].crop[1]) : 0;
      nodeData[k + 5] = at;
      nodeData[k + 6] = nodes[i].opCount;
      nodeData[k + 7] = nodes[i].depth;
      memcpy(nodeGeo + i * 8, nodes[i].bounds, 16);
      memcpy(nodeGeo + i * 8 + 4, nodes[i].crop, 16);
      for (U o = nodes[i].firstOp; o != NONE; o = opNext[o])
        nodeOps[at++] = o;
    }
    for (U s = 0; s < stageCount; s++)
      for (U j = 0; j < stageData[s * 6 + 3]; j++)
        nodeData[stageNodes[stageData[s * 6 + 2] + j] * 8] = s;
    return;
  }
  U d = packDepth;
  if (packNode == NONE && packPage == NONE)
    packNode = levelFirst[d];
  if (packNode != NONE) {
    U id = packNode;
    packNode = nodeNext[id];
    auto& n = nodes[id];
    U w = ceil(n.crop[2] - n.crop[0]) + 2, h = ceil(n.crop[3] - n.crop[1]) + 2;
    if (w > limitTex || h > limitTex) {
      error = 8;
      return;
    }
    if (levelPage[d] == NONE) {
      U pow = 1;
      D target = __builtin_sqrtf(max(1, levelArea[d]));
      while (pow < target)
        pow *= 2;
      levelWidth[d] = min(limitTex, max(levelWidth[d], min(2048, pow)));
      newPage(d);
    }
    U p = levelPageLast[d];
    if (error)
      return;
    if (pages[p].x + w > pages[p].width) {
      pages[p].x = 0;
      pages[p].y += pages[p].row;
      pages[p].row = 0;
    }
    if (pages[p].y + h > limitTex) {
      p = newPage(d);
      if (error)
        return;
    }
    auto& pg = pages[p];
    n.page = p;
    n.x = pg.x + 1;
    n.y = pg.y + 1;
    nodeNext[id] = NONE;
    if (pg.lastNode != NONE)
      nodeNext[pg.lastNode] = id;
    else
      pg.firstNode = id;
    pg.lastNode = id;
    pg.count++;
    pg.x += w;
    pg.row = max(pg.row, h);
    if (packNode == NONE)
      packPage = levelPage[d];
    return;
  }
  if (packPage != NONE) {
    U p = packPage;
    auto& pg = pages[p];
    pg.height = max(1, pg.y + pg.row);
    U k = stageCount * 6;
    stageData[k] = pg.width;
    stageData[k + 1] = pg.height;
    stageData[k + 2] = stageNodeCount;
    stageData[k + 3] = pg.count;
    stageData[k + 4] = 0;
    stageData[k + 5] = d;
    for (U n = pg.firstNode; n != NONE; n = nodeNext[n])
      stageNodes[stageNodeCount++] = n;
    stageCount++;
    stats[11]++;
    stats[12] += pg.width * pg.height;
    packPage = nextPage[p];
    if (packPage == NONE) {
      packDepth--;
      packNode = NONE;
    }
    return;
  }
}
static void record() {
  if (workIndex == opCount) {
    workPhase = 4;
    batchIndex = 0;
    geometryIndex = 0;
    return;
  }
  U oi = workIndex++, k = oi * 12;
  Raw& c = ((Raw*)banks[bankId].cmd.ptr)[opRaw[oi]];
  auto& n = nodes[opData[k + 4]];
  U gi = opData[k + 6];
  if (c.kind == 5) {
    auto stamps = (float*)banks[bankId].stamps.ptr;
    for (U j = 0; j < c.count; j++)
      stamps[(c.first + j) * 32 + 1] = (D)oi;
  }
  if (gi != NONE) {
    U q = gi * 8;
    prepares[q] = c.kind == 4 ? 4 : c.kind;
    prepares[q + 1] = opData[k + 2];
    prepares[q + 2] = c.count;
    prepares[q + 3] = opData[k + 11];
    prepares[q + 4] = oi;
    prepares[q + 5] = 0;
    prepares[q + 6] = 1;
    prepares[q + 7] = c.kind == 4 || c.kind == 1 ? c.count : 6;
  }
  float* r = records + oi * 16;
  memset(r, 0, 64);
  opWork[oi * 2] = opWork[oi * 2 + 1] = 0;
  if (n.page == NONE) {
    opData[k + 1] |= 1;
    return;
  }
  D b[4], uv[4] = {}, alpha = 1;
  U paint = 0;
  if (c.kind == 3) {
    auto& ch = nodes[opData[k + 5]];
    if (ch.page == NONE || !valid(ch.crop)) {
      opData[k + 1] |= 1;
      return;
    }
    map(b, ch.crop, c);
    auto& p = pages[ch.page];
    uv[0] = (D)ch.x / p.width;
    uv[1] = (D)ch.y / p.height;
    uv[2] = (ch.crop[2] - ch.crop[0]) / p.width;
    uv[3] = (ch.crop[3] - ch.crop[1]) / p.height;
    alpha = c.v[8];
  } else {
    b[0] = max(n.crop[0], floor(c.v[0] - 1));
    b[1] = max(n.crop[1], floor(c.v[1] - 1));
    b[2] = min(n.crop[2], ceil(c.v[2] + 1));
    b[3] = min(n.crop[3], ceil(c.v[3] + 1));
    paint = c.paint;
  }
  if (!valid(b)) {
    opData[k + 1] |= 1;
    return;
  }
  auto& p = pages[n.page];
  r[0] = b[0];
  r[1] = b[1];
  r[2] = b[2] - b[0];
  r[3] = b[3] - b[1];
  r[4] = p.width;
  r[5] = p.height;
  r[6] = (D)n.x - n.crop[0];
  r[7] = (D)n.y - n.crop[1];
  for (U j = 0; j < 4; j++)
    r[8 + j] = uv[j];
  r[12] = paint;
  r[13] = c.kind == 3 ? alpha : c.kind == 2 ? c.v[4] : 1;
  r[14] = c.kind == 3 ? 0 : opData[k + 2];
  r[15] = c.kind == 3 ? 0 : c.count;
  const D* wb = c.kind == 3 ? b : c.v;
  D area = max(0, wb[2] - wb[0]) * max(0, wb[3] - wb[1]);
  opWork[oi * 2] =
      c.kind == 5 ? c.v[4] : (c.kind == 1 || c.kind == 4 ? c.count : 6) + area * .05f * (c.kind == 2 ? c.count : 1);
  opWork[oi * 2 + 1] = opWork[oi * 2];
  stats[13]++;
}
static bool disjoint(U a, U b) {
  float* x = records + a * 16;
  float* y = records + b * 16;
  return (D)x[0] + x[2] <= y[0] || (D)y[0] + y[2] <= x[0] || (D)x[1] + x[3] <= y[1] || (D)y[1] + y[3] <= x[1];
}
static void batch() {
  if (batchIndex == gpuCount) {
    workPhase = 5;
    return;
  }
  U oi = gpuOps[batchIndex++], k = oi * 12;
  if (opData[k + 1] & 9 || opData[k] == 3 || opData[k] == 5)
    return;
  U members = 1, vertices = opData[k] == 1 ? opData[k + 3] : 6;
  D work = opWork[oi * 2];
  U node = opData[k + 4], at = nodeData[node * 8 + 5] + opData[k + 9], remain = nodeData[node * 8 + 6] - opData[k + 9];
  while (members < 32 && members < remain) {
    U next = nodeOps[at + members], q = next * 12;
    if ((opData[q + 1] & 9) || opData[q] != opData[k] || next != oi + members ||
        opData[q + 6] != opData[k + 6] + members)
      break;
    if (opData[k] == 1 && ((opData[q + 1] & 2) != (opData[k + 1] & 2) || opData[q + 11] != opData[k + 11] + vertices))
      break;
    if (work + opWork[next * 2] > 4000)
      break;
    bool overlap = false;
    if (opData[k] == 1 && !(opData[k + 1] & 2))
      for (U j = 0; j < members; j++)
        if (!disjoint(nodeOps[at + j], next)) {
          overlap = true;
          break;
        }
    if (overlap)
      break;
    opData[q + 1] |= 8;
    vertices += opData[k] == 1 ? opData[q + 3] : 6;
    work += opWork[next * 2];
    members++;
  }
  opData[k + 7] = members;
  opData[k + 8] = vertices;
  opWork[oi * 2 + 1] = work;
  U q = opData[k + 6] * 8;
  prepares[q + 6] = members;
  prepares[q + 7] = vertices;
  if (members > 1) {
    stats[9]++;
    stats[10] += members;
  }
}
static void geometry() {
  auto& b = banks[bankId];
  if (geometryIndex == b.segments.n) {
    if (generatedCount != b.generated) {
      error = 9;
      return;
    }
    workPhase = 6;
    return;
  }
  U si = geometryIndex++, owner = NONE;
  while (workIndex < opCount) {
    U oi = workIndex, k = oi * 12;
    Raw& c = ((Raw*)b.cmd.ptr)[opRaw[oi]];
    if (c.kind == 4 && si >= c.segmentFirst && si < c.segmentFirst + c.segmentCount) {
      owner = opData[k + 6];
      break;
    }
    workIndex++;
  }
  if (owner == NONE) {
    error = 10;
    return;
  }
  tasks[si] = owner;
  auto in = (float*)b.segments.ptr + si * 16;
  auto out = plannedSegments + si * 16;
  memcpy(out, in, 64);
  out[2] += b.vertices.n / 2;
  ownedSegments++;
}
extern "C" {
U td_plan_begin(U handle, U w, U h, U maxTex, U gpu, U convex) {
  bankId = handle - 1;
  auto& b = banks[bankId];
  if (b.cmd.n > MAX_OPS || b.segments.n > MAX_OPS || w > maxTex || h > maxTex) {
    error = 11;
    return 0;
  }
  error = 0;
  if (!planOutputReserve(handle))
    return 0;
  width = w;
  height = h;
  limitTex = maxTex;
  gpuEnabled = gpu;
  convexEnabled = convex;
  opCount = gpuCount = pageCount = stageCount = stageNodeCount = generatedCount = ownedSegments = iterations = 0;
  nodeCount = 1;
  workPhase = 1;
  workIndex = rawIndex = depth = 0;
  memset(stats, 0, sizeof stats);
  memset(levelArea, 0, sizeof levelArea);
  memset(levelWidth, 0, sizeof levelWidth);
  for (U i = 0; i < 33; i++)
    levelFirst[i] = levelLast[i] = levelPage[i] = levelPageLast[i] = NONE;
  nodes[0] = {};
  nodes[0].page = NONE;
  nodes[0].firstOp = NONE;
  nodes[0].bounds[0] = nodes[0].crop[0] = 0;
  nodes[0].bounds[1] = nodes[0].crop[1] = 0;
  nodes[0].bounds[2] = nodes[0].crop[2] = w;
  nodes[0].bounds[3] = nodes[0].crop[3] = h;
  nodeLastOp[0] = NONE;
  stackNode[0] = 0;
  stackEnd[0] = b.cmd.n;
  memset(tasks, 255, ((b.segments.n + 3) & ~3u) * 4);
  return 1;
}
U td_plan_step(U count) {
  for (U j = 0; j < count && workPhase != 6 && !error; j++) {
    iterations++;
    if (workPhase == 1)
      walk();
    else if (workPhase == 2)
      pack();
    else if (workPhase == 3)
      record();
    else if (workPhase == 4) {
      batch();
      if (workPhase == 5)
        workIndex = 0;
    } else if (workPhase == 5)
      geometry();
  }
  return error ? 0 : workPhase == 6 ? 2 : 1;
}
U td_plan_info(U key) {
  switch (key) {
  case 0:
    return workPhase;
  case 1:
    return opCount;
  case 2:
    return nodeCount;
  case 3:
    return gpuCount;
  case 4:
    return stageCount;
  case 5:
    return stageNodeCount;
  case 6:
    return generatedCount;
  case 7:
    return iterations;
  case 8:
    return (U)stats;
  case 9:
    return error;
  case 10:
    return (U)opData;
  case 11:
    return (U)opWork;
  case 12:
    return (U)nodeData;
  case 13:
    return (U)nodeOps;
  case 14:
    return (U)stageData;
  case 15:
    return (U)stageNodes;
  case 16:
    return (U)gpuOps;
  case 17:
    return (U)records;
  case 18:
    return (U)prepares;
  case 19:
    return (U)tasks;
  case 20:
    return (U)nodeGeo;
  case 21:
    return (U)plannedSegments;
  }
  return 0;
}
U td_counter(U key) {
  switch (key) {
  case 0:
    return allocations;
  case 1:
    return reuses;
  case 2:
    return growths;
  case 3:
    return released;
  case 4:
    return highWater;
  case 5:
    return error;
  case 6:
    return fanBatches;
  case 7:
    return fanFloats;
  case 8:
    return tileBankSwaps;
  }
  return 0;
}
U td_limit(U bytes) {
  if (bytes < __builtin_wasm_memory_size(0) * 65536 || bytes > 67108864u)
    return 0;
  heapLimit = bytes;
  return 1;
}
U td_max_memory() {
  return heapLimit;
}
U td_summary(U handle) {
  static U out[16];
  memset(out, 0, sizeof out);
  U ends[33], depth = 0;
  auto& b = banks[handle - 1];
  for (U i = 0; i < b.cmd.n; i++) {
    while (depth && i == ends[depth])
      depth--;
    auto& c = ((Raw*)b.cmd.ptr)[i];
    if (c.kind == 3) {
      out[1]++;
      if (depth < 32) {
        ends[++depth] = c.end;
        out[2] = depth > out[2] ? depth : out[2];
      }
    } else if (c.kind == 5) {
      out[9]++;
      out[10] += c.count;
    } else {
      out[0]++;
      if (c.kind == 4)
        out[3]++;
      else if (c.kind == 2) {
        out[4]++;
        out[5] += c.count;
      } else {
        out[6] += c.count / 3;
        if (c.flags) {
          out[7]++;
          out[8] += c.count / 3;
        }
      }
    }
  }
  return (U)out;
}
}
#include "mesh-core.hpp"
#include "brush-core.hpp"
struct PainterObjectScope {
  U h, first, ordinal, kind;
  int cell;
  float bounds[4];
};
static PainterObjectScope painterObjectStack[16];
static U painterObjectDepth, painterObjectOrdinal, painterObjectBase, painterObjectSc, painterObjectLayer;
static int painterObjectCell;
static bool painterObjectsEnabled;
static void painterObjectBounds(U h, const float* bounds) {
  if (painterObjectsEnabled && painterObjectDepth && painterObjectStack[painterObjectDepth - 1].h == h)
    unite(painterObjectStack[painterObjectDepth - 1].bounds, bounds);
}
static bool painterStampOutside(MCanvas& c, const float* bounds) {
  painterObjectBounds(U(&c - canvases) + 1, bounds);
  return outside(c, bounds);
}
#define outside painterStampOutside
#include "stamp-core.hpp"
#undef outside
#include "stamp-field.hpp"
#include "mountain-core.hpp"
#include "painter/near.hpp"
#include "painter/common.hpp"
#include "painter/flower.hpp"
#include "painter/sakura-layers.hpp"
#include "painter/sakura-close.hpp"
#include "painter/bamboo.hpp"
#include "painter/bamboo-close.hpp"
#include "painter/driver.hpp"

static painter::isolated_flower::Result ptFlowerResult;
static_assert(sizeof(painter::isolated_flower::Result) == 32, "Flower result ABI size");
static_assert(__builtin_offsetof(painter::isolated_flower::Result, lineWidth) == 24, "Flower width ABI");
static_assert(__builtin_offsetof(painter::isolated_flower::Result, lineCap) == 28, "Flower cap ABI");
extern "C" {
U pt_flower(U h, U state, float x, float y, float radius, float rotation, float scale, float tone, float alpha,
            U outline, float miter, U cap, U join) {
  ptFlowerResult = {};
  ptFlowerResult.state = state;
  if (!h || h > MAX_BANKS || !canvases[h - 1].used || error) {
    ptFlowerResult.status = error ? error : 0xf001u;
    return NONE;
  }
  const float* m = canvases[h - 1].s.m;
  for (U i = 0; i < 6; i++)
    if (!finite(m[i]))
      return 0;
  if (m[1] != 0 || m[2] != 0 || m[0] <= 0 || m[3] != m[0])
    return 0;
  pc::Pen pen;
  pen.miter = miter;
  pen.cap = cap;
  pen.join = join;
  const painter::isolated_flower::Input in{x, y, radius, rotation, scale, tone, alpha, pen, outline != 0, true};
  ptFlowerResult = painter::isolated_flower::draw(h, state, in);
  return ptFlowerResult.status ? NONE : U(&ptFlowerResult);
}
U pt_flower_error() {
  return ptFlowerResult.status;
}
}
