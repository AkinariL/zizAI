function renderWorkerPlain(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth > 10 || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return undefined;
  if (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer) return undefined;
  if (Array.isArray(value))
    return value.map(item => renderWorkerPlain(item, depth + 1)).filter(item => item !== undefined);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    const copy = renderWorkerPlain(item, depth + 1);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}
function renderWorkerPick(value, fields) {
  if (!value) return null;
  const out = {};
  for (const key of fields) {
    const copy = renderWorkerPlain(value[key]);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}
function renderWorkerTextFrame(frame) {
  if (!frame) return null;
  const out = renderWorkerPick(frame, [
    'generation',
    'frameTimeMs',
    'layoutVersion',
    'W',
    'H',
    'viewportCss',
    'dpr',
    'drawKey',
    'clip',
    'lineRect',
    'caret',
    'trackX',
    'baseA',
    'baseLift',
    'groundEnabled',
    'paperValue',
    'inkColor',
    'animationModel',
  ]);
  out.runs = (frame.runs || frame.items || []).map(run =>
    renderWorkerPick(run, [
      'key',
      'id',
      'text',
      'x',
      'y',
      'width',
      'height',
      'opacity',
      'blur',
      'blurMix',
      'translateY',
      'dryAlpha',
      'inkColor',
      'underline',
    ]),
  );
  out.epoch = frame._epoch;
  return out;
}
function renderWorkerUIFrame(frame) {
  if (!frame) return null;
  const out = renderWorkerPick(frame, [
    'generation',
    'frameTimeMs',
    'layoutVersion',
    'atlasGeneration',
    'atlasEpoch',
    'W',
    'H',
    'viewportCss',
    'dpr',
    'box',
    'boxRuns',
    'sloganRuns',
    'swashes',
    'rule',
    'rawCaret',
    'meter',
    'seal',
    'cover',
    'animationModel',
  ]);
  out.epoch = frame._epoch;
  return out;
}
function renderWorkerViewport(provided) {
  return {
    width: Math.max(1, Number(provided?.width ?? (typeof innerWidth === 'number' ? innerWidth : 1))),
    height: Math.max(1, Number(provided?.height ?? (typeof innerHeight === 'number' ? innerHeight : 1))),
    dpr: Math.max(0.1, Number(provided?.dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1))),
  };
}
function renderWorkerWorldConfig(provided) {
  const current = provided || (typeof world === 'object' ? world : null);
  const out =
    renderWorkerPick(current, [
      'W',
      'H',
      'kc',
      'hero',
      'first',
      'seed',
      'mark',
      'read',
      'ls',
      'era',
      'dprGL',
      'cam',
      'D',
    ]) || {};
  if (out.era === undefined && typeof worldEra === 'number') out.era = worldEra;
  if (out.dprGL === undefined && typeof dprGL === 'number') out.dprGL = dprGL;
  if (out.cam === undefined && typeof springs === 'object') out.cam = springs.cam.x;
  if (out.D === undefined && typeof st === 'object') out.D = st.page.D;
  return out;
}
function renderWorkerControl(provided) {
  if (provided) return renderWorkerPlain(provided);
  if (typeof springs !== 'object' || typeof st !== 'object') return {};
  return {
    cam: springs.cam.x,
    clock: st.clock,
    paused: typeof TUNE === 'object' && !!TUNE.pause,
    speed: (typeof SPEED === 'number' ? SPEED : 1) * (typeof TUNE === 'object' ? TUNE.speed : 1),
    TRANS: typeof TRANS === 'object' ? renderWorkerPlain(TRANS) : {},
    LAB: typeof LAB === 'object' ? renderWorkerPlain(LAB) : {},
    closePan: typeof LAYERS === 'object' && typeof CLOSE === 'number' ? LAYERS[CLOSE].pan : 1,
    box: { w: springs.w.x, h: springs.h.x, D: st.box.D, t: st.box.t },
    target: st.target,
    time: st.time,
    worldEra,
    mouseTarget: st.mouseT.slice(),
    veilTarget: st.veilT,
    staticMode: typeof STATIC === 'string' ? STATIC : null,
    motion: renderWorkerMotion(),
  };
}
function renderWorkerMotion() {
  if (typeof CURVES !== 'object' || !springs.track || !Number.isFinite(st.camT)) return null;
  const spring = motion => ({
    x: motion.x,
    v: motion.v,
    target: motion.target,
    type: motion.cfg.type,
    k: motion.cfg.k,
    z: motion.cfg.z,
    tau: motion.cfg.tau,
    dur: motion.cfg.dur,
    from: motion.from,
    goal: motion.goal,
    t: motion.t,
    eventSet: motion.eventSet,
    eventShift: motion.eventShift,
    cfg: renderWorkerPlain(motion.cfg),
  });
  const frameTime =
    typeof document === 'object' && document.timeline && typeof document.timeline.currentTime === 'number'
      ? document.timeline.currentTime
      : performance.now();
  const curve = springs.cam.cfg,
    eased = curve.type === 'spring' || curve.type === 'exp';
  return {
    timeOrigin: performance.timeOrigin || 0,
    at: (performance.timeOrigin || 0) + frameTime,
    cam: { ...spring(springs.cam), camT: st.camT, lead: st.camLead, leadTime: eased ? curve.lead : 0 },
    track: spring(springs.track),
    w: spring(springs.w),
    h: spring(springs.h),
    vis: spring(springs.vis),
    meter: spring(st.meter),
    page: { ...spring(st.page.m), D: st.page.D, blendT: st.page.t, p: st.page.p },
    box: { ...spring(st.box.m), D: st.box.D, blendT: st.box.t, p: st.box.p },
  };
}
async function createRenderWorkerCompositor(canvas, options = {}) {
  const failed = options.onFatal;
  const unavailable = reason => {
    const error = Error(reason);
    failed?.(error);
    throw error;
  };
  if (
    typeof Worker !== 'function' ||
    typeof OffscreenCanvas !== 'function' ||
    typeof canvas?.transferControlToOffscreen !== 'function'
  )
    return unavailable('Worker / OffscreenCanvas unavailable');
  if (typeof options.url !== 'string' || !options.url) return unavailable('Render Worker URL unavailable');
  if (!options.generator?.url || typeof MessageChannel !== 'function')
    return unavailable('Generation Worker URL / MessageChannel unavailable');
  const originalVisibility = canvas.style?.visibility || '';
  let viewport = renderWorkerViewport(options.viewport),
    worker,
    transferred = false,
    activated = false,
    disposed = false,
    failure = null,
    failureNotified = false;
  const lifecycleWindow = options.lifecycleWindow || (typeof window === 'object' ? window : null);
  let pageExitError = null,
    cleanupDone = false;
  let ready = false,
    nextID = 0,
    nextStateSeq = 0,
    stateInFlight = 0,
    flushScheduled = false,
    firstFrameTimer = null;
  let pendingState = {},
    status = {
      valid: false,
      presented: false,
      lost: false,
      uploading: 0,
      meshPending: 0,
      uploadUrgent: false,
      tilePlanningLimit: 3,
    };
  const pendingStateBatches = [];
  let pendingDemo = null,
    forcedDemo = null,
    demoGeneration = 0,
    demoCancelAck = 0;
  const stateWaiters = [];
  const captureSetTimeout = options.captureSetTimeout || setTimeout,
    captureClearTimeout = options.captureClearTimeout || clearTimeout;
  function settledState() {
    if (
      demoCancelAck >= demoGeneration &&
      !stateInFlight &&
      !pendingStateBatches.length &&
      !Object.keys(pendingState).length
    )
      for (const waiter of stateWaiters.splice(0)) {
        captureClearTimeout(waiter.timer);
        waiter.resolve();
      }
  }
  async function captureState() {
    if (disposed || failure) throw failure || Error('Render Worker disposed');
    flushState();
    if (
      demoCancelAck < demoGeneration ||
      stateInFlight ||
      pendingStateBatches.length ||
      Object.keys(pendingState).length
    )
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = captureSetTimeout(() => {
          const i = stateWaiters.indexOf(waiter);
          if (i >= 0) stateWaiters.splice(i, 1);
          reject(Error('Capture state acknowledgement timed out'));
        }, options.rpcTimeout || 15000);
        stateWaiters.push(waiter);
      });
  }
  async function captureCommand(method, args = []) {
    await captureState();
    const result = await rpc(method, args);
    if (result?.state) Object.assign(status, result.state);
    return result;
  }
  let paperInfo = null,
    tileSnapshot = null,
    api = null,
    capabilities = null,
    visibilityDocument = null,
    visibilityHandler = null;
  const tickets = new Map(),
    textFrames = new Map(),
    uiFrames = new Map(),
    renderers = new Map(),
    tileWorkers = [];
  const uiRoomTickets = new Map();
  let publishedUIAtlas = null;
  const uiAtlasToken = value => ({
    atlasEpoch: value.atlasEpoch ?? value._epoch ?? value.epoch,
    atlasGeneration: value.atlasGeneration,
  });
  function wasAtlasPublished(value) {
    const token = uiAtlasToken(value);
    return (
      publishedUIAtlas?.atlasEpoch === token.atlasEpoch && publishedUIAtlas.atlasGeneration >= token.atlasGeneration
    );
  }
  function acquireUIRoom(settings, generation = demoGeneration) {
    if (disposed || failure) return Promise.reject(failure || Error('Render Worker disposed'));
    flushState();
    const id = ++nextID;
    return new Promise((resolve, reject) => {
      uiRoomTickets.set(id, { resolve, reject, generation });
      try {
        send({ type: 'ui-room-request', id, settings: renderWorkerPlain(settings), demoGeneration: generation });
      } catch (error) {
        uiRoomTickets.delete(id);
        reject(error);
      }
    });
  }
  const tilePorts = [],
    earlyGeneratorFailures = [],
    ownedPorts = new Set();
  let initSent = false,
    rebuildBudget = 1;
  let lastTextEvent = null,
    lastUIEvent = null,
    lastControlKey = '',
    lastControlAt = 0,
    lastParticleAt = 0,
    lastWorldKey = '',
    lastWorldAt = 0;
  function eventKey(frame) {
    return frame ? [frame._epoch, frame.generation].join('/') : null;
  }
  function controlKey() {
    if (typeof st !== 'object' || typeof springs !== 'object') return null;
    const rows = [
      st.camT,
      st.target,
      st.veilT,
      ...st.mouseT,
      TUNE.pause,
      TUNE.speed,
      CURVE_VER,
      worldEra,
      LAB.res,
      LAB.ground,
      LAB.drift,
      LAB.glass,
      typeof STATIC === 'string' ? STATIC : null,
    ];
    for (const motion of [springs.cam, springs.track, springs.w, springs.h, springs.vis, st.meter, st.page.m, st.box.m])
      rows.push(motion === springs.cam ? st.camT : motion.target, motion.eventSet, motion.eventShift);
    return rows.join('|');
  }
  const transport = {
    generationRebuilds: 0,
    generationFailures: 0,
    stateMessages: 0,
    stateCoalesced: 0,
    stateAcks: 0,
    frameAcks: 0,
    expiredFrameAcks: 0,
    rpcMessages: 0,
    bulkCrossThreadCopyBytes: 0,
    geometryCrossThreadBytes: 0,
    pixelCrossThreadBytes: 0,
    fontCrossThreadBytes: 0,
  };
  const config = {
    ...(renderWorkerPlain(options.plainOptions) || {}),
    mode: options.mode || 'worker',
    hash: options.hash ?? (typeof location === 'object' ? location.hash : ''),
    viewport,
    mainTimeOrigin: typeof performance.timeOrigin === 'number' ? performance.timeOrigin : 0,
  };
  const captureEnabledProxy = () =>
    /(?:^|&)capture=1(?:&|$)/.test(config.hash) && /(?:^|&)debug(?:&|$)/.test(config.hash);
  const absoluteNow = () => (performance.timeOrigin || 0) + performance.now();
  const errorOf = value =>
    value instanceof Error ? value : Error(String(value?.message || value || 'Render Worker failed'));
  function animationSamples(message) {
    const samples = message?.animationSamples || message?.diagnostics?.animationSamples;
    if (samples) {
      (options.textController || (typeof GPU_LINE === 'object' ? GPU_LINE : null))?.sample?.(samples.text);
      (options.uiController || (typeof GPU_UI === 'object' ? GPU_UI : null))?.sample?.(samples.ui);
    }
  }
  function diagnostic(message = {}) {
    animationSamples(message);
    if (message.state) Object.assign(status, renderWorkerPlain(message.state));
    const info = renderWorkerPlain(message.diagnostics || message.diag || {});
    if (info?.tileSnapshot) tileSnapshot = info.tileSnapshot;
    if (message.tileSnapshot) tileSnapshot = renderWorkerPlain(message.tileSnapshot);
    if (message.state?.tileSnapshot) tileSnapshot = renderWorkerPlain(message.state.tileSnapshot);
    if (typeof GPU_DIAG === 'object') {
      if (info) Object.assign(GPU_DIAG, info);
      GPU_DIAG.workerPresentation = {
        ...(GPU_DIAG.workerPresentation || {}),
        mode: 'worker',
        phase: failure ? 'failed' : status.presented ? 'presenting' : ready ? 'ready' : 'initializing',
        capabilities,
        valid: status.valid,
        presented: status.presented,
        lost: status.lost,
        transport: { ...transport },
        stateInFlight,
      };
    }
    const rings = message.state?.worldRings || message.worldRings;
    if (rings) {
      if (options.onWorldRings) options.onWorldRings(rings);
      else if (typeof world === 'object' && world.rings)
        for (const sc of ['zh', 'ja'])
          for (let li = 0; li < (rings[sc]?.length || 0); li++) {
            const target = world.rings[sc]?.[li],
              row = rings[sc][li];
            if (target && row) {
              if (Array.isArray(row.has)) target.has = row.has.slice();
              if (Array.isArray(row.want)) target.want = row.want.slice();
            }
          }
    }
    (options.onDiagnostics || options.onDiagnostic)?.(message, api);
  }
  function cleanup(error) {
    if (cleanupDone) return;
    cleanupDone = true;
    lifecycleWindow?.removeEventListener?.('pagehide', leavePage);
    clearTimeout(firstFrameTimer);
    firstFrameTimer = null;
    if (visibilityHandler) visibilityDocument.removeEventListener('visibilitychange', visibilityHandler);
    visibilityDocument = null;
    visibilityHandler = null;
    for (const ticket of tickets.values()) {
      clearTimeout(ticket.timer);
      ticket.reject(error);
    }
    tickets.clear();
    pendingState = {};
    pendingStateBatches.length = 0;
    pendingDemo = forcedDemo = null;
    stateInFlight = 0;
    for (const ticket of uiRoomTickets.values()) ticket.reject(error);
    uiRoomTickets.clear();
    for (const waiter of stateWaiters.splice(0)) {
      captureClearTimeout(waiter.timer);
      waiter.reject(error);
    }
    textFrames.clear();
    uiFrames.clear();
    worker?.terminate();
    for (const generator of tileWorkers) generator?.terminate();
    tileWorkers.length = 0;
    for (const port of ownedPorts) {
      try {
        port.close();
      } catch {}
    }
    ownedPorts.clear();
  }
  function leavePage() {
    if (disposed || failure) return;
    pageExitError = Error('Render Worker disposed on pagehide');
    pageExitError.code = 'SITE_PAGE_HIDDEN';
    disposed = true;
    ready = false;
    cleanup(pageExitError);
  }
  function notifyFailure() {
    if (!failureNotified) {
      failureNotified = true;
      failed?.(failure);
    }
  }
  function fail(error) {
    if (failure || disposed) return;
    failure = errorOf(error);
    status.lost = true;
    ready = false;
    cleanup(failure);
    diagnostic();
    notifyFailure();
  }
  function send(message, transfer) {
    if (disposed || failure) throw failure || Error('Render Worker disposed');
    worker.postMessage(message, transfer || []);
  }
  function generatorFailed(index, incarnation, error) {
    const generator = tileWorkers[index];
    if (!generator || generator.siteIncarnation !== incarnation || generator.siteFailed || disposed || failure) return;
    generator.siteFailed = true;
    generator.terminate();
    transport.generationFailures++;
    const message = { type: 'tile-thread-failed', index, incarnation, error: String(error?.message || error) };
    if (initSent) {
      try {
        send(message);
      } catch (problem) {
        fail(problem);
      }
    } else earlyGeneratorFailures.push(message);
  }
  function startGenerator(index) {
    const previous = tileWorkers[index],
      incarnation = (previous?.siteIncarnation || 0) + 1;
    previous?.terminate();
    const generator = new Worker(options.generator.url, { name: 'Tile generation ' + (index + 1) });
    generator.siteIncarnation = incarnation;
    tileWorkers[index] = generator;
    generator.onerror = event => {
      event.preventDefault?.();
      generatorFailed(index, incarnation, 'Tile generation thread: ' + (event.message || 'failed'));
    };
    generator.onmessageerror = () =>
      generatorFailed(index, incarnation, 'Generation Worker message could not be decoded');
    generator.onmessage = event => {
      if (event.data?.type === 'bootstrap-error') generatorFailed(index, incarnation, event.data.error);
    };
    const channel = new MessageChannel();
    ownedPorts.add(channel.port1);
    ownedPorts.add(channel.port2);
    generator.postMessage({
      type: 'bootstrap',
      config: {
        profile: options.config.profile,
        debug: options.config.debug,
        breakgen: options.config.breakgen,
        assets: { wasm: { tile: options.config.assets.wasm.tile } },
      },
    });
    generator.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
    return channel.port2;
  }
  function rebuildGenerator(index, reason, incarnation) {
    if (disposed || failure) return;
    if (!Number.isInteger(index) || index < 0 || index >= tileWorkers.length) {
      fail(Error('Invalid generation rebuild index'));
      return;
    }
    if (incarnation != null && incarnation !== tileWorkers[index]?.siteIncarnation) return;
    if (rebuildBudget <= 0) {
      fail(Error('Generation Worker failed after its one automatic rebuild: ' + reason));
      return;
    }
    rebuildBudget--;
    transport.generationRebuilds++;
    try {
      const port = startGenerator(index),
        incarnation = tileWorkers[index].siteIncarnation;
      send({ type: 'replace-tile-port', index, port, incarnation }, [port]);
      diagnostic();
    } catch (error) {
      fail(error);
    }
  }
  function request(type, payload, timeout, expected) {
    if (disposed || failure) return Promise.reject(failure || Error('Render Worker disposed'));
    return new Promise((resolve, reject) => {
      const id = ++nextID,
        timer = setTimeout(() => {
          tickets.delete(id);
          const error = Error('Render Worker ' + type + ' timed out');
          reject(error);
          if (activated) fail(error);
        }, timeout);
      tickets.set(id, { resolve, reject, timer, expected });
      try {
        send({ type, id, ...payload }, type === 'init' ? [payload.canvas, ...(payload.tilePorts || [])] : []);
      } catch (error) {
        clearTimeout(timer);
        tickets.delete(id);
        reject(error);
      }
    });
  }
  function rpc(method, args = [], generation = demoGeneration) {
    transport.rpcMessages++;
    return request(
      'rpc',
      { method, args, ...(method === 'ui.prepare' ? { demoGeneration: generation } : {}) },
      options.rpcTimeout || 60000,
      'rpc-result',
    );
  }
  function command(method, args = []) {
    return rpc(method, args).catch(error => {
      fail(error);
      return null;
    });
  }
  function remember(map, frame) {
    if (!frame) return;
    map.set(frame.generation, frame);
    while (map.size > 8) map.delete(map.keys().next().value);
  }
  function ack(map, value, controller, sample) {
    if (value === undefined || value === null) return;
    const generation = typeof value === 'number' ? value : value.generation;
    const frame = map.get(generation),
      epoch = typeof value === 'object' ? (value.epoch ?? value._epoch) : undefined;
    if (!frame || (epoch !== undefined && epoch !== frame._epoch)) {
      transport.expiredFrameAcks++;
      return;
    }
    controller?.ack?.(frame, sample);
    transport.frameAcks++;
    for (const key of map.keys()) if (key <= generation) map.delete(key);
  }
  function applyAcks(message) {
    ack(
      textFrames,
      message.textAck,
      options.textController || (typeof GPU_LINE === 'object' ? GPU_LINE : null),
      message.textSample,
    );
    ack(
      uiFrames,
      message.uiAck,
      options.uiController || (typeof GPU_UI === 'object' ? GPU_UI : null),
      message.uiSample,
    );
  }
  function flushState() {
    flushScheduled = false;
    if (
      !ready ||
      disposed ||
      failure ||
      demoCancelAck < demoGeneration ||
      stateInFlight ||
      (!pendingStateBatches.length && !Object.keys(pendingState).length)
    )
      return;
    const batch = pendingStateBatches.length ? pendingStateBatches.shift() : { state: pendingState, demo: pendingDemo };
    if (batch.state === pendingState) {
      pendingState = {};
      pendingDemo = null;
    }
    stateInFlight = ++nextStateSeq;
    try {
      send({
        type: 'state',
        seq: stateInFlight,
        state: batch.state,
        sentAt: absoluteNow(),
        ...(batch.demo ? { demo: batch.demo } : {}),
      });
      transport.stateMessages++;
    } catch (error) {
      fail(error);
    }
  }
  const demoKey = value => (value ? [value.generation, value.eventId, value.scheduledAt].join('/') : '');
  function demoMeta() {
    const value = forcedDemo || globalThis.SITE_DEMO_SCHEDULE?.pending?.();
    return value && value.generation === demoGeneration
      ? { generation: value.generation, eventId: value.eventId, scheduledAt: value.scheduledAt }
      : null;
  }
  function retainPendingState() {
    if (!Object.keys(pendingState).length) return;
    const last = pendingStateBatches.at(-1);
    if (last && demoKey(last.demo) === demoKey(pendingDemo)) Object.assign(last.state, pendingState);
    else {
      if (pendingStateBatches.length >= 64) throw Error('Scheduled demo state queue capacity exceeded');
      pendingStateBatches.push({ state: pendingState, demo: pendingDemo });
    }
    pendingState = {};
    pendingDemo = null;
  }
  function mergeState(value) {
    if (disposed || failure) return;
    const demo = demoMeta();
    if (demoKey(demo) !== demoKey(pendingDemo)) {
      try {
        retainPendingState();
      } catch (error) {
        fail(error);
        return;
      }
      pendingDemo = demo;
    }
    for (const [key, data] of Object.entries(value)) {
      if (key in pendingState) transport.stateCoalesced++;
      pendingState[key] = data;
    }
    if (demo && pendingState.control?.motion) pendingState.control.motion.at = demo.scheduledAt;
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushState);
    }
  }
  function facade(name, result) {
    let renderer = renderers.get(name);
    if (!renderer) {
      const metadata = {},
        state = { disposed: false };
      renderer = {
        metadata,
        workerAnimation: true,
        get ready() {
          return !state.disposed && metadata.ready !== false && ready && !failure;
        },
        get byteCount() {
          return metadata.byteCount || 0;
        },
        async prepare(specs, settings = {}) {
          if (state.disposed) throw Error('Remote ' + name + ' renderer disposed');
          let result;
          const generation = demoGeneration;
          for (let retry = 0; ; retry++) {
            if (name === 'ui' && metadata.atlasHandoffEnabled) {
              const room = await acquireUIRoom(settings, generation);
              Object.assign(metadata, room.metadata || {});
            }
            if (name === 'ui' && generation !== demoGeneration)
              throw Object.assign(Error('UI atlas preparation was cancelled'), { code: 'UI_ATLAS_CANCELLED' });
            try {
              result = await rpc(
                name + '.prepare',
                [renderWorkerPlain(specs), renderWorkerPlain(settings)],
                generation,
              );
              break;
            } catch (error) {
              if (name !== 'ui' || retry || error.code !== 'UI_ATLAS_ROOM_REQUIRED') throw error;
            }
          }
          Object.assign(metadata, result?.metadata || result || {});
          return result;
        },
        wasAtlasPublished,
        dispose() {
          if (state.disposed) return;
          state.disposed = true;
          metadata.ready = false;
          rpc(name + '.dispose').catch(() => {});
        },
      };
      renderers.set(name, renderer);
    }
    Object.assign(renderer.metadata, result?.metadata || result || {});
    return renderer;
  }
  try {
    lifecycleWindow?.addEventListener?.('pagehide', leavePage);
    worker = new Worker(options.url, { name: 'Scene render' });
    worker.postMessage({
      type: 'bootstrap',
      config: {
        profile: options.config.profile,
        debug: options.config.debug,
        assets: { wasm: { cpu: options.config.assets.wasm.cpu }, fonts: options.config.assets.fonts },
      },
    });
    worker.onmessage = event => {
      const message = event.data;
      if (!message || disposed || failure) return;
      if (message.type === 'ui-room-result') {
        const ticket = uiRoomTickets.get(message.id);
        if (!ticket) return;
        uiRoomTickets.delete(message.id);
        if (message.error) ticket.reject(Object.assign(errorOf(message.error), { code: message.errorCode }));
        else ticket.resolve(message.result);
        return;
      }
      if (message.type === 'demo-cancel-ack') {
        if (message.generation === demoGeneration) {
          const meta = message.uiMetadata,
            controller = options.uiController || (typeof GPU_UI === 'object' ? GPU_UI : null);
          if (meta) {
            Object.assign(renderers.get('ui')?.metadata || {}, meta);
            controller?.cancelAtlasPreparation?.(false);
            const retained = frame =>
              frame &&
              ((frame.atlasEpoch === meta.activeAtlasEpoch && frame.atlasGeneration === meta.activeAtlasGeneration) ||
                (frame.atlasEpoch === meta.readyAtlasEpoch && frame.atlasGeneration === meta.readyAtlasGeneration));
            for (const state of [pendingState, ...pendingStateBatches.map(batch => batch.state)])
              if (state.ui && !retained(state.ui)) delete state.ui;
            lastUIEvent = null;
          }
          demoCancelAck = message.generation;
          flushState();
          settledState();
        }
        return;
      }
      if (message.type === 'state-ack') {
        if (message.seq === stateInFlight) {
          stateInFlight = 0;
          transport.stateAcks++;
          flushState();
          settledState();
        }
        return;
      }
      if (message.type === 'failed' || message.type === 'fatal' || message.type === 'bootstrap-error') {
        fail(message.error);
        return;
      }
      if (message.type === 'generation-rebuild') {
        rebuildGenerator(message.index, message.error, message.incarnation);
        return;
      }
      if (message.type === 'presented' || message.type === 'frame-ack' || message.type === 'diagnostics') {
        if (message.type === 'presented' || message.presented || message.state?.presented) {
          status.presented = true;
          clearTimeout(firstFrameTimer);
          firstFrameTimer = null;
          if (canvas.style) canvas.style.visibility = originalVisibility;
        }
        applyAcks(message);
        diagnostic(message);
        return;
      }
      const ticket = tickets.get(message.id);
      if (!ticket || message.type !== ticket.expected) return;
      tickets.delete(message.id);
      clearTimeout(ticket.timer);
      if (message.error || message.ok === false)
        ticket.reject(
          Object.assign(errorOf(message.error || 'Worker capability probe failed'), { code: message.errorCode }),
        );
      else ticket.resolve(message.type === 'rpc-result' ? message.result : message);
    };
    worker.onerror = event => {
      event.preventDefault?.();
      fail(Error('Render Worker: ' + event.message));
    };
    worker.onmessageerror = () => fail(Error('Render Worker message could not be decoded'));
    for (let index = 0; index < 1; index++) {
      tilePorts[index] = startGenerator(index);
    }
    const probe = await request(
      'probe',
      { hash: config.hash, viewport, config },
      options.probeTimeout || 60000,
      'probe-result',
    );
    if (disposed || failure) throw pageExitError || failure || Error('Render Worker disposed');
    capabilities = renderWorkerPlain(probe.capabilities || {});
    if (probe.gpuFallbackReason && typeof GPU_DIAG === 'object')
      GPU_DIAG.workerFallbackReason = probe.gpuFallbackReason;
    const offscreen = canvas.transferControlToOffscreen();
    transferred = true;
    if (canvas.style) canvas.style.visibility = 'hidden';
    initSent = true;
    const initialization = request(
      'init',
      {
        canvas: offscreen,
        hash: config.hash,
        backend: probe.backend,
        viewport,
        config,
        tilePorts,
        tileIncarnations: tileWorkers.map(generator => generator.siteIncarnation),
      },
      options.initTimeout || 60000,
      'ready',
    );
    for (const message of earlyGeneratorFailures.splice(0)) send(message);
    const init = await initialization;
    if (disposed || failure) throw pageExitError || failure || Error('Render Worker disposed');
    paperInfo = renderWorkerPlain(init.paperInfo || null);
    ready = true;
    if (init.state) Object.assign(status, renderWorkerPlain(init.state));
    api = {
      kind: init.backend || probe.backend || 'webgpu',
      remoteWorker: true,
      maxTex: init.maxTex || init.limits?.maxTextureDimension2D || 8192,
      format: init.format,
      tilePreprocessLimits: renderWorkerPick(init.tilePreprocessLimits || init.limits || {}, [
        'maxTextureDimension2D',
        'maxStorageBufferBindingSize',
        'maxBufferSize',
      ]),
      get ready() {
        return ready && !disposed && !failure;
      },
      get valid() {
        return !!status.valid;
      },
      get presented() {
        return !!status.presented;
      },
      get lost() {
        return !!status.lost;
      },
      get uploading() {
        return status.uploading || 0;
      },
      get meshPending() {
        return status.meshPending || 0;
      },
      get uploadUrgent() {
        return !!status.uploadUrgent;
      },
      get tilePlanningLimit() {
        return status.tilePlanningLimit || 3;
      },
      get paperInfo() {
        return paperInfo;
      },
      get workerStatus() {
        return status;
      },
      get transport() {
        return transport;
      },
      statics() {
        return command('statics');
      },
      alloc(geo, settings) {
        return command('alloc', [
          (geo || []).map(g => renderWorkerPick(g, ['ts', 'T', 'n', 'R', 'Ht', 'pad', 'margin'])),
          renderWorkerWorldConfig(settings || options.getWorld?.()),
        ]);
      },
      world(settings) {
        const at = absoluteNow(),
          key = [settings?.era, settings?.dprGL].join('/');
        if (!captureEnabledProxy() && key === lastWorldKey && at - lastWorldAt < 1000) return;
        lastWorldKey = key;
        lastWorldAt = at;
        mergeState({ world: renderWorkerWorldConfig(settings) });
      },
      mountains(info) {
        return command('mountains', [
          renderWorkerWorldConfig(options.getWorld?.()),
          renderWorkerPick(info, ['Pw', 'Ph', 's', 'Pc']),
        ]);
      },
      resize(w, h, suppliedViewport) {
        viewport = renderWorkerViewport(suppliedViewport || options.getViewport?.());
        return command('resize', [w, h, viewport]);
      },
      setBackgroundResolution(settings) {
        return command('setBackgroundResolution', [renderWorkerPlain(settings)]);
      },
      setTileOpeningMode(enabled) {
        return command('setTileOpeningMode', [enabled === true]);
      },
      setVisible(visible) {
        if (disposed || failure) return;
        try {
          send({ type: 'visibility', visible: visible !== false });
        } catch (error) {
          fail(error);
        }
      },
      prepareTiles() {
        return rpc('prepareTiles');
      },
      prepareParticles() {
        return rpc('prepareParticles');
      },
      async prepareText() {
        return facade('text', await rpc('prepareText'));
      },
      async prepareUI() {
        return facade('ui', await rpc('prepareUI'));
      },
      setTextFrame(frame) {
        const key = eventKey(frame);
        if (key === lastTextEvent) return;
        lastTextEvent = key;
        remember(textFrames, frame);
        mergeState({ text: renderWorkerTextFrame(frame) });
      },
      setUIFrame(frame) {
        const key = eventKey(frame);
        if (key === lastUIEvent) return;
        lastUIEvent = key;
        if (frame?.atlasGeneration) {
          if (
            publishedUIAtlas?.atlasEpoch !== (frame.atlasEpoch ?? frame._epoch) ||
            publishedUIAtlas.atlasGeneration !== frame.atlasGeneration
          )
            publishedUIAtlas = uiAtlasToken(frame);
          (options.uiController || (typeof GPU_UI === 'object' ? GPU_UI : null))?.publish?.(frame);
        }
        remember(uiFrames, frame);
        mergeState({ ui: renderWorkerUIFrame(frame) });
      },
      queueDemoEvent(meta, text, ui) {
        if (
          !Number.isSafeInteger(meta?.generation) ||
          meta.generation !== demoGeneration ||
          !Number.isSafeInteger(meta.eventId) ||
          meta.eventId < 1 ||
          !Number.isFinite(meta.scheduledAt)
        )
          throw Error('Invalid scheduled demo event');
        forcedDemo = { generation: meta.generation, eventId: meta.eventId, scheduledAt: meta.scheduledAt };
        try {
          if (text) {
            remember(textFrames, text);
            lastTextEvent = eventKey(text);
          }
          if (ui) {
            remember(uiFrames, ui);
            lastUIEvent = eventKey(ui);
            publishedUIAtlas = uiAtlasToken(ui);
            (options.uiController || (typeof GPU_UI === 'object' ? GPU_UI : null))?.publish?.(ui);
          }
          const scene = {
            time: st.time,
            t: st.page.t,
            D: st.page.D,
            veil: st.veil,
            sway: reduceMotion || STILL ? 0 : 0.0022,
            mx: st.mouse[0],
            my: st.mouse[1],
            dpr: dprGL,
            cam: springs.cam.x,
          };
          mergeState({
            scene: renderWorkerPlain(scene),
            control: renderWorkerControl(),
            ...(text ? { text: renderWorkerTextFrame(text) } : {}),
            ...(ui ? { ui: renderWorkerUIFrame(ui) } : {}),
          });
          retainPendingState();
          flushState();
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          forcedDemo = null;
        }
      },
      cancelDemoSchedule(generation) {
        if (disposed || failure || generation === demoGeneration) return;
        if (!Number.isSafeInteger(generation) || generation < demoGeneration)
          throw Error('Invalid demo cancellation generation');
        demoGeneration = generation;
        pendingStateBatches.splice(0);
        pendingState = {};
        pendingDemo = forcedDemo = null;
        publishedUIAtlas = null;
        (options.uiController || (typeof GPU_UI === 'object' ? GPU_UI : null))?.cancelAtlasPreparation?.();
        const error = Object.assign(Error('UI atlas preparation was cancelled'), { code: 'UI_ATLAS_CANCELLED' });
        for (const [id, ticket] of uiRoomTickets)
          if (ticket.generation < generation) {
            uiRoomTickets.delete(id);
            ticket.reject(error);
          }
        try {
          send({ type: 'demo-cancel', generation });
        } catch (error) {
          fail(error);
        }
      },
      stepParticles(frame) {
        if (!captureEnabledProxy() && absoluteNow() - lastParticleAt < 1000) return true;
        lastParticleAt = absoluteNow();
        mergeState({ particle: renderWorkerPick(frame, ['dt', 'gust', 'pan', 'page', 'box']) });
        return true;
      },
      restoreParticles() {},
      finish() {
        return rpc('finish');
      },
      render(scene) {
        const key = controlKey(),
          at = absoluteNow();
        if (captureEnabledProxy() || !status.presented || key !== lastControlKey || at - lastControlAt >= 1000) {
          lastControlKey = key;
          lastControlAt = at;
          mergeState({
            scene: renderWorkerPick(scene, ['time', 't', 'D', 'veil', 'sway', 'mx', 'my', 'dpr', 'cam', 'view']),
            control: renderWorkerControl(scene?.control || options.getControl?.()),
          });
        }
        return !failure && !disposed;
      },
      uploadTiles() {},
      renderMesh() {},
      debugTileSnapshot() {
        return tileSnapshot;
      },
      async requestTileSnapshot() {
        tileSnapshot = await rpc('debugTileSnapshot');
        return tileSnapshot;
      },
      debugTile(spec) {
        return rpc('debugTile', [renderWorkerPlain(spec)]);
      },
      async captureFrame(now, advance = false) {
        const result = await captureCommand('captureFrame', [now, advance]);
        animationSamples(result);
        return result;
      },
      captureDrain() {
        return captureCommand('captureDrain');
      },
      ringPixels(sc, li) {
        return rpc('ringPixels', [sc, li]);
      },
      ringHash(sc, li) {
        return rpc('ringHash', [sc, li]);
      },
      abandon() {
        if (disposed || failure) return;
        status.lost = true;
        ready = false;
        disposed = true;
        cleanup(Error('Render Worker abandoned'));
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        ready = false;
        cleanup(Error('Render Worker disposed'));
      },
    };
    activated = true;
    visibilityDocument = options.visibilityDocument || (typeof document === 'object' ? document : null);
    if (visibilityDocument?.addEventListener) {
      visibilityHandler = () => api.setVisible(visibilityDocument.visibilityState !== 'hidden');
      visibilityDocument.addEventListener('visibilitychange', visibilityHandler);
      visibilityHandler();
    }
    diagnostic(init);
    flushState();
    return { api, replacementCanvas: null, reason: null };
  } catch (error) {
    if (pageExitError) {
      cleanup(pageExitError);
      throw pageExitError;
    }
    failure = errorOf(error);
    cleanup(failure);
    ready = false;
    notifyFailure();
    throw failure;
  }
}
