const EVENT_ANIMATION = (() => {
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const lerpUI = (a, b, t) => a + (b - a) * t;
  const rnum = (n, digits) => Number(Number(n).toFixed(digits));
  const names = ['cam', 'track', 'w', 'h', 'vis', 'meter', 'page', 'box'];
  const models = { text: null, ui: null },
    epochs = { text: -1, ui: -1 };
  let native = null,
    batchDirty = true,
    motionAt = null,
    motionEpoch = null,
    wallAt = 0,
    motionInputs = null;
  const sets = new Array(8).fill(0),
    shifts = new Array(8).fill(0);
  const linear = { type: 'linear' };
  function initialize() {
    if (native) return native;
    native = getNativeAnimationRuntime();
    GPU_DIAG.animation = {
      precision: native.precision,
      simd: native.simd,
      motions: 8,
      workspaceBytes: native.workspaceBytes,
      maxRows: native.maxRows,
      maxCurves: native.maxCurves,
      sharedStartupInstance: true,
      notPresentationFPS: true,
    };
    return native;
  }
  function hydrate(value, key = '') {
    if (value === null && ['start', 'enteredAt', 'pickStart'].includes(key)) return -Infinity;
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => hydrate(item));
    const out = {};
    for (const [name, item] of Object.entries(value)) out[name] = hydrate(item, name);
    return out;
  }
  function modelFor(kind, packet) {
    if (!packet?.animationModel) {
      if (models[kind]) {
        models[kind] = null;
        batchDirty = true;
      }
      return null;
    }
    const epoch = packet.epoch ?? 0;
    if (epoch < epochs[kind]) return null;
    const cached = models[kind];
    if (cached?.packet === packet) return cached.model;
    epochs[kind] = epoch;
    const model = hydrate(packet.animationModel);
    models[kind] = { packet, model, basis: packet.frameTimeMs };
    batchDirty = true;
    return model;
  }
  function cancel(kind) {
    if (models[kind]) epochs[kind] = Math.max(epochs[kind], models[kind].packet.epoch ?? 0) + 1;
    models[kind] = null;
    batchDirty = true;
  }
  const value = (row, field = 2) => native.output[row * native.outputStride + field];
  function register(
    kind,
    start,
    duration,
    delay,
    easing,
    from = 0,
    to = 1,
    type = 0,
    shape = 0,
    clamp = false,
    endpoints = 3,
  ) {
    return native.row(
      kind === 'text' ? 0 : 1,
      start - models[kind].basis,
      duration,
      delay,
      easing,
      from,
      to,
      type,
      shape,
      clamp,
      endpoints,
    );
  }
  function registerText(model) {
    for (const entry of model.runs) {
      const state = entry.state,
        sentence = entry.sentence,
        committed = sentence.commitTime !== null;
      entry.entryRow = register('text', state.enteredAt, state.duration, 0, state.ease, 0, 1, 0, 0, false, 2);
      entry.opacityRow = register(
        'text',
        committed ? sentence.commitTime : -Infinity,
        800,
        0,
        model.timing.opacity,
        0.6,
        committed ? 0.86 : 0.6,
        0,
        0,
        false,
        0,
      );
      entry.underlineRow = register(
        'text',
        committed ? sentence.commitTime : -Infinity,
        900,
        0,
        model.timing.underline,
        1,
        committed ? 0 : 1,
        0,
        0,
        false,
        0,
      );
      entry.dryRow = register(
        'text',
        committed ? sentence.commitTime : -Infinity,
        model.timing.dryDuration,
        0,
        model.timing.dry,
        0,
        0.2,
        1,
        0.35,
        false,
        0,
      );
    }
    model.caretRow = register('text', model.idleStart, 1100, 0, linear, 0.7, model.idle ? 0 : 0.7, 2, 0.5, false, 0);
  }
  function registerUI(model) {
    const timing = model.timing,
      owners = new Map(),
      groups = new Map(),
      verses = new Map();
    function group(state) {
      if (!state) return;
      let record = groups.get(state.id);
      if (!record) {
        const out = state.outStart !== null,
          cfg = (out ? state.outTiming : state.oldTiming) || timing.out;
        const start = out ? state.outStart : (state.oldStart ?? -Infinity);
        record = {
          centerRow: register('ui', start, cfg.duration, 0, cfg.ease),
          fadeRow: register('ui', out ? state.outStart : -Infinity, cfg.duration * 0.45, 0, linear, 1, out ? 0 : 1),
        };
        groups.set(state.id, record);
      }
      Object.assign(state, record);
    }
    function owner(state, candidate) {
      let record = owners.get(state.id);
      if (!record) {
        const cfg = candidate ? timing.candidate : timing.key;
        record = {
          entryRow: register('ui', state.start, cfg.duration, candidate ? state.delay : 0, cfg.ease, 0, 1, 0, 0, true),
        };
        if (candidate)
          record.pickRow = register(
            'ui',
            state.pickStart,
            model.reduceMotion ? 10 : 360,
            0,
            timing.pick,
            0,
            1,
            1,
            0.4,
            false,
            0,
          );
        owners.set(state.id, record);
      }
      Object.assign(state, record);
      group(state.group);
    }
    function transition(t) {
      t.nativeRow = register('ui', t.start, t.duration, t.delay, t.ease, t.from, t.to);
    }
    for (const run of model.layout.boxRuns) {
      if (run.kind === 'raw' || run.kind === 'candidate') owner(run.owner, run.kind === 'candidate');
    }
    for (const swash of model.layout.swashes) owner(swash.state, true);
    for (const run of model.layout.sloganRuns) {
      let record = verses.get(run.owner.id);
      if (!record) {
        record = {};
        for (const key of ['opacity', 'blur', 'y', 'scale']) {
          transition(run.owner[key]);
          record[key] = run.owner[key].nativeRow;
        }
        verses.set(run.owner.id, record);
      } else for (const key of ['opacity', 'blur', 'y', 'scale']) run.owner[key].nativeRow = record[key];
    }
    for (const key of ['opacity', 'scale']) transition(model.sealState[key]);
    if (model.coverState) transition(model.coverState.opacity);
    model.flipRow = register(
      'ui',
      model.rawFlip?.start ?? -Infinity,
      260,
      0,
      timing.flip,
      model.rawFlip?.delta || 0,
      0,
      0,
      0,
      false,
      2,
    );
    model.caretRow = register('ui', model.blinkStart, 1060, 0, linear, 1, 0, 2, 0.5, false, 0);
  }
  function rebuildBatch() {
    native.resetRows();
    if (motionInputs)
      for (let i = 0; i < names.length; i++) {
        const source = motionInputs[names[i]],
          cfg = source?.cfg || source;
        native.motions[i * native.motionStride + 11] = native.curve(
          cfg && cfg.type !== 'spring' && cfg.type !== 'exp' ? cfg : linear,
        );
      }
    if (models.text) registerText(models.text.model);
    if (models.ui) registerUI(models.ui.model);
    batchDirty = false;
    GPU_DIAG.animation.rows = native.rowCount;
    GPU_DIAG.animation.curves = native.curveCount;
  }
  function update(control, latest, now, capture) {
    initialize();
    modelFor('text', drawState.text);
    modelFor('ui', drawState.ui);
    const source = control.motion;
    if (!source) {
      if (batchDirty) rebuildBatch();
      native.frame(0, 0, 1, relativeTime('text', now, capture), relativeTime('ui', now, capture));
      return { scene: latest, input: control.box || {}, trackX: null, gust: null };
    }
    const origin =
      source.timeOrigin ?? models.text?.model.timeOrigin ?? models.ui?.model.timeOrigin ?? performance.timeOrigin;
    const absolute = capture ? origin + now : performance.timeOrigin + now;
    const reset = !motionInputs || motionEpoch !== control.worldEra || capture;
    if (reset || motionInputs !== source) {
      if (reset || names.some(key => JSON.stringify(motionInputs?.[key]?.cfg) !== JSON.stringify(source[key]?.cfg)))
        batchDirty = true;
      if (batchDirty) native.resetRows();
      motionEpoch = control.worldEra;
      motionAt = source.at;
      motionInputs = source;
      for (let i = 0; i < names.length; i++) {
        const state = source[names[i]],
          freshSet = reset || (state?.eventSet !== undefined && state.eventSet !== sets[i]);
        const shift = (state?.eventShift ?? 0) - shifts[i];
        native.setMotion(i, state, freshSet, freshSet ? 0 : shift);
        sets[i] = state?.eventSet ?? 0;
        shifts[i] = state?.eventShift ?? 0;
        if (freshSet && names[i] === 'page') native.scene[6] = state?.D ?? latest.D;
        if (freshSet && names[i] === 'box') native.scene[7] = state?.D ?? control.box?.D ?? 0;
        if (freshSet && names[i] === 'cam') native.scene[5] = state?.lead ?? state?.x ?? control.cam;
      }
      if (reset) {
        wallAt = source.at;
        native.resetScene(control, latest, source);
      }
      native.inputs(control, source);
      for (const i of [5, 6, 7])
        if (control.target !== undefined) native.motions[i * native.motionStride + 2] = control.target;
    }
    if (batchDirty) rebuildBatch();
    const dt = Math.max(0, (absolute - wallAt) / 1000),
      dts = control.paused ? 0 : dt * (control.speed ?? 1);
    wallAt = absolute;
    native.frame(dt, dts, transShape().slow, relativeTime('text', now, capture), relativeTime('ui', now, capture));
    const m = native.motions,
      stride = native.motionStride,
      s = native.scene;
    return {
      scene: {
        ...latest,
        time: s[0],
        clock: s[1] * 1000,
        D: s[6],
        t: s[16],
        mx: s[2],
        my: s[3],
        veil: s[4],
        cam: m[0],
      },
      input: {
        w: m[2 * stride],
        h: m[3 * stride],
        vis: m[4 * stride],
        meter: m[5 * stride],
        boxD: s[7],
        boxT: s[18],
        boxP: s[19],
      },
      trackX: m[stride],
      box: { D: s[7], t: s[18], p: s[19] },
      gust: s[20],
    };
  }
  function relativeTime(kind, now, capture) {
    const cached = models[kind];
    if (!cached) return 0;
    return (capture ? now : performance.timeOrigin + now - cached.model.timeOrigin) - cached.basis;
  }
  function textFrame(packet, model, time, track) {
    const timing = model.timing;
    function sampleRun(entry, time, trackX) {
      const { state, sentence, spec, box } = entry,
        age = value(entry.entryRow, 3);
      const progress = value(entry.entryRow, 0),
        easedProgress = value(entry.entryRow, 1);
      const committed = sentence.commitTime !== null;
      const opacity = value(entry.opacityRow) * clamp01(easedProgress);
      const underlineFraction = entry.isChunk ? value(entry.underlineRow) : 0;
      const dryAlpha = value(entry.dryRow);
      const translateY = 0.18 * spec.fontSize * (1 - easedProgress);
      return {
        id: state.id,
        key: spec.key,
        text: spec.text,
        x: entry.rect.x + trackX,
        y: entry.rect.y,
        width: spec.width,
        height: spec.height,
        opacity: entry.isChunk || committed ? opacity : 0.86,
        blur: Math.max(0, 6 * (1 - easedProgress)),
        translateY,
        dryAlpha,
        inkColor: entry.inkColor,
        underline: {
          x: box.x + trackX + box.width * (1 - underlineFraction),
          y: box.bottom - 1.5,
          width: box.width * underlineFraction,
          height: 1.5,
          alpha: 1,
          color: entry.lang === 'ja' ? [201 / 255, 116 / 255, 137 / 255, 0.85] : [85 / 255, 122 / 255, 81 / 255, 0.78],
        },
        animation: {
          name: 'inkIn',
          target: '#track/' + state.id,
          targetPath: '#track/' + state.id,
          text: spec.text,
          start: state.enteredAt,
          duration: state.duration,
          delay: 0,
          currentTime: Number.isFinite(age) ? Math.max(0, age) : state.duration,
          progress,
          easedProgress,
          translateY,
          phase: progress >= 1 ? 'after' : age < 0 ? 'before' : 'active',
          paused: false,
        },
      };
    }
    const trackX = rnum(track ?? model.trackX, 2),
      items = model.runs.map(entry => sampleRun(entry, time, trackX));
    const clip = { ...model.lineRect, fadeStart: 0.03, fadeEnd: 0.42 },
      c = model.caretRect;
    const alpha = value(model.caretRow);
    return {
      ...packet,
      animationModel: undefined,
      frameTimeMs: time,
      runs: items,
      items,
      clip,
      lineRect: clip,
      trackX,
      caret: {
        x: c.x + trackX,
        y: c.y,
        width: c.width,
        height: c.height,
        alpha,
        color: [26 / 255, 31 / 255, 27 / 255, 1],
        radius: 1,
      },
    };
  }
  function uiFrame(packet, model, time, input) {
    const layout = model.layout,
      timing = model.timing,
      rawFlip = model.rawFlip,
      sealState = model.sealState,
      coverState = model.coverState,
      blinkStart = model.blinkStart,
      reduceMotion = model.reduceMotion;
    function sampleTransition(t) {
      return t ? value(t.nativeRow) : 0;
    }
    function sampleVerse(state, time) {
      return {
        opacity: sampleTransition(state.opacity, time),
        blur: sampleTransition(state.blur, time),
        translateY: sampleTransition(state.y, time),
        scale: sampleTransition(state.scale, time),
      };
    }
    function normalizedInput(input = {}) {
      const vis = Number(input.vis ?? 0);
      return {
        w: rnum(input.w ?? 0, 1),
        h: rnum(input.h ?? 0, 1),
        vis,
        opacity: rnum(clamp01(vis), 3),
        scale: rnum(0.955 + 0.045 * vis, 4),
        dy: rnum((1 - vis) * 8, 2),
        meter: rnum((input.meter ?? 0) * 100, 1) / 100,
        boxD: input.boxD ?? st.box.D,
        boxT: input.boxT ?? st.box.t,
        boxP: input.boxP ?? 0,
      };
    }
    function sampleEntry(state, time, cfg, offset) {
      const age = value(state.entryRow, 3),
        progress = value(state.entryRow, 0),
        eased = value(state.entryRow, 1);
      return { opacity: value(state.entryRow), dy: offset * (1 - eased), age, progress, eased };
    }
    function sampleList(group) {
      if (!group) return { dx: 0, dy: 0, opacity: 1 };
      const eased = value(group.centerRow, 1),
        out = group.outStart !== null;
      const remaining = (out ? 1 - group.centerAtGone : 1) * (1 - eased);
      return {
        dx: group.halfWidth * remaining,
        dy: group.halfHeight * remaining - (out ? 7 * eased : 0),
        opacity: value(group.fadeRow),
      };
    }
    function sampleCandidate(state, time) {
      const entry = sampleEntry(state, time, timing.candidate, 6, state.delay),
        group = sampleList(state.group, time);
      return { ...entry, opacity: entry.opacity * group.opacity, dx: group.dx, dy: entry.dy + group.dy };
    }
    function flipX() {
      return value(model.flipRow);
    }
    function animationRecord(name, targetPath, state, time, duration, delay, eased, property, row) {
      const currentTime = value(row, 3),
        progress = value(row, 0);
      return {
        name,
        target: targetPath,
        targetPath,
        start: state.start,
        currentTime: Math.max(0, currentTime),
        duration,
        delay,
        progress,
        easedProgress: eased,
        eventId: state.eventId || null,
        property,
        phase: currentTime < delay ? 'before' : progress >= 1 ? 'after' : 'active',
        paused: false,
      };
    }
    function propertyAnimations(state, targetPath, time, output, properties) {
      for (const [key, name, property] of properties) {
        const t = state[key],
          age = value(t.nativeRow, 3);
        if (!Number.isFinite(t.start) || age >= t.delay + t.duration) continue;
        output.push(
          animationRecord(name, targetPath, t, time, t.duration, t.delay, value(t.nativeRow, 1), property, t.nativeRow),
        );
      }
    }
    const inputValue = normalizedInput(input);
    const L = layout,
      pmix = sstep(0.12, 0.88, inputValue.boxP),
      mix = (a, b, alpha) => a.map((n, i) => (lerpUI(n, b[i], pmix) | 0) / 255).concat(alpha);
    const acc = mix([85, 122, 81], [201, 116, 137], 1),
      edge = mix([52, 72, 54], [150, 86, 104], 0.15),
      shade = mix([34, 52, 38], [92, 48, 62], 0.4);
    const green = [214 / 255, 231 / 255, 204 / 255, 0.74],
      pink = [248 / 255, 220 / 255, 228 / 255, 0.78],
      e = 1.35 - inputValue.boxT * 1.7;
    const animations = [],
      transforms = new Map(),
      seen = new Set(),
      dx = flipX(time),
      boxRuns = [],
      sloganRuns = [];
    for (const run of L.boxRuns) {
      let opacity = run.opacity,
        dy = 0,
        x = run.x,
        y = run.y;
      if (run.kind === 'raw') {
        const sample = sampleEntry(run.owner, time, timing.key, 5);
        opacity *= sample.opacity;
        dy = sample.dy;
        x += dx;
        transforms.set(run.owner.id, { x: dx, y: dy, scale: 1 });
        if (!seen.has(run.owner.id) && sample.progress < 1)
          animations.push(
            animationRecord(
              'keyIn',
              '#raw/' + run.owner.id,
              run.owner,
              time,
              timing.key.duration,
              0,
              sample.eased,
              'opacity,transform',
              run.owner.entryRow,
            ),
          );
      } else if (run.kind === 'candidate') {
        const sample = sampleCandidate(run.owner, time);
        opacity *= sample.opacity;
        dy = sample.dy;
        x += sample.dx;
        transforms.set(run.owner.id, { x: sample.dx, y: dy, scale: 1 });
        if (!seen.has(run.owner.id) && sample.progress < 1)
          animations.push(
            animationRecord(
              'candIn',
              '#cwrap/' + run.owner.id,
              run.owner,
              time,
              timing.candidate.duration,
              run.owner.delay,
              sample.eased,
              'opacity,transform',
              run.owner.entryRow,
            ),
          );
        const group = run.owner.group;
        if (group && !seen.has(group.id)) {
          const start = group.outStart ?? group.oldStart,
            cfg = (group.outStart === null ? group.oldTiming : group.outTiming) || timing.out;
          if (start !== null && value(group.centerRow, 3) < cfg.duration) {
            const t = { start, eventId: group.outStart === null ? group.oldEventId : group.eventId };
            animations.push(
              animationRecord(
                'transform',
                '#cwrap/' + group.id,
                t,
                time,
                cfg.duration,
                0,
                value(group.centerRow, 1),
                'transform',
                group.centerRow,
              ),
            );
          }
          seen.add(group.id);
        }
      } else if (run.anchor === 'meter') {
        x += inputValue.w / 2;
        y -= inputValue.h / 2;
      }
      seen.add(run.id);
      boxRuns.push({
        key: run.key,
        id: run.id,
        text: run.text,
        x,
        y,
        width: run.width,
        height: run.height,
        opacity,
        translateY: dy,
        blur: 0,
        scale: 1,
        inkColor: run.inkColor,
      });
    }
    if (rawFlip && value(model.flipRow, 3) < 260) {
      animations.push(
        animationRecord(
          'transform',
          '#raw',
          rawFlip,
          time,
          260,
          0,
          value(model.flipRow, 1),
          'transform',
          model.flipRow,
        ),
      );
    }
    const swashes = L.swashes.map(swash => {
      const sample = sampleCandidate(swash.state, time),
        age = value(swash.state.pickRow, 3),
        duration = reduceMotion ? 10 : 360;
      let p = 0;
      if (age >= 0 && age < duration) {
        p = value(swash.state.pickRow);
        animations.push(
          animationRecord(
            'pick',
            '#cwrap/' + swash.state.id + '::before',
            { start: swash.state.pickStart, eventId: swash.state.pickEventId },
            time,
            duration,
            0,
            p,
            'opacity,transform',
            swash.state.pickRow,
          ),
        );
      }
      return {
        x: swash.x + sample.dx,
        y: swash.y + sample.dy - 0.01 * swash.height * p,
        width: swash.width,
        height: swash.height,
        opacity: (0.5 + 0.22 * p) * sample.opacity,
        scaleX: 1 + 0.07 * p,
        scaleY: 1 + 0.14 * p,
        color: swash.color,
      };
    });
    for (const run of L.sloganRuns) {
      const s = sampleVerse(run.owner, time),
        cx = run.center.x,
        cy = run.center.y;
      transforms.set(run.owner.id, { x: 0, y: s.translateY, scale: s.scale, center: run.center });
      if (!seen.has(run.owner.id))
        propertyAnimations(run.owner, run.owner.targetPath, time, animations, [
          ['opacity', 'opacity', 'opacity'],
          ['blur', 'filter', 'filter'],
          ['y', 'transform', 'transform'],
        ]);
      seen.add(run.owner.id);
      const x = cx + (run.x + run.width / 2 - cx) * s.scale - run.width / 2;
      const y = cy + (run.y + run.height / 2 - cy) * s.scale - run.height / 2;
      sloganRuns.push({
        key: run.key,
        id: run.id,
        text: run.text,
        x,
        y,
        width: run.width,
        height: run.height,
        opacity: s.opacity,
        translateY: s.translateY,
        blur: Math.max(0, s.blur),
        scale: s.scale,
        inkColor: run.inkColor,
      });
    }
    const seal = {
      ...L.seal,
      opacity: sampleTransition(sealState.opacity, time),
      scale: sampleTransition(sealState.scale, time),
    };
    propertyAnimations(sealState, '#seal', time, animations, [
      ['opacity', 'opacity', 'opacity'],
      ['scale', 'transform', 'transform'],
    ]);
    let coverOpacity = coverState ? sampleTransition(coverState.opacity, time) : 0;
    if (coverState) propertyAnimations(coverState, '#cover', time, animations, [['opacity', 'opacity', 'opacity']]);
    const bx = L.center.x,
      by = L.center.y + inputValue.dy;
    const result = {
      generation: packet.generation,
      frameTimeMs: time,
      layoutVersion: L.version,
      atlasGeneration: L.atlasGeneration,
      W: L.W,
      H: L.H,
      viewportCss: [L.W, L.H],
      dpr: L.dpr,
      atlasEpoch: L.atlasEpoch ?? packet.epoch,
      box: {
        x: bx,
        y: by,
        width: inputValue.w,
        height: inputValue.h,
        scale: inputValue.scale,
        opacity: inputValue.opacity,
        radius: 18,
        acc,
        edge,
        shade,
        glass: !!LAB.glass,
        ground: [252 / 255, 252 / 255, 249 / 255, 0.6],
        tint: {
          out: inputValue.boxD ? pink : green,
          in: inputValue.boxD ? green : pink,
          start: rnum((e - 0.35) * 100, 1) / 100,
          end: rnum((e + 0.35) * 100, 1) / 100,
        },
      },
      boxRuns,
      sloganRuns,
      swashes,
      rule: { ...L.rule, color: [26 / 255, 31 / 255, 27 / 255, 0.34], opacity: 0.5 },
      rawCaret: { ...L.rawCaret, color: acc, opacity: value(model.caretRow), radius: 1 },
      meter: {
        bar: {
          x: L.bar.x + inputValue.w / 2,
          y: L.bar.y - inputValue.h / 2,
          width: L.bar.width,
          height: L.bar.height,
          opacity: 0.45,
          color0: [85 / 255, 122 / 255, 81 / 255, 1],
          color1: [201 / 255, 116 / 255, 137 / 255, 1],
        },
        dot: {
          x: L.gauge.x + inputValue.w / 2 + L.gauge.width * inputValue.meter - 3.5,
          y: L.gauge.y - inputValue.h / 2,
          width: 7,
          height: 7,
          radius: 3.5,
          color: acc,
          opacity: 1,
        },
      },
      seal,
      cover: { opacity: coverOpacity, color: L.paperColor },
      animations,
      crops: {
        candidate: {
          x: bx - (inputValue.w * inputValue.scale) / 2,
          y: by - (inputValue.h * inputValue.scale) / 2,
          width: inputValue.w * inputValue.scale,
          height: inputValue.h * inputValue.scale,
        },
        slogan: L.mark,
      },
      pending: false,
      epoch: packet.epoch,
      transforms: Object.fromEntries(transforms),
      input: inputValue,
    };
    return result;
  }
  function evaluate(kind, packet, now, input, capture = false) {
    const cached = models[kind];
    if (!packet?.animationModel) return packet;
    if (!cached || cached.packet !== packet || (packet.epoch ?? 0) < epochs[kind]) return null;
    const model = cached.model,
      time = capture ? now : performance.timeOrigin + now - model.timeOrigin;
    return kind === 'text'
      ? textFrame(packet, model, time, input)
      : uiFrame(packet, model, time, { ...model.input, ...input });
  }
  return { initialize, update, evaluate, cancel };
})();
