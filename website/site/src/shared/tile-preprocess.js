function tilePreprocessOptions(options = {}) {
  const limits = options.limits || options;
  const maxTextureDimension2D = limits.maxTextureDimension2D;
  const maxStorageBufferBindingSize = limits.maxStorageBufferBindingSize;
  const maxBufferSize = limits.maxBufferSize ?? maxStorageBufferBindingSize;
  if (![maxTextureDimension2D, maxStorageBufferBindingSize, maxBufferSize].every(n => Number.isSafeInteger(n) && n > 0))
    throw Error('Invalid tile preprocessing device limits');
  return {
    limits: { maxTextureDimension2D, maxStorageBufferBindingSize, maxBufferSize },
    gpuPreparation: options.gpuPreparation !== false,
    convexInstancing: options.convexInstancing !== false,
  };
}

function createTilePreprocessor(packet, options = {}, identity = {}) {
  const config = tilePreprocessOptions(options),
    gpuPreparation = config.gpuPreparation;
  const maxDimension = config.limits.maxTextureDimension2D;
  const finite = a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);
  const positiveRect = a => finite(a) && a[2] > 0 && a[3] > 0;
  const emptyBounds = () => [Infinity, Infinity, -Infinity, -Infinity];
  const validBounds = b => b[2] > b[0] && b[3] > b[1];
  const align4 = n => Math.max(4, Math.ceil(n / 4) * 4);
  function union(a, b) {
    if (!validBounds(b)) return;
    a[0] = Math.min(a[0], b[0]);
    a[1] = Math.min(a[1], b[1]);
    a[2] = Math.max(a[2], b[2]);
    a[3] = Math.max(a[3], b[3]);
  }
  function cropped(b, r, fringe = 0) {
    return [
      Math.max(r[0], Math.floor(b[0] - fringe)),
      Math.max(r[1], Math.floor(b[1] - fringe)),
      Math.min(r[0] + r[2], Math.ceil(b[2] + fringe)),
      Math.min(r[1] + r[3], Math.ceil(b[3] + fringe)),
    ];
  }
  function mapBounds(b, source, dest) {
    const sx = dest[2] / source[2],
      sy = dest[3] / source[3];
    return [
      dest[0] + (b[0] - source[0]) * sx,
      dest[1] + (b[1] - source[1]) * sy,
      dest[0] + (b[2] - source[0]) * sx,
      dest[1] + (b[3] - source[1]) * sy,
    ];
  }
  function checkedBytes(bytes) {
    const size = align4(bytes);
    if (
      !Number.isSafeInteger(size) ||
      size > config.limits.maxStorageBufferBindingSize ||
      size > config.limits.maxBufferSize
    )
      throw Error('Tile storage buffer exceeds preprocessing binding limit');
    return size;
  }
  if (
    ![1, 2].includes(packet?.version) ||
    !(packet.vertices instanceof Float32Array) ||
    !(packet.paints instanceof Float32Array) ||
    !Array.isArray(packet.commands)
  )
    throw Error('Invalid tile mesh packet v1/v2');
  if (packet.vertices.length % 6 || packet.paints.length % 64) throw Error('Invalid tile vertex or paint stride');
  if (packet.stamps !== undefined && (!(packet.stamps instanceof Float32Array) || packet.stamps.length % 32))
    throw Error('Invalid tile stamp stride');
  if (packet.stamps?.length) throw Error('Stamp input requires native tile planning');
  if (
    packet.version === 2 &&
    ((!gpuPreparation && (packet.generatedVertexCount || packet.segments?.length)) ||
      !(packet.segments instanceof Float32Array) ||
      packet.segments.length % 16 ||
      !(packet.transforms instanceof Float32Array) ||
      packet.transforms.length % 8 ||
      !Number.isInteger(packet.generatedVertexCount) ||
      packet.generatedVertexCount < 0)
  )
    throw Error('Invalid tile compact packet v2 or GPU preparation disabled');
  if (!(
    Number.isInteger(packet.width) &&
    Number.isInteger(packet.height) &&
    packet.width > 0 &&
    packet.height > 0 &&
    packet.width <= maxDimension &&
    packet.height <= maxDimension
  ))
    throw Error('Tile packet exceeds texture dimension limit');
  checkedBytes(Math.max(8, packet.vertices.byteLength));
  checkedBytes(packet.paints.byteLength);
  checkedBytes(packet.stamps?.byteLength || 0);
  const root = {
    id: 0,
    depth: 0,
    ops: [],
    bounds: [0, 0, packet.width, packet.height],
    crop: [0, 0, packet.width, packet.height],
    x: 0,
    y: 0,
  };
  const state = {
    packet,
    root,
    nodes: [root],
    ops: [],
    gpuOps: [],
    gpuPreparation: false,
    walk: [{ list: packet.commands, index: 0, node: root }],
    levels: [],
    phase: 'walk',
    packDepth: 0,
    packIndex: 0,
    packPageIndex: 0,
    recordIndex: 0,
    batchIndex: 0,
    geometryIndex: 0,
    geometryCursor: 0,
    preparedVertexCount: 0,
    parametricVertexCount: 0,
    ownedSegmentCount: 0,
    stages: [],
    iterations: 0,
    stats: {
      paths: 0,
      directConvexPaths: 0,
      analyticStrokePaths: 0,
      analyticSegments: 0,
      groups: 0,
      storageVertexCount: packet.vertices.length / 2,
      trianglePathTriangles: 0,
      renderTriangles: 0,
      triangles: 0,
      triangleAccounting:
        'triangle path geometry + two triangles per capsule quad; excludes group and stencil-cover quads',
      vertexBytes: packet.vertices.byteLength,
      paintBytes: packet.paints.byteLength,
      segmentBytes: packet.segments?.byteLength || 0,
      transformBytes: packet.transforms?.byteLength || 0,
      stampInstances: packet.stamps?.length / 32 || 0,
      stampBytes: packet.stamps?.byteLength || 0,
      preparedVertexBytes: 0,
      preparationBytes: 0,
      gpuOperationBytes: 0,
      gpuIndirectBytes: 0,
      gpuVisibilityBytes: 0,
      geometryTaskBytes: 0,
      recordBytes: 0,
      uploadedBytes: 0,
      uploadWrites: 0,
      maxSingleUploadBytes: 0,
      maxSingleUploadCPUms: 0,
      parametricPaths: 0,
      fallbackPaths: 0,
      fallbackPathVertexCount: 0,
      fallbackDraws: 0,
      parametricDraws: 0,
      computePasses: 0,
      computedVertices: 0,
      copiedVertices: 0,
      copyDispatches: 0,
      gpuVisibilityOps: 0,
      cpuVisibilityPaths: 0,
      visibilityCandidates: 0,
      indirectDraws: 0,
      preparedBatches: 0,
      preparedBatchPaths: 0,
      temporaryRecordArraysAvoided: 0,
      cachedOperationWorkCount: 0,
      draws: 0,
      passes: 0,
      steps: 0,
      cpuMs: 0,
      renderCPUms: 0,
      allocationCPUms: 0,
      uploadCPUms: 0,
      atlasPages: 0,
      atlasPixels: 0,
      gpuFeedbackSamples: 0,
    },
  };
  function walkOne() {
    const job = state,
      frame = job.walk.at(-1);
    if (!frame) {
      job.gpuPreparation = gpuPreparation && job.gpuOps.length > 0;
      job.stats.playback = job.gpuPreparation
        ? job.stats.fallbackPaths
          ? 'mixed'
          : 'compute-indirect'
        : 'source-only';
      job.stats.gpuVisibilityOps = job.gpuOps.length;
      job.stats.cpuVisibilityPaths = job.stats.fallbackPaths;
      job.stats.eliminatedCopyVertexBytes = gpuPreparation ? job.stats.fallbackPathVertexCount * 16 : 0;
      job.packDepth = job.levels.length - 1;
      job.phase = 'pack';
      return;
    }
    if (frame.index === frame.list.length) {
      job.walk.pop();
      const node = frame.node;
      if (node !== job.root) {
        node.crop = validBounds(node.bounds) ? cropped(node.bounds, node.cmd.sourceRect, 1) : [0, 0, 0, 0];
        if (validBounds(node.crop)) {
          union(node.parent.bounds, mapBounds(node.crop, node.cmd.sourceRect, node.cmd.destRect));
          const level =
            job.levels[node.depth] || (job.levels[node.depth] = { nodes: [], maxWidth: 0, area: 0, pages: [] });
          level.nodes.push(node);
          const w = Math.ceil(node.crop[2] - node.crop[0]) + 2,
            h = Math.ceil(node.crop[3] - node.crop[1]) + 2;
          level.maxWidth = Math.max(level.maxWidth, w);
          level.area += w * h;
        }
      }
      return;
    }
    const command = frame.list[frame.index++];
    if (command.kind === 'stamp' || command.kind === 5) throw Error('Stamp input requires native tile planning');
    if (command.kind === 'path' || command.kind === 'parametricPath' || command.kind === 'capsuleUnion') {
      const analytic = command.kind === 'capsuleUnion',
        parametric = command.kind === 'parametricPath',
        count = analytic ? command.count * 2 : command.count;
      const capacity = job.packet.vertices.length / 2 + (parametric ? job.packet.generatedVertexCount : 0);
      if (
        !finite(command.bounds) ||
        !Number.isInteger(command.first) ||
        !Number.isInteger(command.count) ||
        command.first < 0 ||
        command.first > 0xffffff ||
        command.count < 0 ||
        command.count > 0xffffff ||
        (!analytic && command.count % 3) ||
        command.first + count > capacity ||
        !Number.isInteger(command.paint) ||
        command.paint < 0 ||
        (command.paint + 1) * 64 > job.packet.paints.length
      )
        throw Error('Invalid tile geometry command');
      if (
        analytic &&
        (!(command.count >= 1 && command.count <= 32) || !(Number.isFinite(command.radius) && command.radius > 0))
      )
        throw Error('Invalid tile capsule union command');
      if (
        parametric &&
        (job.packet.version !== 2 ||
          command.first < job.packet.vertices.length / 2 ||
          !Number.isInteger(command.segmentFirst) ||
          !Number.isInteger(command.segmentCount) ||
          command.segmentFirst < 0 ||
          command.segmentCount < 1 ||
          (command.segmentFirst + command.segmentCount) * 16 > job.packet.segments.length)
      )
        throw Error('Invalid tile parametric path command');
      if (!command.count || !validBounds(command.bounds)) return;
      const op = {
        command,
        node: frame.node,
        index: job.ops.length,
        nodeOffset: frame.node.ops.length,
        kind: analytic ? 'capsuleUnion' : 'path',
        parametric,
        preparedFirst: job.preparedVertexCount,
      };
      if (gpuPreparation && (analytic || parametric)) {
        op.gpuIndex = job.gpuOps.length;
        job.gpuOps.push(op);
      }
      if (parametric) {
        job.preparedVertexCount += command.count;
        job.parametricVertexCount += command.count;
        job.stats.parametricPaths++;
      } else if (!analytic) {
        job.stats.fallbackPaths++;
        job.stats.fallbackPathVertexCount += command.count;
      }
      job.ops.push(op);
      frame.node.ops.push(op);
      union(frame.node.bounds, command.bounds);
      job.stats.paths++;
      if (analytic) {
        job.stats.analyticStrokePaths++;
        job.stats.analyticSegments += command.count;
        job.stats.renderTriangles += 2;
      } else {
        job.stats.trianglePathTriangles += command.count / 3;
        job.stats.renderTriangles += command.count / 3;
        if (command.convex === true) job.stats.directConvexPaths++;
      }
      job.stats.triangles = job.stats.renderTriangles;
    } else if (command.kind === 'group') {
      if (
        !Array.isArray(command.commands) ||
        !positiveRect(command.sourceRect) ||
        !positiveRect(command.destRect) ||
        !Number.isFinite(command.alpha) ||
        command.alpha < 0 ||
        command.alpha > 1
      )
        throw Error('Invalid tile group command');
      if (command.alpha === 0) return;
      if (frame.node.depth >= 32) throw Error('Tile group nesting exceeds 32');
      const draw = { kind: 'group', sourceRect: command.sourceRect, destRect: command.destRect, alpha: command.alpha };
      const node = {
        id: job.nodes.length,
        depth: frame.node.depth + 1,
        parent: frame.node,
        cmd: draw,
        ops: [],
        bounds: emptyBounds(),
      };
      const op = { command: draw, node: frame.node, child: node, index: job.ops.length, kind: 'group' };
      if (gpuPreparation) {
        op.gpuIndex = job.gpuOps.length;
        job.gpuOps.push(op);
      }
      job.nodes.push(node);
      job.ops.push(op);
      frame.node.ops.push(op);
      job.stats.groups++;
      job.walk.push({ list: command.commands, index: 0, node });
    } else throw Error('Unsupported tile command kind: ' + command.kind);
  }
  function packOne() {
    const job = state;
    if (job.packDepth < 1) {
      const stage = {
        width: packet.width,
        height: packet.height,
        nodes: [job.root],
        nodeIndex: 0,
        opIndex: 0,
        kind: 'tile',
      };
      job.root.page = stage;
      job.stages.push(stage);
      job.tileStage = stage;
      job.recordData = new Float32Array(checkedBytes(Math.max(64, job.ops.length * 64)) / 4);
      if (job.gpuPreparation) {
        job.prepareData = new Uint32Array(checkedBytes(Math.max(32, job.gpuOps.length * 32)) / 4);
        checkedBytes(Math.ceil((packet.segments?.length || 0) / 16 / 4) * 16);
        job.segmentOwners = new Uint32Array(Math.ceil((packet.segments?.length || 0) / 16 / 4) * 4);
        job.segmentOwners.fill(0xffffffff);
      }
      job.stats.recordBytes = job.recordData.byteLength;
      job.phase = 'records';
      return;
    }
    const level = job.levels[job.packDepth];
    if (!level || job.packIndex === level.nodes.length) {
      if (level && job.packPageIndex < level.pages.length) {
        const page = level.pages[job.packPageIndex++];
        page.height = Math.max(1, page.y + page.row);
        job.stages.push(page);
        job.stats.atlasPages++;
        job.stats.atlasPixels += page.width * page.height;
        return;
      }
      job.packDepth--;
      job.packIndex = 0;
      job.packPageIndex = 0;
      return;
    }
    const node = level.nodes[job.packIndex++],
      w = Math.ceil(node.crop[2] - node.crop[0]) + 2,
      h = Math.ceil(node.crop[3] - node.crop[1]) + 2;
    if (w > maxDimension || h > maxDimension) throw Error('Tile group exceeds atlas dimension limit');
    if (!level.width)
      level.width = Math.min(
        maxDimension,
        Math.max(level.maxWidth, Math.min(2048, 2 ** Math.ceil(Math.log2(Math.max(1, Math.sqrt(level.area)))))),
      );
    let page = level.pages.at(-1);
    if (!page) {
      page = { width: level.width, x: 0, y: 0, row: 0, nodes: [], nodeIndex: 0, opIndex: 0, kind: 'atlas' };
      level.pages.push(page);
    }
    if (page.x + w > page.width) {
      page.x = 0;
      page.y += page.row;
      page.row = 0;
    }
    if (page.y + h > maxDimension) {
      page = { width: level.width, x: 0, y: 0, row: 0, nodes: [], nodeIndex: 0, opIndex: 0, kind: 'atlas' };
      level.pages.push(page);
    }
    node.page = page;
    node.x = page.x + 1;
    node.y = page.y + 1;
    page.nodes.push(node);
    page.x += w;
    page.row = Math.max(page.row, h);
  }
  function operationWork(op) {
    const b =
      op.kind === 'group' ? mapBounds(op.child.crop, op.command.sourceRect, op.command.destRect) : op.command.bounds;
    const area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    return (
      (op.kind === 'path' ? op.command.count : 6) + area * 0.05 * (op.kind === 'capsuleUnion' ? op.command.count : 1)
    );
  }
  function recordOne() {
    const job = state;
    if (job.recordIndex === job.ops.length) {
      if (job.gpuPreparation) {
        job.phase = 'geometry';
        return;
      }
      if (packet.generatedVertexCount || packet.segments?.length)
        throw Error('Tile compact packet has unowned generated geometry');
      job.phase = 'ready';
      return;
    }
    const op = job.ops[job.recordIndex++],
      node = op.node,
      page = node.page;
    if (op.gpuIndex !== undefined) {
      const k = op.gpuIndex * 8,
        c = op.command,
        d = job.prepareData;
      d[k] = op.kind === 'path' ? (op.parametric ? 4 : 1) : op.kind === 'capsuleUnion' ? 2 : 3;
      d[k + 1] = c.first || 0;
      d[k + 2] = c.count || 0;
      d[k + 3] = op.preparedFirst || 0;
      d[k + 4] = op.index;
      d[k + 5] = 0;
      d[k + 6] = 1;
      d[k + 7] = op.kind === 'path' ? c.count : 6;
      job.stats.temporaryRecordArraysAvoided++;
    }
    if (!page) {
      op.skip = true;
      return;
    }
    let rect,
      uv = [0, 0, 0, 0],
      paint = 0,
      alpha = 1;
    if (op.kind !== 'group') {
      rect = cropped(
        op.command.bounds,
        [node.crop[0], node.crop[1], node.crop[2] - node.crop[0], node.crop[3] - node.crop[1]],
        1,
      );
      paint = op.command.paint;
    } else {
      if (!op.child.page || !validBounds(op.child.crop)) {
        op.skip = true;
        return;
      }
      rect = mapBounds(op.child.crop, op.command.sourceRect, op.command.destRect);
      alpha = op.command.alpha;
      const child = op.child,
        src = child.page;
      uv = [
        child.x / src.width,
        child.y / src.height,
        (child.crop[2] - child.crop[0]) / src.width,
        (child.crop[3] - child.crop[1]) / src.height,
      ];
    }
    if (!validBounds(rect)) {
      op.skip = true;
      return;
    }
    const k = op.index * 16,
      d = job.recordData;
    d[k] = rect[0];
    d[k + 1] = rect[1];
    d[k + 2] = rect[2] - rect[0];
    d[k + 3] = rect[3] - rect[1];
    d[k + 4] = page.width;
    d[k + 5] = page.height;
    d[k + 6] = node.x - node.crop[0];
    d[k + 7] = node.y - node.crop[1];
    d[k + 8] = uv[0];
    d[k + 9] = uv[1];
    d[k + 10] = uv[2];
    d[k + 11] = uv[3];
    d[k + 12] = paint;
    d[k + 13] = op.kind === 'group' ? alpha : op.kind === 'capsuleUnion' ? op.command.radius : 1;
    d[k + 14] = op.kind === 'group' ? 0 : op.command.first;
    d[k + 15] = op.kind === 'group' ? 0 : op.command.count;
    op.work = operationWork(op);
    job.stats.temporaryRecordArraysAvoided += 3;
    job.stats.cachedOperationWorkCount++;
  }
  function disjoint(a, b) {
    return a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1];
  }
  function prepareBatch(op) {
    const job = state;
    if (op.gpuIndex === undefined || op.batchOwner || op.skip || op.kind === 'group') return;
    let members = 1,
      vertices = op.kind === 'path' ? op.command.count : 6,
      work = op.work;
    const direct = op.kind === 'path' && op.command.convex === true,
      row = op.node.ops,
      at = op.nodeOffset,
      boxes = [];
    const rect = candidate => job.recordData.subarray(candidate.index * 16, candidate.index * 16 + 4);
    if (op.kind === 'path' && !direct) boxes.push(rect(op));
    while (members < 32 && at + members < row.length) {
      const next = row[at + members];
      if (
        next.skip ||
        next.kind !== op.kind ||
        next.index !== op.index + members ||
        next.gpuIndex !== op.gpuIndex + members ||
        next.batchOwner
      )
        break;
      if (
        op.kind === 'path' &&
        ((next.command.convex === true) !== direct || next.preparedFirst !== op.preparedFirst + vertices)
      )
        break;
      if (work + next.work > 4000) break;
      if (op.kind === 'path' && !direct) {
        const box = rect(next);
        if (boxes.some(old => !disjoint(old, box))) break;
        boxes.push(box);
      }
      next.batchOwner = op;
      vertices += op.kind === 'path' ? next.command.count : 6;
      work += next.work;
      members++;
    }
    op.batch = { members, vertexCount: vertices, work };
    const k = op.gpuIndex * 8;
    job.prepareData[k + 6] = members;
    job.prepareData[k + 7] = vertices;
    if (members > 1) {
      job.stats.preparedBatches++;
      job.stats.preparedBatchPaths += members;
    }
  }
  function geometryOne() {
    const job = state;
    if (job.batchIndex < job.gpuOps.length) {
      prepareBatch(job.gpuOps[job.batchIndex++]);
      return;
    }
    const op = job.gpuOps[job.geometryIndex];
    if (!op) {
      if (
        job.parametricVertexCount !== (packet.generatedVertexCount || 0) ||
        job.ownedSegmentCount !== (packet.segments?.length || 0) / 16
      )
        throw Error('Tile compact packet has unowned or mismatched generated geometry');
      job.taskData = job.segmentOwners;
      for (const bytes of [
        Math.max(64, packet.segments?.byteLength || 0),
        Math.max(32, packet.transforms?.byteLength || 0),
        Math.max(4, job.taskData.byteLength),
        Math.max(16, job.preparedVertexCount * 16),
        Math.max(32, job.gpuOps.length * 32),
        Math.max(4, job.ops.length * 4),
      ])
        checkedBytes(bytes);
      job.stats.preparedVertexBytes = job.preparedVertexCount * 16;
      job.stats.gpuOperationBytes = job.prepareData.byteLength;
      job.stats.gpuIndirectBytes = job.gpuOps.length * 32;
      job.stats.gpuVisibilityBytes = job.ops.length * 4;
      job.stats.geometryTaskBytes = job.taskData.byteLength;
      job.stats.preparationBytes =
        job.prepareData.byteLength + job.taskData.byteLength + job.gpuOps.length * 32 + job.ops.length * 4;
      job.phase = 'ready';
      return;
    }
    if (!op.parametric) {
      job.geometryIndex++;
      return;
    }
    const segment = op.command.segmentFirst + job.geometryCursor,
      k = segment * 16,
      data = packet.segments;
    for (let j = 0; j < 16; j++) if (!Number.isFinite(data[k + j])) throw Error('Non-finite tile curve parameter');
    const kind = data[k],
      steps = data[k + 1],
      first = data[k + 2],
      transform = data[k + 3];
    const expected = op.expectedOutput ?? op.command.first;
    if (
      !Number.isInteger(kind) ||
      kind < 1 ||
      kind > 5 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 256 ||
      first !== expected ||
      !Number.isInteger(transform) ||
      transform < 0 ||
      (transform + 1) * 8 > packet.transforms.length ||
      job.segmentOwners[segment] !== 0xffffffff
    )
      throw Error('Invalid tile curve subdivision/output/transform/owner');
    if (kind === 5) {
      let sum = 0;
      for (let j = 8; j < 14; j++) {
        const n = data[k + j];
        if (!Number.isInteger(n) || n < 1 || n > 256) throw Error('Invalid canonical petal subdivision');
        sum += n;
      }
      if (sum !== steps) throw Error('Canonical petal subdivision count mismatch');
    }
    for (let j = 0; j < 8; j++)
      if (!Number.isFinite(packet.transforms[transform * 8 + j])) throw Error('Non-finite tile affine transform');
    job.segmentOwners[segment] = op.gpuIndex;
    job.ownedSegmentCount++;
    op.expectedOutput = first + steps * 3;
    if (++job.geometryCursor === op.command.segmentCount) {
      if (op.expectedOutput !== op.command.first + op.command.count)
        throw Error('Tile curve vertex count does not match command');
      job.geometryIndex++;
      job.geometryCursor = 0;
    }
  }
  function stepOne() {
    if (state.phase === 'ready') return true;
    state.iterations++;
    if (state.phase === 'walk') walkOne();
    else if (state.phase === 'pack') packOne();
    else if (state.phase === 'records') recordOne();
    else if (state.phase === 'geometry') geometryOne();
    else throw Error('Tile preprocessor is not active');
    return state.phase === 'ready';
  }
  function result() {
    if (state.phase !== 'ready') throw Error('Tile preprocessing is incomplete');
    return {
      version: 1,
      config,
      identity: { era: identity.era, id: identity.id },
      consumed: false,
      packetVersion: packet.version,
      width: packet.width,
      height: packet.height,
      vertexLength: packet.vertices.length,
      paintLength: packet.paints.length,
      segmentLength: packet.segments?.length || 0,
      transformLength: packet.transforms?.length || 0,
      stampLength: packet.stamps?.length || 0,
      generatedVertexCount: packet.generatedVertexCount || 0,
      root: state.root,
      nodes: state.nodes,
      ops: state.ops,
      gpuOps: state.gpuOps,
      stages: state.stages,
      tileStage: state.tileStage,
      gpuPreparation: state.gpuPreparation,
      preparedVertexCount: state.preparedVertexCount,
      recordData: state.recordData,
      prepareData: state.prepareData,
      taskData: state.taskData,
      stats: { ...state.stats },
      iterations: state.iterations,
    };
  }
  return { state, stepOne, result };
}

