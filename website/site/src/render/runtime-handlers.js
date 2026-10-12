function acknowledge(kind, frame) {
  const generation = frame?.generation;
  if (generation == null || acked[kind] === generation) return;
  acked[kind] = generation;
  pendingFrameAck ||= { type: 'frame-ack' };
  pendingFrameAck[kind + 'Ack'] = generation;
  if (frame?.epoch !== undefined) pendingFrameAck[kind + 'Sample'] = frame;
}
let animationState = null,
  textAnimationFrame = null,
  uiAnimationFrame = null;
let receivedSceneState = null,
  workerDemoGeneration = -1,
  demoRevokeReady = null;
const demoStateKey = demo => (demo ? [demo.generation, demo.eventId, demo.scheduledAt].join('/') : '');
function enqueueRenderState(message) {
  let demo = message.demo;
  if (
    demo &&
    (!Number.isSafeInteger(demo.generation) ||
      !Number.isSafeInteger(demo.eventId) ||
      demo.eventId < 1 ||
      !Number.isFinite(demo.scheduledAt))
  )
    throw Error('Invalid scheduled demo state');
  if (demo && demo.generation < workerDemoGeneration) return;
  if (demo) workerDemoGeneration = demo.generation;
  const now = performance.now(),
    capture = captureEnabled();
  const future = stateQueue.at(-1);
  if (!demo && !capture && future?.demo) demo = future.demo;
  const next = { ...(demo ? receivedSceneState || sceneState : sceneState), ...message.state };
  if (demo && next.control?.motion)
    next.control = { ...next.control, motion: { ...next.control.motion, at: demo.scheduledAt } };
  receivedSceneState = next;
  const scheduledAt = demo && !capture ? demo.scheduledAt : performance.timeOrigin + now;
  if (!demo || capture) sceneState = next;
  if (
    message.state.scene ||
    Object.hasOwn(message.state, 'text') ||
    Object.hasOwn(message.state, 'ui') ||
    message.state.control
  ) {
    const last = stateQueue.at(-1),
      entry = { state: next, at: stateAt, scheduledAt, demo };
    if (demo && last?.demo && demoStateKey(demo) === demoStateKey(last.demo)) stateQueue[stateQueue.length - 1] = entry;
    else stateQueue.push(entry);
    while (stateQueue.length > 8) {
      const at = stateQueue.findIndex(value => !value.demo);
      if (at < 0) break;
      stateQueue.splice(at, 1);
    }
    if (stateQueue.length > 64) throw Error('Scheduled render state queue capacity exceeded');
  }
  if (message.state.world && !demo) {
    world.mark = message.state.world.mark || world.mark;
    world.read = message.state.world.read || world.read;
  }
  if (message.state.ui && (!demo || capture) && uiRenderer?.metadata.atlasHandoffEnabled)
    uiRenderer.noteAtlasPublication(message.state.ui);
}
function applyRenderState(entry) {
  drawState = sceneState = entry.state;
  drawAt = entry.at;
  if (drawState.world) {
    world.mark = drawState.world.mark || world.mark;
    world.read = drawState.world.read || world.read;
  }
  if (drawState.ui && uiRenderer?.metadata.atlasHandoffEnabled) uiRenderer.noteAtlasPublication(drawState.ui);
}
function cancelDemoStates(generation) {
  if (!Number.isSafeInteger(generation) || generation < workerDemoGeneration) return;
  workerDemoGeneration = generation;
  for (let i = stateQueue.length - 1; i >= 0; i--)
    if (stateQueue[i].demo && stateQueue[i].demo.generation !== generation) stateQueue.splice(i, 1);
  receivedSceneState = stateQueue.at(-1)?.state || sceneState;
  const meta = uiRenderer?.metadata,
    epoch = meta?.readyAtlasEpoch,
    atlasGeneration = meta?.readyAtlasGeneration;
  const matches = frame =>
    frame && (frame.atlasEpoch ?? frame.epoch) === epoch && frame.atlasGeneration === atlasGeneration;
  if (atlasGeneration != null && !matches(drawState?.ui) && !stateQueue.some(entry => matches(entry.state.ui)))
    demoRevokeReady = { atlasEpoch: epoch, atlasGeneration };
  refreshUIAtlasReferences();
  releaseCancelledDemoAtlas(true);
}
function releaseCancelledDemoAtlas(cancelWaiting = false) {
  const owner = uiRenderer,
    revoke = demoRevokeReady;
  if (!owner?.metadata.atlasHandoffEnabled) return;
  const matches =
    revoke &&
    owner.metadata.readyAtlasEpoch === revoke.atlasEpoch &&
    owner.metadata.readyAtlasGeneration === revoke.atlasGeneration;
  const released = owner.cancelAtlasRoom(revoke, cancelWaiting);
  if (!matches || released) demoRevokeReady = null;
}
function checkDemoPreparation(generation) {
  if (generation != null && generation < workerDemoGeneration)
    throw Object.assign(Error('UI atlas preparation was cancelled'), { code: 'UI_ATLAS_CANCELLED' });
}
async function uploadMountains() {
  const packet = await tilePainter.mountains(world.W, world.H, world.seed);
  try {
    comp.mountains(packet);
    world.mtn = { Pw: packet.Pw, Ph: packet.Ph, Pc: packet.Pc, s: packet.s };
  } finally {
    packet.release();
  }
}
function transShape() {
  const wide = sstep(1.1, 1.8, world.W / world.H || 1.6);
  return {
    F: TRANS.F * (1 + TRANS.wideF * wide),
    J: TRANS.J,
    L: Math.max(...LAYERS.map(layer => Math.abs(layer.lag))) * TRANS.lag + 0.01,
    slow: 1 + TRANS.wideT * wide,
  };
}
function hashBytes(bytes) {
  let hash = 2166136261;
  for (const value of bytes) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash.toString(16);
}
function setViewport(viewport) {
  if (!viewport) return;
  innerWidth = Math.max(1, viewport.width);
  innerHeight = Math.max(1, viewport.height);
  devicePixelRatio = viewport.dpr || 1;
}
function isCurrent(job) {
  return job.era === renderWorld.era && world.rings?.[job.sc]?.[job.li]?.want[job.slot] === job.k;
}
function worldWant(cam, D) {
  if (debugTileMode) return;
  const dom = D ? 'ja' : 'zh',
    transition = st.page.t > 0.0005,
    previous = worldWant.schedule;
  const sameEra = previous?.era === renderWorld.era,
    movement = sameEra ? cam - previous.cam : 0;
  const direction = Math.abs(movement) > 1e-8 ? Math.sign(movement) : sameEra ? previous.direction : 1;
  worldWant.schedule = { era: renderWorld.era, cam, direction };
  const spans = world.geo.map((g, li) => {
    const left = cam * LAYERS[li].pan * world.H,
      [margin0, margin1] = tileSpan(li, cam);
    const visible0 = Math.floor((left * g.ts) / g.T),
      visible1 = Math.ceil(((left + world.W) * g.ts) / g.T) - 1;
    const forward = direction * LAYERS[li].pan >= 0;
    return {
      visible0,
      visible1,
      ahead: forward ? visible1 + 1 : visible0 - 1,
      want0: margin0 - (forward ? 0 : 1),
      want1: margin1 + (forward ? 1 : 0),
    };
  });
  const activeScene = sc => sc === dom || transition;
  const priorityOfJob = job => {
    if (!activeScene(job.sc)) return 3;
    const span = spans[job.li];
    if (job.k >= span.visible0 && job.k <= span.visible1) return 0;
    return job.k === span.ahead ? 1 : 2;
  };
  let visibleMissing = 0;
  for (let li = 0; li < world.geo.length; li++) {
    const g = world.geo[li],
      span = spans[li];
    for (const sc of ['zh', 'ja']) {
      const ring = world.rings[sc][li];
      for (let slot = 0; slot < ring.want.length; slot++) {
        const wanted = ring.want[slot];
        if (Number.isFinite(wanted) && (wanted < span.want0 || wanted > span.want1)) ring.want[slot] = null;
      }
      for (let k = span.want0; k <= span.want1; k++) {
        const slot = ((k % g.n) + g.n) % g.n;
        if (ring.has[slot] === k) {
          ring.want[slot] = k;
          continue;
        }
        if (ring.want[slot] === k) continue;
        ring.want[slot] = k;
        world.jobs.push({ sc, li, k, slot, era: renderWorld.era });
      }
      if (activeScene(sc))
        for (let k = span.visible0; k <= span.visible1; k++)
          if (ring.has[((k % g.n) + g.n) % g.n] !== k) visibleMissing++;
    }
  }
  world.jobs = world.jobs.filter(isCurrent);
  for (const job of world.jobs) job.pri = priorityOfJob(job);
  const active = tilePainter?.activeJob;
  if (active) active.pri = priorityOfJob(active);
  comp?.reprioritizeTiles?.(priorityOfJob);
  if (
    active &&
    isCurrent(active) &&
    !activeScene(active.sc) &&
    visibleMissing &&
    tilePainter.cancel(active.era, active.id)
  ) {
    world.jobs.push({ sc: active.sc, li: active.li, k: active.k, slot: active.slot, era: active.era, pri: active.pri });
  }
}
function dispatch() {
  if (!tilePainter || !world.geo || disposed) return;
  const active = tilePainter.activeJob;
  if (active && !isCurrent(active)) tilePainter.cancel(active.era, active.id);
  if (!tilePainter.room) return;
  world.jobs = world.jobs.filter(isCurrent);
  world.jobs.sort((a, b) => a.pri - b.pri);
  if (!world.jobs.length) return;
  const job = world.jobs[0];
  job.id = ++nextJobID;
  job.t0 = performance.now();
  job.opening = opening;
  if (tilePainter.paint(job).accepted) world.jobs.shift();
}
function configureWorld(geo, config = {}) {
  renderConfig = { ...config };
  renderWorld.era = config.era ?? renderWorld.era + 1;
  Object.assign(world, {
    W: config.W || innerWidth,
    H: config.H || innerHeight,
    kc: config.kc ?? 1,
    hero: config.hero ?? 0,
    first: config.first,
    seed: config.seed,
    mark: config.mark || world.mark,
    read: config.read || world.read,
    geo,
  });
  world.rings = {};
  for (const sc of ['zh', 'ja'])
    world.rings[sc] = geo.map(g => ({ has: new Array(g.n).fill(null), want: new Array(g.n).fill(null) }));
  world.jobs = [];
  world.cur = null;
  comp.alloc(geo);
  tilePainter.init({
    era: renderWorld.era,
    W: world.W,
    H: world.H,
    kc: world.kc,
    hero: world.hero,
    first: world.first,
    seed: world.seed,
    s: config.dprGL || 1,
    maxTex: comp.maxTex,
    closePan: config.closePan ?? LAYERS[CLOSE].pan,
    stamps: param('stamps'),
    nativepaint: param('nativepaint'),
    objects: param('objects') === '1',
    resultRegions: param('tilebuffers') === '1' ? 1 : 2,
    tilePreprocess: {
      limits: comp.tilePreprocessLimits,
      gpuPreparation: comp.kind !== 'webgl2',
      convexInstancing: true,
    },
  });
  springs.cam.x = config.cam ?? springs.cam.x;
  lastCamera = springs.cam.x;
  st.page.D = config.D ?? st.page.D;
  worldWant(springs.cam.x, st.page.D);
  dispatch();
}
function stateSnapshot() {
  return {
    valid: !!comp?.valid,
    presented: !!comp?.presented,
    lost: !!comp?.lost,
    uploading: (comp?.uploading || 0) + (tilePainter?.stats.inFlight || 0) + world.jobs.length,
    uploadUrgent: !!comp?.uploadUrgent || world.jobs.some(job => job.pri === 0) || tilePainter?.activeJob?.pri === 0,
    meshPending: comp?.meshPending || 0,
    era: renderWorld.era,
  };
}
let lastStateKey = '';
function report(force = false) {
  const now = performance.now(),
    state = stateSnapshot();
  const key =
    (state.valid ? 1 : 0) +
    (state.presented ? 2 : 0) +
    (state.lost ? 4 : 0) +
    (state.uploading ? 8 : 0) +
    (state.uploadUrgent ? 16 : 0) +
    (state.meshPending ? 32 : 0) +
    ':' +
    state.era;
  if (!force && now - lastDiagnostic < 1000) {
    if (key !== lastStateKey) {
      lastStateKey = key;
      self.postMessage({ type: 'diagnostics', state });
    }
    return;
  }
  lastDiagnostic = now;
  lastStateKey = key;
  if (!SITE_DEBUG) {
    self.postMessage({
      type: 'diagnostics',
      state,
      animationSamples: { text: textAnimationFrame, ui: uiAnimationFrame },
    });
    return;
  }
  const { samples, meshTimings, meshSlices, tileJobs, ...small } = GPU_DIAG;
  self.postMessage({
    type: 'diagnostics',
    diagnostics: {
      ...small,
      presentationRing: comp?.debugPresentationSnapshot?.(),
      frameDiagnostics: workerFrames.snapshot(),
      localTiles: tilePainter?.snapshot(),
      renderThread: 'worker',
      tileThread: 'generation',
      bulkCrossThreadCopyBytes: tilePainter?.stats.copyBytes || 0,
    },
    state,
    worldRings: world.rings,
    tileSnapshot: comp?.debugTileSnapshot?.(),
    animationSamples: { text: textAnimationFrame, ui: uiAnimationFrame },
  });
}
let renderCanvas = null,
  renderConfig = null,
  rendererReady = false,
  deviceRebuilds = 0,
  gpuRecovering = false,
  gpuRecovery = null;
