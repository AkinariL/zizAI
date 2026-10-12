struct PlanOutput {
  Array opData, nodeData, nodeOps, stageData, stageNodes, opWork, nodeGeo, records, prepares, tasks, segments;
  U lease[2];
};
static PlanOutput planOutputs[2];
static U resultSlot;
static U *opData, *nodeData, *nodeOps, *stageData, *stageNodes, *prepares, *tasks;
static D *opWork, *nodeGeo, *records, *plannedSegments;
static bool planOutputReserve(U handle) {
  auto& b = banks[handle - 1];
  U groups = 1;
  for (U i = 0; i < b.cmd.n; i++)
    if (((Raw*)b.cmd.ptr)[i].kind == 3)
      groups++;
  if (groups > MAX_NODES || b.cmd.n > MAX_OPS || b.segments.n > MAX_OPS) {
    error = 11;
    return false;
  }
  U ops = b.cmd.n ? b.cmd.n : 1, pages = groups < MAX_PAGES ? groups : MAX_PAGES;
  auto& p = planOutputs[resultSlot];
  p.opData.stride = 48;
  p.nodeData.stride = 32;
  p.nodeOps.stride = 4;
  p.stageData.stride = 24;
  p.stageNodes.stride = 4;
  p.opWork.stride = 8;
  p.nodeGeo.stride = 32;
  p.records.stride = 64;
  p.prepares.stride = 32;
  p.tasks.stride = 4;
  p.segments.stride = 64;
  if (!reserve(p.opData, ops) || !reserve(p.nodeData, groups) || !reserve(p.nodeOps, ops) ||
      !reserve(p.stageData, pages) || !reserve(p.stageNodes, groups) || !reserve(p.opWork, ops) ||
      !reserve(p.nodeGeo, groups) || !reserve(p.records, ops) || !reserve(p.prepares, ops) ||
      !reserve(p.tasks, (b.segments.n + 3) & ~3u) || !reserve(p.segments, b.segments.n))
    return false;
  opData = (U*)p.opData.ptr;
  nodeData = (U*)p.nodeData.ptr;
  nodeOps = (U*)p.nodeOps.ptr;
  stageData = (U*)p.stageData.ptr;
  stageNodes = (U*)p.stageNodes.ptr;
  opWork = (D*)p.opWork.ptr;
  nodeGeo = (D*)p.nodeGeo.ptr;
  records = (D*)p.records.ptr;
  prepares = (U*)p.prepares.ptr;
  tasks = (U*)p.tasks.ptr;
  plannedSegments = (D*)p.segments.ptr;
  return true;
}
extern "C" {
U td_result_slot(U slot) {
  if (slot > 1) {
    error = 30;
    return 0;
  }
  resultSlot = slot;
  return 1;
}
U td_lease_control() {
  return (U)planOutputs[resultSlot].lease;
}
U td_result_bytes(U slot) {
  if (slot > 1)
    return 0;
  auto& p = planOutputs[slot];
  U n = 0;
  const Array a[] = {p.opData,  p.nodeData, p.nodeOps,  p.stageData, p.stageNodes, p.opWork,
                     p.nodeGeo, p.records,  p.prepares, p.tasks,     p.segments};
  for (auto x : a)
    n += x.cap * x.stride;
  return n;
}
}
