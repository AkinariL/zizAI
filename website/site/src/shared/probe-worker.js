const PROBE = (() => {
  if (!SITE_DEBUG || !SITE_CONFIG.debug)
    return {
      state() {},
      begin() {
        return -1;
      },
      set() {},
      add() {},
      done() {},
      note() {},
      queueDone() {},
    };
  const N = 16384,
    F = 26,
    data = new Float64Array(N * F),
    origin = performance.timeOrigin;
  let n = 0,
    states = 0,
    lastArrive = 0;
  const log = [],
    counts = {},
    gclog = [];
  const registry =
    typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry(() => {
          const time = Math.round(origin + performance.now()),
            previous = gclog[gclog.length - 1];
          if (previous && time - previous[0] < 60) previous[1]++;
          else if (gclog.length < 4000) gclog.push([time, 1]);
        })
      : null;
  const labelled = new Set([
    'createCommandEncoder',
    'beginRenderPass',
    'beginComputePass',
    'createBindGroup',
    'createView',
  ]);
  function wrap(prototype, name, key = name) {
    const original = prototype?.[name];
    if (typeof original !== 'function') return;
    prototype[name] = function (...args) {
      counts[key] = (counts[key] || 0) + 1;
      if (labelled.has(key)) {
        const label = args[0]?.label || args[0]?.layout?.label || '-';
        const detail = key + ' | ' + label.replace(/[0-9]+/g, '#');
        counts[detail] = (counts[detail] || 0) + 1;
      }
      const result = original.apply(this, args);
      if (key === 'finish' && registry) registry.register(result, 0);
      return result;
    };
  }
  for (const method of [
    'createBindGroup',
    'createBuffer',
    'createTexture',
    'createCommandEncoder',
    'createQuerySet',
    'createSampler',
    'createRenderPipeline',
    'createComputePipeline',
  ])
    wrap(globalThis.GPUDevice?.prototype, method);
  wrap(globalThis.GPUTexture?.prototype, 'createView');
  for (const method of ['beginRenderPass', 'beginComputePass', 'finish'])
    wrap(globalThis.GPUCommandEncoder?.prototype, method);
  wrap(globalThis.GPUCanvasContext?.prototype, 'getCurrentTexture');
  wrap(globalThis.GPUBuffer?.prototype, 'mapAsync');
  wrap(globalThis.GPUBuffer?.prototype, 'destroy', 'buffer.destroy');
  wrap(globalThis.GPUTexture?.prototype, 'destroy', 'texture.destroy');
  for (const method of ['onSubmittedWorkDone', 'submit', 'writeBuffer']) wrap(globalThis.GPUQueue?.prototype, method);
  const channel = new BroadcastChannel('zz-probe');
  channel.onmessage = event => {
    if (event.data === 'reset') {
      n = 0;
      gclog.length = 0;
      for (const key in counts) delete counts[key];
    } else if (event.data === 'dump') {
      const size = Math.min(n, N);
      channel.postMessage({
        type: 'dump',
        F,
        n: size,
        timeOrigin: origin,
        data: data.slice(0, size * F),
        log,
        counts: {
          ...counts,
          held: GPU_HOLD.stats.held,
          gclog,
          meshTimings: (GPU_DIAG.meshTimings || []).slice(-400),
          meshSlices: (GPU_DIAG.meshSlices || []).slice(-400),
          sceneSamples: (GPU_DIAG.samples || []).slice(-200).map(sample => sample.total),
          queueCompletionSampling: {
            everyFrames: 1,
            columns: [12, 13],
            meaning:
              'queue completion callback delay after scene encoding (12) or tile upload submission (13); not GPU execution or display presentation',
          },
          frameGenerationColumns: {
            columns: [24, 25],
            meaning: 'UI/text generation currently drawn, rather than latest received',
          },
        },
      });
    }
  };
  return {
    state() {
      states++;
      lastArrive = performance.now();
    },
    note(what, start) {
      if (log.length < 4000)
        log.push([Math.round(origin + start), Math.round((performance.now() - start) * 10) / 10, what]);
    },
    begin(now) {
      if (n >= N) return -1;
      const index = n++,
        offset = index * F;
      data.fill(0, offset, offset + F);
      data[offset] = origin + now;
      data[offset + 1] = origin + performance.now();
      data[offset + 2] = states;
      states = 0;
      data[offset + 3] = lastArrive ? performance.now() - lastArrive : -1;
      return index;
    },
    set(index, column, value) {
      if (index >= 0) data[index * F + column] = value;
    },
    add(index, column, value) {
      if (index >= 0) data[index * F + column] += value;
    },
    done(index, column, start) {
      if (index >= 0) data[index * F + column] = performance.now() - start;
    },
    queueDone(index, column, queue, start) {
      if (index >= 0)
        queue.onSubmittedWorkDone().then(
          () => {
            data[index * F + column] = performance.now() - start;
          },
          () => {},
        );
    },
  };
})();