let preparedParticles = false,
  preparedTextArgs = null,
  preparedUIArgs = null,
  lastResize = null,
  lastBackgroundResolution = null;
let uiAtlasCapture = false;
const uiAtlasFuture = [],
  uiAtlasQueueFrame = entry => entry.state.ui;
function refreshUIAtlasReferences() {
  if (!uiRenderer?.metadata.atlasHandoffEnabled || gpuRecovering || disposed) return;
  uiAtlasFuture.length = 0;
  uiAtlasFuture.push(uiAtlasCapture ? sceneState?.ui : drawState?.ui);
  if (!uiAtlasCapture) for (const entry of stateQueue) uiAtlasFuture.push(entry.state.ui);
  uiRenderer.setAtlasReferences(uiAtlasFuture);
}
async function requestUIAtlasRoom(message) {
  for (let retry = 0; ; retry++) {
    try {
      if (gpuRecovering) await gpuRecovery;
      if (disposed) throw Error('Renderer disposed');
      const owner = uiRenderer;
      if (!owner) throw Error('UI renderer is unavailable');
      checkDemoPreparation(message.demoGeneration);
      releaseCancelledDemoAtlas();
      const result = await owner.acquireAtlasRoom(message.settings);
      checkDemoPreparation(message.demoGeneration);
      if (owner !== uiRenderer) {
        if (!retry) continue;
        throw Error('UI atlas owner changed twice');
      }
      self.postMessage({ type: 'ui-room-result', id: message.id, result: { ...result, metadata: owner.metadata } });
      return;
    } catch (error) {
      if (!disposed && !retry && (gpuRecovering || error.code === 'UI_ATLAS_OWNER_DISPOSED')) {
        if (gpuRecovering) await gpuRecovery;
        continue;
      }
      self.postMessage({
        type: 'ui-room-result',
        id: message.id,
        error: String(error?.message || error),
        errorCode: error.code,
      });
      return;
    }
  }
}
function fatal(error) {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(rafID);
  tilePainter?.dispose();
  try {
    comp?.abandon?.();
  } catch {}
  GPU_DIAG.state = 'failed';
  GPU_DIAG.error = String(error?.message || error);
  self.postMessage({ type: 'fatal', error: String(error?.stack || error) });
}
async function rebuildDevice() {
  gpuRecovering = true;
  cancelAnimationFrame(rafID);
  GPU_DIAG.deviceRebuilds = ++deviceRebuilds;
  const old = comp,
    geo = world.geo,
    config = renderConfig && { ...renderConfig },
    textEnabled = GPU_LINE.enabled,
    uiEnabled = GPU_UI.enabled;
  const uiReplay = uiRenderer?.metadata.atlasHandoffEnabled ? uiRenderer.snapshotAtlasHandoff() : null;
  try {
    old.restoreParticles();
    old.abandon();
    old.dispose();
    const next = await (selectedBackend === 'webgl2'
      ? createWebGL2(renderCanvas, failure)
      : createWebGPU(renderCanvas, failure));
    if (!next) throw Error(GPU_DIAG.error || 'Render device rebuild failed');
    if (disposed) {
      next.dispose();
      return;
    }
    comp = next;
    comp.setTileOpeningMode(opening);
    await comp.prepareTiles({ stampField: () => tilePainter.stampField() });
    const paper = await GPU_STARTUP.paper();
    comp.statics(paper);
    if (lastBackgroundResolution !== null) comp.setBackgroundResolution(lastBackgroundResolution);
    if (lastResize) comp.resize(...lastResize);
    if (preparedParticles) await comp.prepareParticles(null);
    if (textEnabled) {
      textRenderer = await comp.prepareText();
      if (preparedTextArgs) await textRenderer.prepare(...preparedTextArgs);
    }
    if (uiEnabled) {
      uiRenderer = await comp.prepareUI();
      if (uiReplay) await uiRenderer.restoreAtlasHandoff(uiReplay);
      else if (preparedUIArgs) await uiRenderer.prepare(...preparedUIArgs);
    }
    if (geo && config) {
      configureWorld(geo, { ...config, era: renderWorld.era + 1, cam: springs.cam.x, D: st.page.D });
      await uploadMountains();
    }
    notifiedValid = false;
    acked.text = acked.ui = null;
    pendingFrameAck = null;
    lastRAF = 0;
    GPU_DIAG.deviceRecovery = {
      attempts: deviceRebuilds,
      state: 'rebuilt',
      particleState: 'deterministic-current-region-reset',
    };
    gpuRecovering = false;
    if (uiRenderer?.metadata.atlasHandoffEnabled) {
      const shown = uiAtlasCapture ? sceneState?.ui : drawState?.ui;
      if (shown) uiRenderer.noteAtlasPublication(shown);
      refreshUIAtlasReferences();
      releaseCancelledDemoAtlas();
    }
    report(true);
    if (visible && !disposed && !captureEnabled() && !debugTileMode) rafID = requestAnimationFrame(frame);
  } catch (error) {
    gpuRecovering = false;
    fatal(error);
  }
}
let lastRebuildAt = -1e9,
  quickLosses = 0;
