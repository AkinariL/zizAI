async function boot() {
  OPENING.t0 = performance.now();
  GPU_BOOT = createStartupTracker(OPENING.t0);
  GPU_DIAG.bootStartup = GPU_BOOT.metadata;
  const fontDone = GPU_BOOT.begin('document-fonts'),
    fontsReady = loadFonts();
  if (window.__zzTest) window.__zzTest.fontsReady = fontsReady;
  fontsReady.then(
    () => fontDone(),
    error => {
      fontDone('failed', error);
      siteFatal(error);
    },
  );
  try {
    if (SITE_DEBUG) loadTuning();
    LAYERS[CLOSE].pan = TUNE.closePan;
    applyCss();
    if (SITE_DEBUG) buildPanel();
    buildVerse();
    const compositorDone = GPU_BOOT.begin('render-worker');
    try {
      comp = await createPreferredWebGPU(bg);
      compositorDone();
    } catch (error) {
      compositorDone('failed', error);
      throw error;
    }
    if (mainStopped) {
      comp.dispose();
      return;
    }
    const [W, H] = viewport();
    paperValue = comp.paperInfo.pap;
    resizeScene();
    if (STATIC === 'ja') st.page.D = 1;
    comp.setTileOpeningMode(OPENING.up && STATIC === null);
    const tileDone = GPU_BOOT.begin('tile-preparation');
    try {
      await comp.prepareTiles();
      tileDone();
    } catch (error) {
      tileDone('failed', error);
      throw error;
    }
    if (mainStopped) return;
    GPU_BOOT.worldDone = GPU_BOOT.begin('world-drain', { era: worldEra + 1 });
    const buildDone = GPU_BOOT.begin('world-build');
    if (!buildWorld(STATIC !== null)) {
      buildDone('failed');
      return;
    }
    buildDone();
    const particleDone = GPU_BOOT.begin('particles-gpu'),
      particleTask = comp.prepareParticles();
    const prewarmOwner = comp,
      isPrewarmCurrent = () => !mainStopped && comp === prewarmOwner;
    const textTask = GPU_BOOT.prepare(
        'text-gpu-early',
        prewarmOwner,
        () => prewarmOwner.prepareText(),
        isPrewarmCurrent,
      ),
      uiTask = GPU_BOOT.prepare(
        'ui-gpu-and-seal-early',
        prewarmOwner,
        () => prewarmOwner.prepareUI(),
        isPrewarmCurrent,
      );
    try {
      await particleTask;
      particleDone();
    } catch (error) {
      particleDone('failed', error);
      throw error;
    }
    if (mainStopped) return;
    if (STATIC !== null) {
      OPENING.up = false;
      $('cover').remove();
      bg.classList.add('on');
    }
    consumeDemoParticleSeedRandom(W, H);
    GPU_BOOT.metadata.frameStarted = true;
    mainFrameId = requestAnimationFrame(frame);
    await Promise.race([fontsReady, timeout(3200)]);
    if (mainStopped) return;
    setCands(SCRIPT[0].chunks[4].c[8], 'zh');
    addKey('n', false);
    root.style.setProperty('--box-h0', inner.offsetHeight + 'px');
    markRect();
    clearRaw();
    setCands(null);
    for (const candidate of [...cwrap.children]) candidate.remove();
    curList = null;
    springs.w.set(220);
    springs.h.set(inner.offsetHeight);
    springs.track.set(-caret.offsetLeft);
    if (param('crop')) {
      const [cx, cy, scale] = param('crop').split(',').map(Number),
        stage = $('stage');
      stage.style.transformOrigin = '0 0';
      stage.style.transform = 'scale(' + scale + ') translate(' + -cx + 'px,' + -cy + 'px)';
    }
    GPU_DIAG.textPreparing = true;
    try {
      const preparedText = await textTask;
      if (preparedText.error) throw preparedText.error;
      if (!preparedText.current) return;
      const textRenderer = preparedText.value;
      if (mainStopped) return;
      const textPrewarm = GPU_BOOT.begin('text-prewarm');
      await GPU_LINE.enable(textRenderer, { onError: siteFatal });
      textPrewarm();
      GPU_DIAG.state = (comp.kind === 'webgl2' ? 'WebGL2' : 'WebGPU') + ' / stage 3 text';
    } finally {
      GPU_DIAG.textPreparing = false;
    }
    if (mainStopped) return;
    GPU_DIAG.uiPreparing = true;
    try {
      const preparedUI = await uiTask;
      if (preparedUI.error) throw preparedUI.error;
      if (!preparedUI.current) return;
      const uiRenderer = preparedUI.value;
      if (mainStopped) return;
      const uiPrewarm = GPU_BOOT.begin('ui-prewarm');
      await GPU_UI.enable(uiRenderer, { onError: siteFatal });
      uiPrewarm();
      comp.setUIFrame(
        GPU_UI.frame(performance.now(), {
          w: springs.w.x,
          h: springs.h.x,
          vis: springs.vis.x,
          meter: st.meter.x,
          boxD: st.box.D,
          boxT: st.box.t,
          boxP: st.box.p,
        }),
      );
      GPU_DIAG.state = (comp.kind === 'webgl2' ? 'WebGL2' : 'WebGPU') + ' / stage 4 UI';
    } finally {
      GPU_DIAG.uiPreparing = false;
    }
    if (mainStopped) return;
    const verse = () => {
      mark.classList.add('on');
      GPU_UI.markOn(true);
      showVerse(0, OPEN_LANG);
      setTimeout(() => showVerse(1, OPEN_LANG), 520);
    };
    if (STATIC !== null) {
      verse();
      $('github')?.classList.add('on');
      $('loading')?.remove();
      return;
    }
    OPENING.ready = true;
    await OPENING.lifted;
    if (mainStopped) return;
    verse();
    const generation = demoGen;
    await wait(OPENING.dur + 500);
    $('github')?.classList.add('on');
    if (generation === demoGen) runDemo(generation).catch(siteFatal);
  } catch (error) {
    siteFatal(error);
  }
}

boot();
