function createStartupTracker(started, now = () => performance.now()) {
  const metadata = { started, frameStarted: false, active: 0, peakActive: 0, stages: [] };
  function begin(name, details = {}) {
    const stage = { ...details, name, start: now(), end: null, wallMs: null, status: 'running' };
    metadata.stages.push(stage);
    metadata.active++;
    metadata.peakActive = Math.max(metadata.peakActive, metadata.active);
    return (status = 'completed', error = null) => {
      if (stage.end !== null) return;
      stage.end = now();
      stage.wallMs = stage.end - stage.start;
      stage.status = status;
      if (error) stage.error = String(error.message || error);
      metadata.active--;
    };
  }
  function cancel(reason) {
    for (const stage of metadata.stages)
      if (stage.end === null) {
        stage.end = now();
        stage.wallMs = stage.end - stage.start;
        stage.status = 'cancelled';
        stage.error = String(reason.message || reason);
        metadata.active--;
      }
  }
  function prepare(name, owner, operation, isCurrent) {
    const finish = begin(name);
    let task;
    try {
      task = operation();
    } catch (error) {
      task = Promise.reject(error);
    }
    return Promise.resolve(task).then(
      value => {
        const current = isCurrent();
        finish(current ? 'completed' : 'superseded');
        return { owner, value, current };
      },
      error => {
        const current = isCurrent();
        finish(current ? 'failed' : 'superseded', error);
        return { owner, error, current };
      },
    );
  }
  return { metadata, begin, cancel, prepare };
}

let GPU_BOOT = null;
function bootProgress() {
  if (!GPU_BOOT?.worldDone) return;
  if (comp !== GPU_BOOT.worldComp || worldEra !== GPU_BOOT.worldEra) {
    GPU_BOOT.worldDone('superseded');
    GPU_BOOT.worldDone = null;
  } else if (worldIdle()) {
    GPU_BOOT.worldDone();
    GPU_BOOT.worldDone = null;
  }
}
async function createPreferredWebGPU(canvas) {
  const threads = 1;
  const result = await createRenderWorkerCompositor(canvas, {
    url: SITE_CONFIG.workers.render,
    generator: { url: SITE_CONFIG.workers.generate, threads },
    config: SITE_CONFIG,
    plainOptions: { reduceMotion },
    hash: HASH,
    getWorld: () => ({ ...world, era: worldEra, dprGL, cam: springs.cam.x, D: st.page.D }),
    getControl: renderWorkerControl,
    getViewport: renderWorkerViewport,
    onFatal: siteFatal,
    captureSetTimeout: window.__zzTest?.real.timeout,
    captureClearTimeout: window.__zzTest?.real.clearTimeout,
    onDiagnostics: message => {
      if (message.diagnostics?.frameDiagnostics) GPU_DIAG.workerFrameDiagnostics = message.diagnostics.frameDiagnostics;
    },
  });
  if (!result?.api) throw Error('Render Worker initialization did not return a compositor');
  if (mainStopped) {
    result.api.dispose();
    throw Error('Render Worker initialization was interrupted');
  }
  GPU_DIAG.renderThread = 'worker';
  return result.api;
}