function failure(error) {
  if (disposed) return;
  if (rendererReady && !gpuRecovering && String(error?.message || error).startsWith('device.lost:')) {
    const at = performance.now();
    quickLosses = at - lastRebuildAt < 10000 ? quickLosses + 1 : 0;
    lastRebuildAt = at;
    if (quickLosses < 3) {
      gpuRecovery = rebuildDevice();
      return;
    }
  }
  fatal(error);
}
let textShift = 0;
function currentScene(now, driven, capture) {
  const latest = drawState.scene;
  if (!latest) return null;
  const control = drawState.control || {};
  animationState = EVENT_ANIMATION.update(control, latest, now, capture);
  textShift = 0;
  const cam = animationState.scene.cam ?? control.cam;
  springs.cam.x = Number.isFinite(cam) ? cam : springs.cam.x;
  return { ...animationState.scene, view: worldView(springs.cam.x) };
}
const pace = {
  gaps: [],
  last: 0,
  tick: 0,
  divisor: 1,
  skip(now) {
    const gap = this.last ? now - this.last : 0;
    this.last = now;
    if (gap > 3 && gap < 40 && this.gaps.push(gap) >= 30) {
      this.gaps.sort((a, b) => a - b);
      const refreshMs = this.gaps[15];
      this.gaps.length = 0;
      this.divisor = Math.max(1, Math.round(Number(param('pace')) || 1));
      GPU_DIAG.framePacing = { refreshMs, divisor: this.divisor };
    }
    return ++this.tick % this.divisor !== 0;
  },
};
let drivenAt = -1e9;
const driveByState = () => param('drive') === 'main';
function frame(now, driven, captureMode) {
  if (disposed || gpuRecovering || !visible) return;
  if (debugTileMode) return;
  if (captureEnabled() && !captureMode) return;
  if (driven === true) drivenAt = now;
  else {
    rafID = requestAnimationFrame(frame);
    if (now - drivenAt < 100) return;
    if (ownCadence.add(now) && stateCadence.mean) {
      const ratio = (ownCadence.mean * pace.divisor) / stateCadence.mean;
      cadenceMismatch = Math.max(0, Math.min(4, cadenceMismatch + (ratio < 0.97 ? 1 : -1)));
      GPU_DIAG.frameDrive = { ownMs: ownCadence.mean, stateMs: stateCadence.mean, byState: driveByState() };
    }
  }
  if (!refreshWindowAt) refreshWindowAt = now;
  else if (++refreshWindowCount >= 30) {
    const hz = (refreshWindowCount * 1000) / (now - refreshWindowAt),
      previous = GPU_DIAG.refreshObserved?.fastestNativeWindowHz || 0;
    GPU_DIAG.refreshObserved = {
      fastestNativeWindowHz: Math.max(previous, hz),
      latestNativeWindowHz: hz,
      callbacksPerWindow: 30,
      notPresentationFPS: true,
    };
    refreshWindowAt = now;
    refreshWindowCount = 0;
  }
  if (driven !== true && pace.skip(now)) return;
  workerFrames.markWorkerRAF(now);
  const __p = PROBE.begin(now);
  const interval = lastRAF ? now - lastRAF : 0;
  if (interval >= 4 && interval <= 34) {
    if (interval <= frameCadenceMs * 1.25) {
      frameCadenceMs = frameCadenceMs * 0.9 + interval * 0.1;
      slowCadenceCount = 0;
      slowCadenceMs = 0;
    } else {
      if (slowCadenceCount && Math.abs(interval - slowCadenceMs) > slowCadenceMs * 0.2) {
        slowCadenceCount = 0;
        slowCadenceMs = 0;
      }
      slowCadenceMs += (interval - slowCadenceMs) / ++slowCadenceCount;
      if (slowCadenceCount >= 10) {
        frameCadenceMs = slowCadenceMs;
        slowCadenceCount = 0;
        slowCadenceMs = 0;
      }
    }
  } else {
    slowCadenceCount = 0;
    slowCadenceMs = 0;
  }
  comp?.setFrameCadence?.(frameCadenceMs);
  const start = performance.now(),
    dt = captureMode
      ? Math.max(0, Math.min(0.05, drawState?.particle?.dt || 0))
      : Math.max(0, Math.min(0.05, interval / 1000));
  lastRAF = now;
  comp?.presentFrame?.();
  if (stateQueue.length && stateQueue[0].scheduledAt <= performance.timeOrigin + now) {
    while (
      stateQueue.length > 3 &&
      !stateQueue[0].demo &&
      !stateQueue[1].demo &&
      stateQueue[1].scheduledAt <= performance.timeOrigin + now
    )
      stateQueue.shift();
    refreshUIAtlasReferences();
    const next = stateQueue.shift();
    applyRenderState(next);
    while (
      next.demo &&
      stateQueue[0]?.demo &&
      stateQueue[0].demo.generation === next.demo.generation &&
      stateQueue[0].scheduledAt === next.scheduledAt
    )
      applyRenderState(stateQueue.shift());
  }
  let submitted = false,
    __sceneAt = 0,
    __uploadAt = 0;
  if (comp && drawState?.scene && world.geo && world.mtn) {
    const control = drawState.control || {};
    comp.setTilePrewarmMode(control.paused === true);
    Object.assign(TRANS, control.TRANS || {});
    Object.assign(LAB, control.LAB || {});
    LAYERS[CLOSE].pan = control.closePan ?? LAYERS[CLOSE].pan;
    const scene = currentScene(now, driven === true, !!captureMode);
    st.page.D = scene.D;
    st.page.t = scene.t;
    if (animationState.box) Object.assign(st.box, animationState.box);
    if (animationState.input) {
      springs.w.x = animationState.input.w;
      springs.h.x = animationState.input.h;
    }
    worldWant(springs.cam.x, st.page.D);
    const active = tilePainter.activeJob;
    if (active && !isCurrent(active)) tilePainter.cancel(active.era, active.id);
    textAnimationFrame = EVENT_ANIMATION.evaluate('text', drawState.text, now, animationState.trackX, !!captureMode);
    uiAnimationFrame = EVENT_ANIMATION.evaluate('ui', drawState.ui, now, animationState.input, !!captureMode);
    if (uiAnimationFrame && uiRenderer) GPU_UI.enabled = true;
    comp.setTextFrame(textAnimationFrame);
    comp.setUIFrame(uiAnimationFrame);
    if (comp.frameRoom !== false) {
      if (param('still') === null && (!captureMode || captureMode.advance)) {
        const updated = comp.stepParticles({
          dt: control.paused ? 0 : dt,
          gust: animationState.gust ?? drawState.particle?.gust ?? 1,
          pan: (springs.cam.x - lastCamera) * world.H,
          page: st.page,
          box: st.box,
          rect: uiAnimationFrame?.box,
        });
        if (SITE_DEBUG) {
          const q = uiAnimationFrame?.box;
          GPU_DIAG.particleBox = q
            ? {
                x: q.x,
                y: q.y,
                width: q.width,
                height: q.height,
                scale: q.scale,
                opacity: q.opacity,
                driftW: drift.w,
                driftH: drift.h,
                worldW: world.W,
                worldH: world.H,
              }
            : null;
        }
        if (!updated) {
          const weight = (kind, x) => (kind === 'leaf' ? 1 - scene.D : scene.D);
          drift.pan((springs.cam.x - lastCamera) * world.H);
          drift.step(control.paused ? 0 : dt, weight, animationState.gust ?? drawState.particle?.gust ?? 1);
          boxDrift.step(control.paused ? 0 : dt, weight, 1);
        }
      }
      lastCamera = springs.cam.x;
    }
    comp.beginFrame();
    __sceneAt = performance.now();
    submitted = comp.render(scene) === true;
    const __sceneEnd = performance.now();
    PROBE.set(__p, 6, __sceneEnd - __sceneAt);
    PROBE.set(__p, 4, __sceneEnd - stateAt);
    PROBE.set(__p, 5, springs.cam.x);
    PROBE.set(__p, 22, scene.D);
    PROBE.set(__p, 23, scene.t);
    PROBE.set(__p, 24, drawState.ui?.generation || 0);
    PROBE.set(__p, 25, drawState.text?.generation || 0);
    PROBE.queueDone(__p, 12, comp.queue, __sceneEnd);
    GPU_HOLD.frame(now, springs.cam.x);
    GPU_DIAG.hold = GPU_HOLD.stats;
    if (comp.frameRoom !== false) {
      __uploadAt = performance.now();
      comp.uploadTiles();
      comp.endFrame();
      const __uploadEnd = performance.now();
      PROBE.set(__p, 7, __uploadEnd - __uploadAt);
      PROBE.queueDone(__p, 13, comp.queue, __uploadEnd);
      dispatch();
      const backlog = GPU_DIAG.tileBacklog,
        missing = backlog?.visibleMissing || 0,
        age = backlog?.visibleAgeMs || 0;
      const forward = tilePainter.activeJob?.pri === 1;
      const producerCPUms = opening
        ? 12
        : missing
          ? Math.max(missing >= 4 ? 8 : 4, age >= 1500 ? 20 : age >= 500 ? 12 : 0)
          : backlog?.wantedMissing
            ? control.paused
              ? 8
              : forward
                ? 6
                : 2
            : 1;
      GPU_DIAG.producerBudget = { cpuMs: producerCPUms, maxSteps: 16384, visibleMissing: missing, visibleAgeMs: age };
      const __producerAt = performance.now(),
        __active = tilePainter.activeJob;
      tilePainter.step({ maxCPUms: producerCPUms, maxSteps: 16384, opening });
      PROBE.done(__p, 8, __producerAt);
      PROBE.set(__p, 9, producerCPUms);
      PROBE.set(__p, 19, __active ? 1 + __active.li + 10 * (__active.sc === 'ja') + 100 * __active.pri : 0);
      dispatch();
    }
    comp.endFrame();
    refreshUIAtlasReferences();
    if (comp.valid && comp.presented && !notifiedValid) {
      notifiedValid = true;
      self.postMessage({ type: 'presented', state: stateSnapshot() });
      report(true);
    }
  } else if (comp && world.geo) {
    comp.uploadTiles();
    dispatch();
    tilePainter.step({ maxCPUms: 12, maxSteps: 16384, opening: true });
    dispatch();
  }
  if (pendingFrameAck) {
    self.postMessage(pendingFrameAck);
    pendingFrameAck = null;
  }
  const __backlog = GPU_DIAG.tileBacklog || {};
  PROBE.set(__p, 14, __backlog.visibleMissing || 0);
  PROBE.set(__p, 15, __backlog.wantedMissing || 0);
  PROBE.set(__p, 16, __backlog.level || 0);
  PROBE.set(__p, 17, __backlog.lastFrameEstimatedGPUms || 0);
  PROBE.set(__p, 18, __backlog.lastFrameUploadBytes || 0);
  PROBE.set(__p, 20, GPU_DIAG.tileSubmission?.pending || 0);
  PROBE.set(__p, 21, GPU_DIAG.timings?.total || 0);
  PROBE.done(__p, 11, start);
  workerFrames.recordCPUms(performance.now() - start);
  const __reportAt = performance.now();
  report();
  PROBE.done(__p, 10, __reportAt);
  return submitted;
}
async function probe(message) {
  HASH = message.hash || '';
  const requested = param('renderer') || 'auto',
    forceGL = ['webgl', 'webgl2', 'gl'].includes(requested),
    forceGPU = requested === 'webgpu';
  const capabilities = {
    offscreenCanvas: typeof OffscreenCanvas === 'function',
    workerRAF: typeof requestAnimationFrame === 'function',
    workerWebGPU: !!navigator.gpu,
    workerWebGL2: false,
  };
  let device,
    context,
    gpuError = null;
  try {
    if (!capabilities.offscreenCanvas || !capabilities.workerRAF)
      throw Error('Worker canvas / animation APIs unavailable');
    await new Promise((resolve, reject) => {
      try {
        requestAnimationFrame(resolve);
      } catch (error) {
        reject(error);
      }
    });
    if (!forceGL && (param('nowebgpu') === null || forceGPU)) {
      try {
        if (!capabilities.workerWebGPU) throw Error('Worker WebGPU unavailable');
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
        if (!adapter) throw Error('No Worker WebGPU adapter');
        device = await adapter.requestDevice();
        context = new OffscreenCanvas(1, 1).getContext('webgpu');
        if (!context) throw Error('OffscreenCanvas WebGPU context unavailable');
        context.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        });
        context.getCurrentTexture();
        context.unconfigure();
        device.destroy();
        context = null;
        device = null;
        selectedBackend = 'webgpu';
        self.postMessage({ type: 'probe-result', id: message.id, ok: true, backend: selectedBackend, capabilities });
        return;
      } catch (error) {
        gpuError = String(error.message || error);
        context?.unconfigure();
        device?.destroy();
        context = null;
        device = null;
        if (forceGPU) throw error;
      }
    }
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl) throw Error('Worker WebGL2 context unavailable' + (gpuError ? '; ' + gpuError : ''));
    capabilities.workerWebGL2 = true;
    capabilities.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    selectedBackend = 'webgl2';
    self.postMessage({
      type: 'probe-result',
      id: message.id,
      ok: true,
      backend: selectedBackend,
      gpuFallbackReason: gpuError,
      capabilities,
    });
  } catch (error) {
    context?.unconfigure();
    device?.destroy();
    self.postMessage({
      type: 'probe-result',
      id: message.id,
      ok: false,
      error: String(error.message || error),
      capabilities,
    });
  }
}
const lostTileThreads = new Map(),
  pendingTilePorts = new Map();