function validateTilePreprocessed(packet, options, identity = {}) {
  const p = packet.preprocessed,
    config = tilePreprocessOptions(options),
    old = p?.config;
  if (packet.stamps !== undefined && (!(packet.stamps instanceof Float32Array) || packet.stamps.length % 32))
    throw Error('Invalid tile stamp stride');
  if (
    ![1, 2].includes(p?.version) ||
    p.consumed ||
    !old ||
    old.gpuPreparation !== config.gpuPreparation ||
    old.convexInstancing !== config.convexInstancing ||
    old.limits?.maxTextureDimension2D !== config.limits.maxTextureDimension2D ||
    old.limits.maxStorageBufferBindingSize !== config.limits.maxStorageBufferBindingSize ||
    old.limits.maxBufferSize !== config.limits.maxBufferSize
  )
    throw Error('Tile preprocessing options/limits mismatch or consumed plan');
  if (
    p.packetVersion !== packet.version ||
    p.width !== packet.width ||
    p.height !== packet.height ||
    p.vertexLength !== packet.vertices.length ||
    p.paintLength !== packet.paints.length ||
    p.segmentLength !== (packet.segments?.length || 0) ||
    p.transformLength !== (packet.transforms?.length || 0) ||
    (p.stampLength || 0) !== (packet.stamps?.length || 0) ||
    p.generatedVertexCount !== (packet.generatedVertexCount || 0)
  )
    throw Error('Tile preprocessing packet size mismatch');
  if (
    (identity.era !== undefined && p.identity?.era !== identity.era) ||
    (identity.id !== undefined && p.identity?.id !== identity.id)
  )
    throw Error('Tile preprocessing era/id mismatch');
  if (p.version === 2) {
    if (
      ![p.opCount, p.nodeCount, p.gpuOpCount, p.stageCount].every(Number.isSafeInteger) ||
      p.opCount < 0 ||
      p.opCount > 32768 ||
      p.nodeCount < 1 ||
      p.nodeCount > 8192 ||
      p.gpuOpCount < 0 ||
      p.gpuOpCount > p.opCount ||
      p.stageCount < 1 ||
      p.stageCount > 4096 ||
      !p.stats ||
      p.preparedVertexCount !== (packet.generatedVertexCount || 0)
    )
      throw Error('Invalid indexed tile plan capacity');
    for (const [key, length, type] of [
      ['opData', p.opCount * 12, Uint32Array],
      ['opWork', p.opCount * 2, Float32Array],
      ['nodeData', p.nodeCount * 8, Uint32Array],
      ['nodeGeo', p.nodeCount * 8, Float32Array],
      ['nodeOps', p.opCount, Uint32Array],
      ['stageData', p.stageCount * 6, Uint32Array],
      ['stageNodes', null, Uint32Array],
      ['recordData', Math.max(16, p.opCount * 16), Float32Array],
    ])
      if (!(p[key] instanceof type) || (length !== null && p[key].length !== length))
        throw Error('Invalid indexed tile plan table ' + key);
    const k = (p.stageCount - 1) * 6;
    if (
      p.stageData[k] !== packet.width ||
      p.stageData[k + 1] !== packet.height ||
      p.stageData[k + 3] !== 1 ||
      p.stageData[k + 4] !== 1 ||
      p.stageNodes[p.stageData[k + 2]] !== 0 ||
      p.nodeData[0] !== p.stageCount - 1
    )
      throw Error('Invalid indexed tile root stage');
    if (
      p.gpuPreparation !== (config.gpuPreparation && p.gpuOpCount > 0) ||
      (p.gpuPreparation &&
        (!(p.prepareData instanceof Uint32Array) ||
          p.prepareData.length !== Math.max(8, p.gpuOpCount * 8) ||
          !(p.taskData instanceof Uint32Array) ||
          p.taskData.length !== Math.ceil(p.segmentLength / 16 / 4) * 4))
    )
      throw Error('Invalid indexed compute plan');
    return p;
  }
  if (
    !Array.isArray(p.ops) ||
    !Array.isArray(p.nodes) ||
    !p.nodes.length ||
    !Array.isArray(p.gpuOps) ||
    !Array.isArray(p.stages) ||
    !p.stages.length ||
    !p.stats ||
    p.root !== p.nodes[0] ||
    p.tileStage !== p.stages.at(-1) ||
    p.root.id !== 0 ||
    p.root.depth !== 0 ||
    p.root.page !== p.tileStage ||
    p.tileStage.kind !== 'tile' ||
    p.tileStage.width !== packet.width ||
    p.tileStage.height !== packet.height ||
    p.tileStage.nodes?.[0] !== p.root ||
    !(p.recordData instanceof Float32Array) ||
    p.recordData.length !== Math.max(16, p.ops.length * 16) ||
    p.gpuPreparation !== (config.gpuPreparation && p.gpuOps.length > 0) ||
    !Number.isSafeInteger(p.preparedVertexCount) ||
    p.preparedVertexCount < 0 ||
    p.preparedVertexCount !== (packet.generatedVertexCount || 0)
  )
    throw Error('Invalid tile preprocessing draw plan');
  if (
    p.gpuPreparation &&
    (!(p.prepareData instanceof Uint32Array) ||
      p.prepareData.length !== Math.max(8, p.gpuOps.length * 8) ||
      !(p.taskData instanceof Uint32Array) ||
      p.taskData.length !== Math.ceil(p.segmentLength / 16 / 4) * 4)
  )
    throw Error('Invalid tile preprocessing compute plan');
  return p;
}

function tilePreprocessedTransferables(packet) {
  const p = packet.preprocessed;
  return [
    ...new Set(
      [
        packet.vertices,
        packet.paints,
        packet.segments,
        packet.transforms,
        packet.stamps,
        packet.objects,
        p?.recordData,
        p?.prepareData,
        p?.taskData,
        p?.opData,
        p?.opWork,
        p?.nodeData,
        p?.nodeGeo,
        p?.nodeOps,
        p?.stageData,
        p?.stageNodes,
      ]
        .filter(Boolean)
        .map(a => a.buffer),
    ),
  ];
}
