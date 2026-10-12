function createFrameDiagnostics(options = {}) {
  const size = Number.isFinite(options.capacity) ? Math.trunc(options.capacity) : 360;
  const capacity = Math.max(32, Math.min(2048, size));
  const clock = options.now || (() => performance.now());
  let visible = options.visible !== false,
    enabled = options.enabled !== false;
  let segment = 0,
    startedAt = clock(),
    visibilityCleanup = null;
  const listeners = new Set();
  const gpuStatus = { supported: false, enabled: false, reliable: false, reason: 'timestamp-query not enabled' };
  function series(kind) {
    const values = new Float64Array(capacity);
    let count = 0,
      cursor = 0,
      sum = 0,
      last = null,
      events = 0;
    function reset() {
      count = cursor = sum = events = 0;
      last = null;
    }
    function append(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      if (count === capacity) sum -= values[cursor];
      else count++;
      values[cursor] = ms;
      sum += ms;
      cursor = (cursor + 1) % capacity;
    }
    function mark(timestamp) {
      if (!enabled || !visible || !Number.isFinite(timestamp)) return;
      if (last !== null && timestamp <= last) return;
      events++;
      if (last !== null) append(timestamp - last);
      last = timestamp;
    }
    function duration(ms) {
      if (!enabled || !visible || !Number.isFinite(ms) || ms < 0) return;
      events++;
      append(ms);
    }
    function snapshot() {
      const sorted = values.slice(0, count).sort();
      const meanMs = count ? sum / count : null;
      return {
        kind,
        samples: count,
        events,
        meanMs,
        p95Ms: count ? sorted[Math.ceil(count * 0.95) - 1] : null,
        p99Ms: count ? sorted[Math.ceil(count * 0.99) - 1] : null,
        minMs: count ? sorted[0] : null,
        maxMs: count ? sorted[count - 1] : null,
        frequencyHz: kind === 'duration' || !count || !(sum > 0) ? null : (count * 1000) / sum,
      };
    }
    return { reset, mark, duration, snapshot };
  }
  const streams = {
    mainRAF: series('raf-callback'),
    workerRAF: series('raf-callback'),
    renderSubmit: series('render-submit'),
    cpuFrame: series('duration'),
    gpuFrame: series('duration'),
  };
  function reset() {
    for (const stream of Object.values(streams)) stream.reset();
    segment++;
    startedAt = clock();
  }
  function stateChanged() {
    for (const listener of listeners) listener();
  }
  function setVisible(next) {
    next = !!next;
    if (visible === next) return;
    visible = next;
    reset();
    stateChanged();
  }
  function setEnabled(next) {
    next = !!next;
    if (enabled === next) return;
    enabled = next;
    reset();
    stateChanged();
  }
  function onStateChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function observeVisibility(doc = globalThis.document, onChange) {
    visibilityCleanup?.();
    if (!doc?.addEventListener) return () => {};
    const sync = () => {
      setVisible(doc.visibilityState !== 'hidden');
      onChange?.(visible);
    };
    doc.addEventListener('visibilitychange', sync);
    sync();
    const cleanup = () => {
      doc.removeEventListener('visibilitychange', sync);
      if (visibilityCleanup === cleanup) visibilityCleanup = null;
    };
    visibilityCleanup = cleanup;
    return cleanup;
  }
  function setGPUStatus(status) {
    const wasEnabled = gpuStatus.supported && gpuStatus.enabled && gpuStatus.reliable;
    for (const key of ['supported', 'enabled', 'reliable']) if (key in status) gpuStatus[key] = !!status[key];
    if ('reason' in status) gpuStatus.reason = String(status.reason || '');
    if (wasEnabled !== (gpuStatus.supported && gpuStatus.enabled && gpuStatus.reliable)) streams.gpuFrame.reset();
  }
  const api = {
    get active() {
      return enabled && visible;
    },
    get segment() {
      return segment;
    },
    markMainRAF: timestamp => streams.mainRAF.mark(timestamp),
    markWorkerRAF: timestamp => streams.workerRAF.mark(timestamp),
    markRenderSubmit: (timestamp = clock()) => streams.renderSubmit.mark(timestamp),
    recordCPUms: ms => streams.cpuFrame.duration(ms),
    recordGPUms: (ms, sampleSegment = segment) => {
      if (sampleSegment === segment && gpuStatus.supported && gpuStatus.enabled && gpuStatus.reliable)
        streams.gpuFrame.duration(ms);
    },
    setGPUStatus,
    setVisible,
    setEnabled,
    reset,
    onStateChange,
    observeVisibility,
    snapshot() {
      return {
        role: options.role || 'unspecified',
        enabled,
        visible,
        segment,
        capacity,
        startedAt,
        capturedAt: clock(),
        mainRAF: streams.mainRAF.snapshot(),
        workerRAF: streams.workerRAF.snapshot(),
        renderSubmit: streams.renderSubmit.snapshot(),
        cpuFrame: streams.cpuFrame.snapshot(),
        gpuFrame: { ...streams.gpuFrame.snapshot(), ...gpuStatus },
        presentedFPS: null,
        measurementNote: 'rAF callback and GPU render submit rates do not measure screen presentation FPS.',
      };
    },
    dispose() {
      visibilityCleanup?.();
      setEnabled(false);
      listeners.clear();
    },
  };
  return api;
}

function startFrameRAFProbe(diagnostics, options = {}) {
  const scope = options.scope || globalThis,
    name = options.name || 'mainRAF';
  const mark = name === 'workerRAF' ? diagnostics.markWorkerRAF : diagnostics.markMainRAF;
  if (typeof scope.requestAnimationFrame !== 'function' || typeof scope.cancelAnimationFrame !== 'function')
    return { supported: false, dispose() {} };
  let handle = null,
    stopped = false;
  function tick(timestamp) {
    handle = null;
    if (stopped || !diagnostics.active) return;
    mark(timestamp);
    handle = scope.requestAnimationFrame(tick);
  }
  function sync() {
    if (stopped || !diagnostics.active) {
      if (handle !== null) scope.cancelAnimationFrame(handle);
      handle = null;
    } else if (handle === null) handle = scope.requestAnimationFrame(tick);
  }
  const unsubscribe = diagnostics.onStateChange(sync);
  sync();
  return {
    supported: true,
    dispose() {
      stopped = true;
      sync();
      unsubscribe();
    },
  };
}
