function flattenTileDataPlan(p) {
  if (p.version === 2) return p;
  const opCount = p.ops.length,
    nodeCount = p.nodes.length,
    gpuOpCount = p.gpuOps.length,
    stageCount = p.stages.length;
  const opData = new Uint32Array(opCount * 12),
    opWork = new Float32Array(opCount * 2),
    nodeData = new Uint32Array(nodeCount * 8),
    nodeGeo = new Float32Array(nodeCount * 8),
    nodeOps = new Uint32Array(opCount),
    stageData = new Uint32Array(stageCount * 6),
    stageNodes = new Uint32Array(p.stages.reduce((n, s) => n + s.nodes.length, 0));
  let at = 0;
  for (const n of p.nodes) {
    const k = n.id * 8;
    nodeData.set(
      [
        n.page ? p.stages.indexOf(n.page) : 0xffffffff,
        n.x || 0,
        n.y || 0,
        Math.max(0, Math.ceil(n.crop[2] - n.crop[0])),
        Math.max(0, Math.ceil(n.crop[3] - n.crop[1])),
        at,
        n.ops.length,
        n.depth,
      ],
      k,
    );
    nodeGeo.set(n.bounds, k);
    nodeGeo.set(n.crop, k + 4);
    for (const op of n.ops) nodeOps[at++] = op.index;
  }
  at = 0;
  for (let i = 0; i < stageCount; i++) {
    const s = p.stages[i];
    stageData.set([s.width, s.height, at, s.nodes.length, s.kind === 'tile' ? 1 : 0, 0], i * 6);
    for (const n of s.nodes) stageNodes[at++] = n.id;
  }
  for (const o of p.ops) {
    const k = o.index * 12,
      c = o.command,
      kind =
        o.kind === 'path' ? 1 : o.kind === 'capsuleUnion' ? 2 : o.kind === 'group' ? 3 : o.kind === 'stamp' ? 5 : 0;
    if (!kind) throw Error('Unsupported tile plan operation kind: ' + o.kind);
    if (kind === 5 && (o.gpuIndex !== undefined || o.batchOwner || o.batch?.members > 1 || o.parametric))
      throw Error('Stamp operation cannot enter GPU preparation or path batching');
    opData.set(
      [
        kind,
        (o.skip ? 1 : 0) | (c.convex === true ? 2 : 0) | (o.parametric ? 4 : 0) | (o.batchOwner ? 8 : 0),
        c.first || 0,
        c.count || 0,
        o.node.id,
        o.child?.id ?? 0xffffffff,
        o.gpuIndex ?? 0xffffffff,
        o.batch?.members || 1,
        o.batch?.vertexCount || (o.kind === 'path' ? c.count : 6),
        o.nodeOffset ?? o.node.ops.indexOf(o),
        c.paint || 0,
        o.preparedFirst || 0,
      ],
      k,
    );
    opWork[o.index * 2] = o.work || 0;
    opWork[o.index * 2 + 1] = o.batch?.work ?? o.work ?? 0;
  }
  const { root, nodes, ops, gpuOps, stages, tileStage, ...header } = p;
  return {
    ...header,
    version: 2,
    storage: 'js-index-tables',
    opCount,
    nodeCount,
    gpuOpCount,
    stageCount,
    opData,
    opWork,
    nodeData,
    nodeGeo,
    nodeOps,
    stageData,
    stageNodes,
  };
}
function ownTileDelivery(mesh, worker) {
  if (!mesh?.delivery) return;
  ownNativeData(
    mesh,
    worker,
    {
      type: 'recycle',
      era: mesh.preprocessed.identity.era,
      id: mesh.preprocessed.identity.id,
      resultSlot: mesh.delivery.resultSlot ?? 0,
    },
    worker.meshInfo?.transport,
  );
  mesh.release = () => {
    mesh.releaseData?.();
    delete mesh.releaseData;
    delete mesh.release;
  };
}
function releaseTileDelivery(mesh) {
  mesh?.release?.();
}