function tileConsumerRoom() {
  return (opening ? 2 : Math.max(2, Math.min(6, comp.tilePlanningLimit || 2))) - (comp.meshPending || 0);
}
function requeueTile(job) {
  if (
    job &&
    isCurrent(job) &&
    !world.jobs.some(
      old => old.era === job.era && old.sc === job.sc && old.li === job.li && old.k === job.k && old.slot === job.slot,
    )
  )
    world.jobs.push({ sc: job.sc, li: job.li, k: job.k, slot: job.slot, era: job.era, pri: job.pri });
}
function replaceTilePort(message) {
  const index = message.index || 0;
  if (disposed) {
    try {
      message.port?.close();
    } catch {}
    return;
  }
  lostTileThreads.delete(index);
  if (tilePainter) {
    const replacement = tilePainter.replacePort(index, message.port, message.incarnation);
    if (replacement.accepted) {
      requeueTile(replacement.job);
      dispatch();
    }
    return;
  }
  const previous = pendingTilePorts.get(index);
  if (previous && message.incarnation <= previous.incarnation) {
    try {
      message.port?.close();
    } catch {}
    return;
  }
  if (previous)
    try {
      previous.port.close();
    } catch {}
  pendingTilePorts.set(index, { port: message.port, incarnation: message.incarnation });
}
function remoteTilePainter(ports, incarnations) {
  return createRemoteTilePainter({
    ports,
    incarnations,
    isCurrent,
    capacity: tileConsumerRoom,
    onMesh: ({ job, mesh, ms }) => {
      if (debugTileMode) {
        const arrays = {};
        for (const [key, value] of Object.entries(mesh))
          if (ArrayBuffer.isView(value)) arrays[key] = { length: value.length, byteLength: value.byteLength };
        const plan = mesh.preprocessed,
          operations = {};
        if (plan?.opData)
          for (let i = 0; i < plan.opData.length; i += 12) {
            const kind = plan.opData[i];
            operations[kind] = (operations[kind] || 0) + 1;
          }
        const delivery = mesh.delivery;
        debugTilePacket = {
          arrays,
          operations,
          stats: mesh.stats || null,
          preprocessedStats: plan?.stats || null,
          workerTimings: mesh.workerTimings || null,
          delivery: delivery
            ? {
                shared: !!delivery.shared,
                usedBytes: delivery.usedBytes,
                bulkCrossThreadCopyBytes: delivery.bulkCrossThreadCopyBytes,
                copyMs: delivery.copyMs,
              }
            : null,
        };
      }
      comp.queueMesh(job, mesh, ms);
    },
    onReady: () => dispatch(),
    onRebuildRequest: ({ index, job, error, incarnation }) => {
      requeueTile(job);
      self.postMessage({ type: 'generation-rebuild', index, incarnation, error: String(error?.stack || error) });
    },
    onFatal: fatal,
  });
}
async function initialize(message) {
  HASH = message.hash || '';
  uiAtlasCapture = captureEnabled();
  setViewport(message.viewport);
  renderCanvas = message.canvas;
  if (captureEnabled()) {
    let seed = Number(param('captureseed')) >>> 0;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let n = seed;
      n = Math.imul(n ^ (n >>> 15), n | 1);
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    };
  }
  selectedBackend = message.backend || selectedBackend;
  let constructing = true,
    startError = null;
  const rendererFailure = error => {
    if (constructing) startError = error;
    else failure(error);
  };
  try {
    comp = await (selectedBackend === 'webgl2'
      ? createWebGL2(message.canvas, rendererFailure)
      : createWebGPU(message.canvas, rendererFailure));
    if (startError && comp) {
      comp.dispose();
      comp = null;
    }
    if (
      !comp &&
      selectedBackend === 'webgpu' &&
      param('renderer') !== 'webgpu' &&
      GPU_DIAG.canvasContext !== 'webgpu'
    ) {
      GPU_DIAG.workerFallbackReason = String(
        startError?.message || GPU_DIAG.error || 'WebGPU renderer preparation failed',
      );
      selectedBackend = 'webgl2';
      startError = null;
      comp = await createWebGL2(message.canvas, rendererFailure);
    }
    if (!comp || startError) throw startError || Error(GPU_DIAG.error || 'Worker renderer initialization failed');
  } finally {
    constructing = false;
  }
  GPU_DIAG.backend = comp.kind;
  GPU_DIAG.state = (comp.kind === 'webgl2' ? 'WebGL2' : 'WebGPU') + ' / initializing';
  comp.setTileOpeningMode(true);
  const ports = [...(message.tilePorts || [])],
    incarnations = [...(message.tileIncarnations || [])];
  for (const [index, replacement] of pendingTilePorts) {
    if (index >= ports.length) {
      replacement.port.close();
      continue;
    }
    try {
      ports[index]?.close();
    } catch {}
    ports[index] = replacement.port;
    incarnations[index] = replacement.incarnation;
  }
  pendingTilePorts.clear();
  tilePainter = remoteTilePainter(ports, incarnations);
  for (const [index, failed] of lostTileThreads) tilePainter.lose(index, failed.error, failed.incarnation);
  lostTileThreads.clear();
  const paperTask = GPU_STARTUP.paper();
  const [, , paper] = await Promise.all([
    loadEmbeddedFonts(),
    comp.prepareTiles({ stampField: () => tilePainter.stampField() }),
    paperTask,
  ]);
  comp.statics(paper);
  EVENT_ANIMATION.initialize();
  const dummy = { width: 1, height: 1, getContext: () => null };
  drift = new Drift(
    dummy,
    { leaf: [20, 56], petal: [7, 15], alpha: 0.9, speed: (message.config?.reduceMotion ? 0.5 : 1) * 1.1 },
    true,
  );
  boxDrift = new Drift(
    { ...dummy },
    {
      leaf: [30, 46],
      petal: [8, 12],
      alpha: 0.2,
      speed: 0.36,
      region: () => ({
        x0: 400 - springs.w.x / 2,
        x1: 400 + springs.w.x / 2,
        y0: 160 - springs.h.x / 2,
        y1: 160 + springs.h.x / 2,
      }),
    },
    true,
  );
  drift.resize(innerWidth, innerHeight, Math.min(2, devicePixelRatio));
  boxDrift.resize(800, 320, Math.min(2, devicePixelRatio));
  const area = clamp((innerWidth * innerHeight) / (1440 * 900), 0.45, 1.5) * (message.config?.reduceMotion ? 0.35 : 1),
    scale = Math.sqrt(innerWidth * innerHeight) / 1100;
  drift.seed('leaf', Math.round(29.16 * area), scale, () => 1);
  drift.seed('petal', Math.round(81.97 * area), scale, () => 0);
  boxDrift.seed('leaf', 6, 1, () => 1);
  boxDrift.seed('petal', 9, 1, () => 0);
  rendererReady = true;
  self.postMessage({
    type: 'ready',
    id: message.id,
    backend: comp.kind,
    maxTex: comp.maxTex,
    format: comp.format,
    limits: comp.tilePreprocessLimits,
    paperInfo: { width: paper.width, height: paper.height, pap: paper.pap },
    diagnostics: { ...GPU_DIAG, samples: [] },
  });
  if (!captureEnabled()) rafID = requestAnimationFrame(frame);
}
async function debugTile(spec) {
  if (param('debug') === null) throw Error('debugTile requires #debug');
  if (!tilePainter?.remote) throw Error('debugTile requires the independent generation thread');
  const { sc, li, k, W, H, dprGL } = spec || {};
  if (
    !['zh', 'ja'].includes(sc) ||
    !Number.isInteger(li) ||
    li < 0 ||
    li > 3 ||
    !Number.isInteger(k) ||
    !Number.isInteger(W) ||
    W < 1 ||
    !Number.isInteger(H) ||
    H < 1 ||
    !Number.isFinite(dprGL) ||
    dprGL <= 0
  )
    throw Error('Invalid debugTile parameters');
  debugTileMode = true;
  cancelAnimationFrame(rafID);
  stateQueue.length = 0;
  const key = [W, H, dprGL].join('/');
  if (key !== debugTileConfig) {
    const geo = worldGeometry(W, H, dprGL, comp.maxTex);
    configureWorld(geo, {
      era: renderWorld.era + 1,
      W,
      H,
      kc: clamp(Math.sqrt(W / H) / 1.15, 0.62, 1),
      hero: 4.2 * LAYERS[CLOSE].pan * H + 0.3 * W,
      dprGL,
      closePan: LAYERS[CLOSE].pan,
      cam: 4.2,
      D: 0,
    });
    debugTileConfig = key;
  }
  opening = true;
  comp.setTileOpeningMode(true);
  debugTilePacket = null;
  const g = world.geo[li],
    slot = ((k % g.n) + g.n) % g.n,
    ring = world.rings[sc][li];
  ring.has[slot] = null;
  ring.want[slot] = k;
  const job = { sc, li, k, slot, era: renderWorld.era, pri: 0 };
  world.jobs = [job];
  dispatch();
  const started = performance.now();
  while (ring.has[slot] !== k) {
    if (disposed || comp.lost) throw Error(GPU_DIAG.error || 'Tile export renderer failed');
    if (performance.now() - started > 60000) throw Error('Tile export timed out ' + [sc, li, k].join('/'));
    comp.uploadTiles();
    dispatch();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const image = await comp.debugTilePixels(sc, li, slot);
  const rendered = GPU_DIAG.tileJobs?.findLast(
    j =>
      j.productionJobId === job.id && j.era === job.era && j.sc === sc && j.li === li && j.k === k && j.slot === slot,
  );
  if (!rendered) throw Error('Tile export is missing its matching completed production job');
  return {
    ...image,
    spec,
    geometry: { ts: g.ts, T: g.T, Ht: g.Ht, pad: g.pad, n: g.n },
    packet: debugTilePacket,
    rendered,
    diagnostics: { generation: tilePainter.snapshot(), gpuError: GPU_DIAG.error || null },
  };
}
async function rpc(message) {
  if (gpuRecovering) await gpuRecovery;
  if (disposed) throw Error(GPU_DIAG.error || 'Renderer disposed');
  const __rpcAt = performance.now();
  const args = message.args || [];
  let result;
  if (debugTileMode && ['alloc', 'resize', 'mountains'].includes(message.method)) {
    self.postMessage({ type: 'rpc-result', id: message.id, result: null });
    return;
  }
  switch (message.method) {
    case 'debugTile':
      result = await debugTile(args[0]);
      break;
    case 'captureFrame': {
      if (!captureEnabled()) throw Error('captureFrame requires #debug&capture=1');
      const [now, advance] = args;
      if (!Number.isFinite(now) || now < 0) throw Error('Invalid capture time');
      if (
        disposed ||
        !visible ||
        debugTileMode ||
        !sceneState?.scene ||
        !world.geo ||
        !world.mtn ||
        comp.frameRoom === false
      )
        throw Error('Capture frame cannot be submitted in the current renderer state');
      drawState = sceneState;
      drawAt = now;
      textShift = 0;
      stateQueue.length = 0;
      const move = advance === true && captureAdvancedAt !== now;
      if (!frame(now, true, { advance: move })) throw Error('Capture frame did not submit');
      if (move) captureAdvancedAt = now;
      await comp.finish();
      comp.presentFrame();
      await comp.finish();
      if (disposed || comp.lost || !comp.valid) throw Error('Capture frame did not validate');
      result = {
        state: stateSnapshot(),
        submitted: true,
        advanced: move,
        frameTimeMs: now,
        textGeneration: drawState.text?.generation ?? null,
        uiGeneration: drawState.ui?.generation ?? null,
        animationSamples: { text: textAnimationFrame, ui: uiAnimationFrame },
      };
      break;
    }
    case 'captureDrain': {
      if (!captureEnabled()) throw Error('captureDrain requires #debug&capture=1');
      const started = performance.now();
      while (stateSnapshot().uploading) {
        if (disposed || comp.lost) throw Error(GPU_DIAG.error || 'Capture renderer failed');
        if (performance.now() - started > 60000) throw Error('Capture tile drain timed out');
        comp.uploadTiles();
        dispatch();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      await comp.finish();
      result = { state: stateSnapshot() };
      break;
    }
    case 'ringPixels':
      if (param('debug') === null) throw Error('Ring readback requires #debug');
      result = await comp.ringPixels(...args);
      break;
    case 'ringHash':
      if (param('debug') === null) throw Error('Ring readback requires #debug');
      result = await comp.ringHash(...args);
      break;
    case 'alloc':
      configureWorld(args[0], args[1]);
      break;
    case 'resize':
      lastResize = [args[0], args[1]];
      slowCadenceCount = 0;
      slowCadenceMs = 0;
      setViewport(args[2]);
      comp.resize(args[0], args[1]);
      drift?.resize(innerWidth, innerHeight, Math.min(2, devicePixelRatio));
      break;
    case 'mountains':
      await uploadMountains();
      break;
    case 'statics':
      break;
    case 'prepareTiles':
      break;
    case 'prepareParticles':
      if (message.startupRendererBatch) await message.startupRendererBatch.promise;
      else await comp.prepareParticles(null);
      preparedParticles = true;
      break;
    case 'prepareText': {
      textRenderer = message.startupRendererBatch
        ? (await message.startupRendererBatch.promise).text
        : await comp.prepareText();
      GPU_LINE.enabled = true;
      result = { metadata: textRenderer.metadata };
      break;
    }
    case 'prepareUI': {
      uiRenderer = message.startupRendererBatch
        ? (await message.startupRendererBatch.promise).ui
        : await comp.prepareUI();
      result = { metadata: uiRenderer.metadata };
      break;
    }
    case 'text.prepare':
      await textRenderer.prepare(...args);
      preparedTextArgs = args;
      result = { metadata: textRenderer.metadata };
      break;
    case 'ui.prepare': {
      const owner = uiRenderer;
      try {
        checkDemoPreparation(message.demoGeneration);
        const prepared = await owner.prepare(...args);
        if (owner !== uiRenderer)
          throw Object.assign(Error('UI atlas owner changed'), { code: 'UI_ATLAS_ROOM_REQUIRED' });
        releaseCancelledDemoAtlas();
        checkDemoPreparation(message.demoGeneration);
        preparedUIArgs = args;
        result = { ...prepared, metadata: owner.metadata };
      } catch (error) {
        releaseCancelledDemoAtlas();
        if (owner !== uiRenderer || gpuRecovering) error.code = 'UI_ATLAS_ROOM_REQUIRED';
        throw error;
      }
      break;
    }
    case 'text.dispose':
      preparedTextArgs = null;
      GPU_LINE.enabled = false;
      EVENT_ANIMATION.cancel('text');
      sceneState = { ...sceneState, text: null };
      if (drawState) drawState = { ...drawState, text: null };
      for (const entry of stateQueue) entry.state = { ...entry.state, text: null };
      receivedSceneState = stateQueue.at(-1)?.state || sceneState;
      textAnimationFrame = null;
      textRenderer?.dispose();
      textRenderer = null;
      break;
    case 'ui.dispose':
      preparedUIArgs = null;
      GPU_UI.enabled = false;
      EVENT_ANIMATION.cancel('ui');
      sceneState = { ...sceneState, ui: null };
      if (drawState) drawState = { ...drawState, ui: null };
      for (const entry of stateQueue) entry.state = { ...entry.state, ui: null };
      receivedSceneState = stateQueue.at(-1)?.state || sceneState;
      uiAnimationFrame = null;
      uiRenderer?.dispose();
      uiRenderer = null;
      break;
    case 'setTileOpeningMode': {
      const wasOpening = opening;
      opening = !!args[0];
      comp.setTileOpeningMode(opening);
      if (wasOpening && !opening) {
        workerFrames.reset();
        refreshWindowAt = 0;
        refreshWindowCount = 0;
        delete GPU_DIAG.refreshObserved;
      }
      break;
    }
    case 'setBackgroundResolution':
      lastBackgroundResolution = args[0];
      result = comp.setBackgroundResolution(args[0]);
      break;
    case 'finish':
      await comp.finish();
      break;
    case 'debugTileSnapshot':
      result = comp.debugTileSnapshot();
      break;
    case 'dispose':
      disposed = true;
      cancelAnimationFrame(rafID);
      tilePainter.dispose();
      comp.dispose();
      break;
    default:
      throw Error('Unknown rendering RPC ' + message.method);
  }
  PROBE.note('rpc ' + message.method, __rpcAt);
  if (message.method === 'debugTile')
    self.postMessage({ type: 'rpc-result', id: message.id, result }, [result.pixels.buffer]);
  else self.postMessage({ type: 'rpc-result', id: message.id, result });
  const __reportAt = performance.now();
  report(true);
  PROBE.note('report', __reportAt);
}
let rpcChain = Promise.resolve(),
  startupRendererPreparation = null;
const rendererConstructionRPCs = new Set(['prepareParticles', 'prepareText', 'prepareUI']);
function rpcError(message, error) {
  if (message.type === 'rpc')
    self.postMessage({
      type: 'rpc-result',
      id: message.id,
      error: String(error.stack || error),
      errorCode: error.code,
    });
  else failure(error);
}
function startRendererRPC(message) {
  if (!startupRendererPreparation || startupRendererPreparation.owner !== comp) {
    const previous = rpcChain,
      ticket = { owner: comp, promise: null, methods: new Set(), completed: false };
    ticket.promise = previous
      .then(async () => {
        if (gpuRecovering) await gpuRecovery;
        if (disposed) throw Error('Renderer disposed');
        ticket.owner = comp;
        return comp.prepareStartupRenderers();
      })
      .then(prepared => {
        if (disposed || ticket.owner !== comp) throw Error('Startup renderer owner changed');
        preparedParticles = true;
        textRenderer = prepared.text;
        uiRenderer = prepared.ui;
        ticket.completed = true;
        return prepared;
      })
      .catch(error => {
        failure(error);
        throw error;
      });
    startupRendererPreparation = ticket;
    rpcChain = ticket.promise.then(
      () => {},
      () => {},
    );
  }
  const ticket = startupRendererPreparation;
  if (
    ticket.methods.has(message.method) ||
    (ticket.completed &&
      ((message.method === 'prepareText' && !textRenderer) || (message.method === 'prepareUI' && !uiRenderer)))
  )
    return false;
  ticket.methods.add(message.method);
  message.startupRendererBatch = ticket;
  ticket.promise.then(() => rpc(message)).catch(error => rpcError(message, error));
  return true;
}
self.onmessage = event => {
  const message = event.data;
  if (message.type === 'demo-cancel') {
    try {
      cancelDemoStates(message.generation);
      self.postMessage({ type: 'demo-cancel-ack', generation: workerDemoGeneration, uiMetadata: uiRenderer?.metadata });
    } catch (error) {
      failure(error);
    }
    return;
  }
  if (message.type === 'state') {
    if (debugTileMode) {
      self.postMessage({ type: 'state-ack', seq: message.seq });
      return;
    }
    if (message.state.scene) {
      stateAt = message.sentAt ? message.sentAt - performance.timeOrigin : performance.now();
      PROBE.state();
    }
    self.postMessage({ type: 'state-ack', seq: message.seq });
    try {
      enqueueRenderState(message);
      if (message.state.scene) stateCadence.add(message.sentAt || performance.now());
      if (!gpuRecovering) refreshUIAtlasReferences();
      if (
        comp &&
        !disposed &&
        !captureEnabled() &&
        driveByState() &&
        stateQueue[0]?.scheduledAt <= performance.timeOrigin + performance.now()
      )
        frame(performance.now(), true);
    } catch (error) {
      failure(error);
    }
    return;
  }
  if (message.type === 'ui-room-request') {
    requestUIAtlasRoom(message).catch(failure);
    return;
  }
  if (message.type === 'replace-tile-port') {
    replaceTilePort(message);
    return;
  }
  if (message.type === 'tile-thread-failed') {
    const index = message.index || 0;
    if (tilePainter) tilePainter.lose(index, message.error, message.incarnation);
    else lostTileThreads.set(index, { error: message.error, incarnation: message.incarnation });
    return;
  }
  if (message.type === 'visibility') {
    visible = message.visible !== false;
    workerFrames.setVisible(visible);
    lastRAF = 0;
    slowCadenceCount = 0;
    slowCadenceMs = 0;
    cancelAnimationFrame(rafID);
    if (visible && !disposed && !gpuRecovering && !captureEnabled()) rafID = requestAnimationFrame(frame);
    return;
  }
  const run = () =>
    message.type === 'probe' ? probe(message) : message.type === 'init' ? initialize(message) : rpc(message);
  if (message.type === 'rpc' && rendererConstructionRPCs.has(message.method) && startRendererRPC(message)) return;
  rpcChain = rpcChain.then(run, run).catch(error => rpcError(message, error));
};
