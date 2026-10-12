const GPU_LINE = (() => {
  let enabled = false,
    renderer = null,
    errorCallback = null,
    error = null,
    epoch = 0;
  let dirtyFlag = true,
    needPrewarm = true,
    dirtySerial = 0,
    layoutGeneration = 0;
  let layoutFlushes = 0,
    geometryReads = 0,
    fontGeneration = 0,
    nextId = 0,
    generation = 0;
  let layout = null,
    measured = null,
    pendingLayout = null,
    preparing = null,
    submitted = null;
  let styleElement = null,
    listening = false,
    idle = true,
    idleStart = 0,
    lastTrackX = 0;
  let preparedSignature = '',
    preparedKeys = new Set(),
    specs = new Map(),
    timing = null;
  let eventPacket = null,
    eventPacketKey = '';
  const runs = new Map(),
    sentences = new Map(),
    events = [],
    dirtyReasons = [];
  const clamp01 = n => Math.max(0, Math.min(1, n));
  const rectObject = r => ({
    x: r.left,
    y: r.top,
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  });
  function rect(node) {
    geometryReads++;
    return rectObject(node.getBoundingClientRect());
  }
  function css(node) {
    geometryReads++;
    return getComputedStyle(node);
  }
  function now() {
    return globalThis.SITE_DEMO_SCHEDULE?.eventNow?.() ?? performance.now();
  }
  function roundedTrack(value) {
    return Number(Number(value || 0).toFixed(2));
  }
  function eventBezier(...bz) {
    const fn = cubicBezier(...bz);
    fn.eventCurve = { type: 'bezier', bz };
    return fn;
  }
  function eventData(value, key = '') {
    if (typeof value === 'function') return value.eventCurve || { type: 'linear' };
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => eventData(item));
    if (value.constructor !== Object) return undefined;
    const output = {};
    for (const [name, item] of Object.entries(value)) {
      if (name === 'node' || name === 'timer') continue;
      const data = eventData(item, name);
      if (data !== undefined) output[name] = data;
    }
    return output;
  }
  function rgba(value, fallback) {
    const m = String(value).match(/^rgba?\(([^)]+)\)/);
    if (!m) return fallback;
    const p = m[1]
      .split(/[\s,\/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255, Number.isFinite(p[3]) ? p[3] : 1];
  }
  function dirty(reason = 'event') {
    dirtyFlag = true;
    dirtySerial++;
    dirtyReasons.push({ serial: dirtySerial, reason: String(reason) });
    if (dirtyReasons.length > 64) dirtyReasons.shift();
    if (/font/.test(reason)) {
      fontGeneration++;
      specs = new Map();
      needPrewarm = true;
    }
    if (/enable|resize|size|css|tun|dpr|ground/.test(reason)) needPrewarm = true;
  }
  function fontEvent() {
    dirty('fonts-loadingdone');
  }
  function resizeEvent() {
    dirty('resize');
  }
  function installStyle() {
    if (styleElement) return;
    styleElement = document.createElement('style');
    styleElement.dataset.gpuLineLayout = '';
    styleElement.textContent = `
      #line.gpu-line-layout{visibility:hidden!important}
      #line.gpu-line-layout .track{transform:none!important;will-change:auto!important}
      #line.gpu-line-layout .chunk{animation:none!important;transition:none!important;filter:none!important;transform:none!important}
      #line.gpu-line-layout .pre.done,#line.gpu-line-layout .caret{animation:none!important}
      #line.gpu-line-layout .ink{filter:none!important}
    `;
    document.head.appendChild(styleElement);
  }
  function updateTiming() {
    const c = CURVES.inkIn;
    const duration = reduceMotion ? 10 : Number((curveT(c) / (SPEED * TUNE.speed)).toFixed(3)) * 1000;
    let ease;
    if (c.type === 'bezier') ease = eventBezier(...c.bz.map(v => Number(v.toFixed(3))));
    else if (!CSS_LINEAR) ease = eventBezier(0.2, 0.8, 0.2, 1);
    else {
      const points = response(c, 48).pts.map(v => Number(v.toFixed(4)));
      points[points.length - 1] = 1;
      ease = value => {
        const t = clamp01(value) * (points.length - 1),
          i = Math.min(points.length - 2, Math.floor(t));
        return points[i] + (points[i + 1] - points[i]) * (t - i);
      };
      ease.eventCurve = { type: 'points', points };
    }
    timing = {
      duration: Math.max(0, duration),
      ease,
      opacity: eventBezier(0.25, 0.1, 0.25, 1),
      underline: eventBezier(0.65, 0, 0.35, 1),
      dry: eventBezier(0, 0, 0.58, 1),
      dryDuration: reduceMotion ? 10 : 1200,
    };
    for (const state of runs.values()) {
      state.duration = timing.duration;
      state.ease = timing.ease;
      scheduleEntryEnd(state);
    }
  }
  function sentenceState(node) {
    let value = sentences.get(node);
    if (!value) {
      value = { id: 'sentence-' + ++nextId, commitTime: null };
      sentences.set(node, value);
    }
    return value;
  }
  function stateFor(node, entering = false) {
    let state = runs.get(node);
    if (!state) {
      state = {
        id: 'ink-' + ++nextId,
        node,
        enteredAt: entering ? now() : -Infinity,
        duration: timing?.duration || 0,
        ease: timing?.ease || (x => x),
        timer: null,
      };
      runs.set(node, state);
    }
    return state;
  }
  function scheduleEntryEnd(state) {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (!enabled || !Number.isFinite(state.enteredAt)) return;
    const remaining = state.duration - (now() - state.enteredAt);
    if (remaining <= 0) {
      if (state.node.classList.contains('in')) state.node.classList.remove('in');
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      if (enabled && state.node.isConnected) state.node.classList.remove('in');
    }, remaining);
  }
  function marker() {
    const el = document.createElement('span');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;';
    return el;
  }
  function textGlyphs(ink, origin) {
    const walker = document.createTreeWalker(ink, NodeFilter.SHOW_TEXT),
      range = document.createRange(),
      output = [];
    let text;
    while ((text = walker.nextNode())) {
      const segments =
        typeof Intl.Segmenter === 'function'
          ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.data)].map(s => ({
              text: s.segment,
              index: s.index,
            }))
          : [...text.data].reduce((a, value) => {
              a.push({ text: value, index: a.length ? a[a.length - 1].index + a[a.length - 1].text.length : 0 });
              return a;
            }, []);
      for (const part of segments) {
        range.setStart(text, part.index);
        range.setEnd(text, part.index + part.text.length);
        geometryReads++;
        const r = range.getBoundingClientRect();
        output.push({ text: part.text, x: r.left - origin.x, y: 0 });
      }
    }
    return output;
  }
  function measureSpec(ink, mark, dpr) {
    const r = rect(ink),
      c = css(ink),
      baseline = rect(mark).top - r.top;
    const fontSize = parseFloat(c.fontSize),
      letterSpacing = parseFloat(c.letterSpacing) || 0;
    const font = `${c.fontStyle} ${c.fontWeight} ${fontSize}px ${c.fontFamily}`;
    const text = ink.textContent,
      key = JSON.stringify([fontGeneration, font, letterSpacing, dpr, text]);
    const spec = {
      key,
      text,
      font,
      fontSize,
      letterSpacing,
      width: r.width,
      height: r.height,
      baseline,
      glyphs: textGlyphs(ink, r),
      dpr,
    };
    specs.set(key, spec);
    return { spec, rect: r, inkColor: rgba(c.color, [26 / 255, 31 / 255, 27 / 255, 1]) };
  }
  function prewarm(lineStyle, dpr) {
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;font-size:${lineStyle.fontSize};line-height:${lineStyle.lineHeight};`;
    const texts = [...new Set(SCRIPT.flatMap(sentence => sentence.chunks.map(chunk => chunk.out)).filter(Boolean))],
      entries = [];
    for (const language of ['zh-Hans', 'ja']) {
      const pre = document.createElement('span');
      pre.className = 'pre';
      pre.lang = language;
      for (const text of texts) {
        const chunk = document.createElement('span'),
          ink = document.createElement('span'),
          probe = marker();
        chunk.className = 'chunk';
        ink.className = 'ink';
        ink.textContent = text;
        ink.appendChild(probe);
        chunk.appendChild(ink);
        pre.appendChild(chunk);
        entries.push({ ink, probe });
      }
      holder.appendChild(pre);
    }
    document.body.appendChild(holder);
    try {
      for (const { ink, probe } of entries) measureSpec(ink, probe, dpr);
    } finally {
      holder.remove();
    }
    needPrewarm = false;
  }
  function measureLayout() {
    layoutFlushes++;
    const line = $('line'),
      dpr = devicePixelRatio || 1,
      lineStyle = css(track);
    if (needPrewarm) {
      specs = new Map();
      prewarm(lineStyle, dpr);
    }
    const nodes = [...track.querySelectorAll('.ink')],
      markers = nodes.map(ink => ({ ink, probe: marker() }));
    for (const pair of markers) pair.ink.appendChild(pair.probe);
    const measuredRuns = [],
      byNode = new Map();
    let lineRect, caretRect, caretOffset;
    try {
      lineRect = rect(line);
      caretRect = rect(caret);
      geometryReads++;
      caretOffset = caret.offsetLeft;
      for (const { ink, probe } of markers) {
        const node = ink.parentElement,
          state = stateFor(node),
          sentence = sentenceState(node.parentElement);
        const data = measureSpec(ink, probe, dpr),
          r = rect(node);
        geometryReads++;
        const width = node.offsetWidth;
        const entry = {
          ...data,
          state,
          sentence,
          node,
          width,
          box: r,
          isChunk: node.classList.contains('chunk'),
          lang: node.dataset.l || (node.parentElement.lang.startsWith('ja') ? 'ja' : 'zh'),
        };
        measuredRuns.push(entry);
        byNode.set(node, entry);
      }
    } finally {
      for (const pair of markers) pair.probe.remove();
    }
    const glyphs = [],
      walker = document.createTreeWalker(track, NodeFilter.SHOW_TEXT),
      range = document.createRange();
    let text,
      index = 0;
    while ((text = walker.nextNode())) {
      if (!text.textContent.trim()) continue;
      const ink = text.parentElement.closest('.ink'),
        run = ink ? byNode.get(ink.parentElement) : null;
      for (let i = 0; i < text.textContent.length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        geometryReads++;
        glyphs.push({
          key: `track/${index}/${i}/${text.textContent[i]}`,
          rect: rectObject(range.getBoundingClientRect()),
          runId: run?.state.id || null,
        });
      }
      index++;
    }
    const sentenceRects = [...track.children]
      .filter(n => n !== caret && n.id !== 'strut')
      .map(node => ({ node, rect: rect(node) }));
    for (const [node, state] of runs)
      if (!node.isConnected) {
        if (state.timer !== null) clearTimeout(state.timer);
        runs.delete(node);
      }
    for (const node of sentences.keys()) if (!node.isConnected) sentences.delete(node);
    const signature = JSON.stringify([fontGeneration, dpr, TUNE.base, TUNE.baseSoft]);
    return {
      version: ++layoutGeneration,
      dirtySerial,
      W: innerWidth,
      H: innerHeight,
      dpr,
      runs: measuredRuns,
      byNode,
      glyphs,
      sentenceRects,
      caretRect,
      caretOffset,
      lineRect,
      signature,
      settings: { base: TUNE.base, baseSoft: TUNE.baseSoft, dpr, fontGeneration },
      specs: [...specs.values()],
    };
  }
  function covered(candidate) {
    return (
      candidate.signature === preparedSignature &&
      candidate.runs.every(run => preparedKeys.has(run.spec.key)) &&
      candidate.specs.every(spec => preparedKeys.has(spec.key))
    );
  }
  function signalError(reason, token) {
    if (token !== epoch) return;
    error = reason instanceof Error ? reason : Error(String(reason));
    pendingLayout = null;
    errorCallback?.(error);
    siteFatal(error);
  }
  function prepareCandidate(candidate) {
    pendingLayout = candidate;
    if (!preparing && covered(candidate)) {
      layout = candidate;
      pendingLayout = null;
      return;
    }
    if (preparing) return;
    const token = epoch,
      target = renderer;
    preparing = (async () => {
      while (enabled && epoch === token && pendingLayout) {
        const next = pendingLayout;
        if (!covered(next)) {
          await target.prepare(next.specs, next.settings);
          if (!enabled || token !== epoch) return;
          preparedSignature = next.signature;
          preparedKeys = new Set(next.specs.map(spec => spec.key));
        }
        layout = next;
        if (pendingLayout === next || covered(pendingLayout)) {
          layout = pendingLayout;
          pendingLayout = null;
        }
      }
    })()
      .catch(reason => signalError(reason, token))
      .finally(() => {
        if (token === epoch) preparing = null;
      });
  }
  function ensureLayout() {
    if (!enabled || !dirtyFlag) return measured || layout;
    dirtyFlag = false;
    try {
      updateTiming();
      measured = measureLayout();
      prepareCandidate(measured);
      return measured;
    } catch (reason) {
      signalError(reason, epoch);
      return measured || layout;
    }
  }
  async function flush() {
    while (enabled) {
      ensureLayout();
      const work = preparing;
      if (work) await work;
      if (error) throw error;
      if (!dirtyFlag && !pendingLayout && !preparing) return layout;
    }
    if (error) throw error;
    return null;
  }

  async function enable(nextRenderer, options = {}) {
    if (!nextRenderer || typeof nextRenderer.prepare !== 'function')
      throw new Error('GPU_LINE requires renderer.prepare');
    if (enabled) dispose();
    epoch++;
    renderer = nextRenderer;
    errorCallback = options.onError || null;
    error = null;
    enabled = true;
    layout = measured = pendingLayout = submitted = null;
    preparing = null;
    specs = new Map();
    preparedKeys = new Set();
    preparedSignature = '';
    needPrewarm = true;
    lastTrackX = roundedTrack(springs.track.x);
    idle = caret.classList.contains('idle');
    idleStart = now();
    const blink = caret.getAnimations().find(a => a.animationName === 'blink');
    if (idle && blink) idleStart -= Number(blink.currentTime || 0);
    installStyle();
    updateTiming();
    for (const node of track.querySelectorAll('.ink')) {
      const chunk = node.parentElement,
        state = stateFor(chunk);
      const animation = chunk.getAnimations().find(a => a.animationName === 'inkIn');
      if (animation) state.enteredAt = now() - Number(animation.currentTime || 0);
      scheduleEntryEnd(state);
    }
    for (const node of track.querySelectorAll('.pre.done')) {
      const animation = node.getAnimations().find(a => a.animationName === 'dry');
      sentenceState(node).commitTime = now() - (animation ? Number(animation.currentTime || 0) : timing.dryDuration);
    }
    $('line').classList.add('gpu-line-layout');
    if (!listening) {
      document.fonts?.addEventListener('loadingdone', fontEvent);
      addEventListener('resize', resizeEvent);
      listening = true;
    }
    dirty('enable');
    try {
      await flush();
      return api;
    } catch (reason) {
      dispose();
      throw reason;
    }
  }
  function dispose() {
    enabled = false;
    epoch++;
    if (listening) {
      document.fonts?.removeEventListener('loadingdone', fontEvent);
      removeEventListener('resize', resizeEvent);
      listening = false;
    }
    for (const state of runs.values()) if (state.timer !== null) clearTimeout(state.timer);
    runs.clear();
    sentences.clear();
    eventPacket = null;
    eventPacketKey = '';
    renderer = null;
    layout = measured = pendingLayout = preparing = submitted = null;
    specs.clear();
    preparedKeys.clear();
    dirtyFlag = true;
  }
  function addChunk(node) {
    if (!enabled) return null;
    const state = stateFor(node, true);
    state.enteredAt = now();
    scheduleEntryEnd(state);
    sentenceState(node.parentElement);
    dirty('add-chunk');
    const value = ensureLayout();
    return { width: value?.byNode.get(node)?.width || 0, caretOffset: value?.caretOffset || 0 };
  }
  function commit(node) {
    if (!enabled || !node) return;
    const sentence = sentenceState(node);
    sentence.commitTime = now();
    events.push({ name: 'dry', time: sentence.commitTime, id: sentence.id });
    dirty('commit');
  }
  function showBox(on) {
    if (!enabled) return;
    const next = !on;
    if (next !== idle) {
      idle = next;
      idleStart = now();
      eventPacketKey = '';
    }
  }
  function trim() {
    if (!enabled) return false;
    ensureLayout();
    const view = measured || layout;
    if (!view) return true;
    const left = view.lineRect.left - 40,
      x = roundedTrack(springs.track.x);
    let shift = 0;
    for (const entry of view.sentenceRects) {
      if (!entry.node.classList.contains('sent')) break;
      if (entry.rect.right + x > left) break;
      entry.node.remove();
      shift += entry.rect.width;
    }
    if (shift) {
      springs.track.shift(shift);
      lastTrackX = roundedTrack(springs.track.x);
      dirty('trim');
      ensureLayout();
    }
    return true;
  }
  function restart() {
    for (const state of runs.values()) if (state.timer !== null) clearTimeout(state.timer);
    runs.clear();
    sentences.clear();
    events.length = 0;
    if (enabled) {
      lastTrackX = roundedTrack(springs.track.x);
      dirty('restart');
    }
  }
  function sampleRun(entry, time, trackX) {
    const { state, sentence, spec, box } = entry,
      age = time - state.enteredAt;
    const progress = Number.isFinite(age) ? clamp01(age / Math.max(0.001, state.duration)) : 1;
    const easedProgress = progress >= 1 ? 1 : state.ease(progress);
    const committed = sentence.commitTime !== null,
      commitAge = committed ? Math.max(0, time - sentence.commitTime) : 0;
    const opacity = (0.6 + (committed ? 0.26 * timing.opacity(clamp01(commitAge / 800)) : 0)) * clamp01(easedProgress);
    const underlineFraction = !entry.isChunk ? 0 : committed ? 1 - timing.underline(clamp01(commitAge / 900)) : 1;
    let dryAlpha = 0;
    if (committed && commitAge < timing.dryDuration) {
      const t = commitAge / timing.dryDuration;
      dryAlpha = 0.2 * (t < 0.35 ? timing.dry(t / 0.35) : 1 - timing.dry((t - 0.35) / 0.65));
    }
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
  function eventFrame(time, trackX) {
    lastTrackX = roundedTrack(trackX);
    const key = [
      epoch,
      layout.version,
      dirtySerial,
      idle,
      idleStart,
      TUNE.baseA,
      TUNE.baseLift,
      LAB.ground,
      paperValue,
    ].join('/');
    if (eventPacket && key === eventPacketKey) return eventPacket;
    eventPacketKey = key;
    const L = layout;
    const model = eventData({
      version: 1,
      kind: 'text',
      timeOrigin: performance.timeOrigin,
      runs: L.runs.map(entry => ({
        state: entry.state,
        sentence: entry.sentence,
        spec: {
          key: entry.spec.key,
          text: entry.spec.text,
          width: entry.spec.width,
          height: entry.spec.height,
          fontSize: entry.spec.fontSize,
        },
        box: entry.box,
        rect: entry.rect,
        isChunk: entry.isChunk,
        lang: entry.lang,
        inkColor: entry.inkColor,
      })),
      timing,
      caretRect: L.caretRect,
      lineRect: L.lineRect,
      idle,
      idleStart,
      trackX: lastTrackX,
    });
    eventPacket = {
      generation: ++generation,
      frameTimeMs: time,
      layoutVersion: L.version,
      W: L.W,
      H: L.H,
      viewportCss: [L.W, L.H],
      dpr: L.dpr,
      animationModel: model,
      trackX: lastTrackX,
      baseA: TUNE.baseA,
      baseLift: TUNE.baseLift,
      groundEnabled: LAB.ground,
      paperValue,
      pending: !!(dirtyFlag || pendingLayout || preparing),
      _layout: L,
      _epoch: epoch,
    };
    return eventPacket;
  }
  function frame(time = now(), trackX = springs.track.x) {
    if (!enabled) return null;
    ensureLayout();
    if (!layout) return null;
    if (renderer.workerAnimation) return eventFrame(time, trackX);
    lastTrackX = roundedTrack(trackX);
    const items = layout.runs.map(entry => sampleRun(entry, time, lastTrackX));
    const clip = { ...layout.lineRect, fadeStart: 0.03, fadeEnd: 0.42 },
      c = layout.caretRect;
    const caretAlpha = idle && (Math.max(0, time - idleStart) % 1100) / 1100 >= 0.5 ? 0 : 0.7;
    return {
      generation: ++generation,
      frameTimeMs: time,
      layoutVersion: layout.version,
      W: layout.W,
      H: layout.H,
      viewportCss: [layout.W, layout.H],
      dpr: layout.dpr,
      runs: items,
      items,
      clip,
      lineRect: clip,
      caret: {
        x: c.x + lastTrackX,
        y: c.y,
        width: c.width,
        height: c.height,
        alpha: caretAlpha,
        color: [26 / 255, 31 / 255, 27 / 255, 1],
        radius: 1,
      },
      trackX: lastTrackX,
      baseA: TUNE.baseA,
      baseLift: TUNE.baseLift,
      groundEnabled: LAB.ground,
      paperValue: paperValue,
      pending: !!(dirtyFlag || pendingLayout || preparing),
      _layout: layout,
      _epoch: epoch,
    };
  }
  function ack(packet, sample) {
    if (!enabled || !packet || packet._epoch !== epoch) return;
    if (packet.animationModel && !sample) return;
    submitted = sample ? { ...packet, ...sample, _layout: packet._layout, _epoch: packet._epoch } : packet;
  }
  function sample(value) {
    if (!value || value.generation == null) return;
    const packet = eventPacket?.generation === value?.generation ? eventPacket : submitted;
    if (packet?.generation === value?.generation && (value.epoch ?? packet._epoch) === packet._epoch)
      ack(packet, value);
  }
  function counters() {
    return {
      dirtySerial,
      layoutGeneration,
      layoutVersion: layout?.version || 0,
      layoutFlushes,
      dirtyReasons: dirtyReasons.slice(),
      geometryReads,
    };
  }
  function debugSnapshot() {
    const packet = submitted;
    if (!enabled || !packet)
      return {
        active: false,
        frameTimeMs: null,
        submittedGeneration: 0,
        pending: !!(enabled && (dirtyFlag || pendingLayout || preparing)),
        error: error?.message || null,
        counters: counters(),
        events: events.slice(),
      };
    const shifts = new Map(packet.runs.map(run => [run.id, run.translateY])),
      glyphs = {};
    for (const glyph of packet._layout.glyphs) {
      const r = glyph.rect,
        dy = shifts.get(glyph.runId) || 0;
      glyphs[glyph.key] = { x: r.x + packet.trackX, y: r.y + dy, width: r.width, height: r.height };
    }
    const animations = packet.runs
      .filter(run => run.animation.phase !== 'after')
      .map(run => ({
        ...run.animation,
        submittedGeneration: packet.generation,
        glyphs: packet._layout.glyphs.filter(g => g.runId === run.id).map(g => g.key),
      }));
    return {
      active: true,
      frameTimeMs: packet.frameTimeMs,
      submittedGeneration: packet.generation,
      layoutVersion: packet.layoutVersion,
      trackX: packet.trackX,
      lineRect: packet.lineRect,
      caret: packet.caret,
      glyphs,
      animations,
      events: events.slice(),
      pending: !!(dirtyFlag || pendingLayout || preparing),
      error: error?.message || null,
      counters: counters(),
    };
  }
  const api = {
    get enabled() {
      return enabled;
    },
    get pending() {
      return !!(enabled && (dirtyFlag || pendingLayout || preparing));
    },
    get error() {
      return error;
    },
    enable,
    dispose,
    dirty,
    addChunk,
    commit,
    showBox,
    trim,
    restart,
    ensureLayout,
    flush,
    frame,
    ack,
    sample,
    markSubmitted: ack,
    debugSnapshot,
  };
  return api;
})();
