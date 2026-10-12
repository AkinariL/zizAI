const GPU_UI = (() => {
  let enabled = false,
    renderer = null,
    onError = null,
    error = null,
    epoch = 0;
  let dirtyFlag = true,
    needPrewarm = true,
    dirtySerial = 0,
    fontGeneration = 0;
  let layoutGeneration = 0,
    layoutFlushes = 0,
    geometryReads = 0,
    generation = 0,
    atlasGeneration = 0;
  let layout = null,
    measured = null,
    pendingLayout = null,
    preparing = null,
    submitted = null;
  let safeLayout = null,
    activeLayout = null,
    atlasSequence = 0;
  let staticLayoutCache = null,
    staticLayoutBuilds = 0,
    staticLayoutHits = 0;
  let preparedSignature = '',
    preparedKeys = new Set(),
    specs = new Map();
  let styleElement = null,
    listening = false,
    probeHost = null,
    timing = null;
  let nextId = 0,
    eventId = 0,
    eventsDropped = 0,
    blinkStart = 0;
  let rawFlip = null,
    lastInput = null,
    coverState = null,
    sealState = null;
  let numberFeatures = null;
  let verticalMeasureCanvas = null,
    verticalMeasure = null;
  const yujiTopBearing = { 字: 77, 在: 45, 入: 156, で: 101, 力: 83, が: 152, 自: 67 };
  const savedNumberFeatures = new Map();
  const rawStates = new Map(),
    candidateStates = new Map(),
    listStates = new Map(),
    verseStates = new Map();
  const events = [],
    dirtyReasons = [];
  let eventPacket = null,
    eventPacketKey = '';
  const clock = () => globalThis.SITE_DEMO_SCHEDULE?.eventNow?.() ?? performance.now();
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const lerpUI = (a, b, t) => a + (b - a) * t;
  const rnum = (n, digits) => Number(Number(n).toFixed(digits));
  const copyRect = r => ({
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
    return copyRect(node.getBoundingClientRect());
  }
  function css(node) {
    geometryReads++;
    return getComputedStyle(node);
  }
  function localRect(r, x, y) {
    return { x: r.x - x, y: r.y - y, width: r.width, height: r.height };
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
  function color(value, fallback = [26 / 255, 31 / 255, 27 / 255, 1]) {
    const match = String(value).match(/^rgba?\(([^)]+)\)/);
    if (!match) {
      const hex = String(value)
        .trim()
        .match(/^#([0-9a-f]{6})$/i);
      return hex ? [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16) / 255).concat(1) : fallback;
    }
    const c = match[1]
      .split(/[\s,\/]+/)
      .filter(Boolean)
      .map(Number);
    return [c[0] / 255, c[1] / 255, c[2] / 255, Number.isFinite(c[3]) ? c[3] : 1];
  }
  function log(name, targetPath, detail = {}) {
    const event = { id: ++eventId, seq: eventId, name, time: clock(), targetPath, ...detail };
    events.push(event);
    if (events.length > 4096) {
      events.shift();
      eventsDropped++;
    }
    return event.id;
  }
  function dirty(reason = 'event') {
    dirtyFlag = true;
    dirtySerial++;
    if (!['set-raw', 'set-candidates', 'remove-old-candidates'].includes(reason)) staticLayoutCache = null;
    dirtyReasons.push({ serial: dirtySerial, reason: String(reason) });
    if (dirtyReasons.length > 64) dirtyReasons.shift();
    if (/font/.test(reason)) fontGeneration++;
    if (/enable|resize|size|font|css|tun|dpr/.test(reason)) needPrewarm = true;
  }
  function applyNumberFeatures() {
    const requested = '"lnum" 1, "tnum" 1';
    if (!numberFeatures)
      numberFeatures = {
        requested,
        descriptorApplied: false,
        pixelsVerified: false,
        restored: false,
        faces: [],
        compatibility:
          'FontFace descriptor support and Canvas glyph selection are browser-dependent. String readback is not proof of matching pixels; verify the captured numeral crop.',
      };
    for (const face of document.fonts || []) {
      const family = String(face.family).replace(/["']/g, '').trim();
      if (
        family.toLowerCase() !== 'cormorant garamond' ||
        String(face.style).trim() !== 'normal' ||
        String(face.weight).trim() !== '500' ||
        savedNumberFeatures.has(face)
      )
        continue;
      const record = {
        family,
        style: face.style,
        weight: face.weight,
        status: face.status,
        original: face.featureSettings,
        requested,
        readback: null,
        descriptorApplied: false,
        restored: false,
        error: null,
      };
      numberFeatures.faces.push(record);
      if (!('featureSettings' in face)) {
        record.error = 'FontFace.featureSettings is unavailable';
        continue;
      }
      savedNumberFeatures.set(face, record);
      try {
        face.featureSettings = requested;
        record.readback = face.featureSettings;
        record.descriptorApplied =
          /["']lnum["'](?:\s+1)?/.test(record.readback) &&
          /["']tnum["'](?:\s+1)?/.test(record.readback) &&
          !/["'](?:lnum|tnum)["']\s+0/.test(record.readback);
      } catch (e) {
        record.error = String(e?.message || e);
      }
    }
    numberFeatures.descriptorApplied =
      numberFeatures.faces.length > 0 && numberFeatures.faces.every(face => face.descriptorApplied);
  }

  const fontEvent = () => {
    if (enabled) applyNumberFeatures();
    dirty('fonts-loadingdone');
  };
  const resizeEvent = () => dirty('resize');
  function installStyle() {
    if (styleElement) return;
    styleElement = document.createElement('style');
    styleElement.dataset.gpuUiLayout = '';
    styleElement.textContent = `
      .gpu-ui-layout #box{visibility:hidden!important;width:240px!important;height:var(--box-h0)!important;opacity:1!important;transform:translate(-50%,-50%)!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
      .gpu-ui-layout #box .raw{transform:none!important}
      .gpu-ui-layout #box .k,.gpu-ui-layout #box .cand{animation:none!important;transition:none!important;transform:none!important;opacity:1!important}
      .gpu-ui-layout #box .cand::before,.gpu-ui-layout #box .rc{animation:none!important}
      .gpu-ui-layout #box .cands.old{transition:none!important;opacity:1!important;transform:translate(-50%,-50%)!important}
      .gpu-ui-layout .verse,.gpu-ui-layout #seal,.gpu-ui-layout #cover{visibility:hidden!important}
      .gpu-ui-layout .v i{transition:none!important;animation:none!important;transform:none!important;filter:none!important;opacity:1!important}
      .gpu-ui-layout #seal{transition:none!important;transform:none!important;opacity:1!important}
      .gpu-ui-layout #cover{transition:none!important}
    `;
    document.head.appendChild(styleElement);
  }
  function curveTiming(c, reduce = true) {
    const duration = reduce && reduceMotion ? 10 : Number((curveT(c) / (SPEED * TUNE.speed)).toFixed(3)) * 1000;
    let ease;
    if (c.type === 'bezier') ease = eventBezier(...c.bz.map(v => Number(v.toFixed(3))));
    else if (!CSS_LINEAR) ease = eventBezier(0.2, 0.8, 0.2, 1);
    else {
      const points = response(c, 48).pts.map(v => Number(v.toFixed(4)));
      points[points.length - 1] = 1;
      ease = value => {
        const t = clamp01(value) * (points.length - 1),
          i = Math.min(points.length - 2, Math.floor(t));
        return lerpUI(points[i], points[i + 1], t - i);
      };
      ease.eventCurve = { type: 'points', points };
    }
    return { duration: Math.max(0.001, duration), ease };
  }
  function updateTiming() {
    timing = {
      key: curveTiming(CURVES.keyIn),
      candidate: curveTiming(CURVES.candIn),
      out: curveTiming(CURVES.candOut, false),
      flip: eventBezier(0.2, 0.8, 0.2, 1),
      pick: eventBezier(0.3, 0.6, 0.3, 1),
      ease: eventBezier(0.25, 0.1, 0.25, 1),
      verseIn: eventBezier(0.3, 0.1, 0.2, 1),
      verseMove: eventBezier(0.16, 0.84, 0.3, 1),
      seal: eventBezier(0.2, 0.9, 0.25, 1.2),
      cover: eventBezier(0.33, 0, 0.15, 1),
    };
  }
  function sampleTransition(t, time) {
    if (!t) return 0;
    const progress = clamp01((time - t.start - t.delay) / Math.max(0.001, t.duration));
    const eased = progress <= 0 ? 0 : progress >= 1 ? 1 : t.ease(progress);
    return lerpUI(t.from, t.to, eased);
  }
  function constant(value) {
    return { from: value, to: value, start: -Infinity, delay: 0, duration: 0, ease: x => x };
  }
  function transition(from, to, start, duration, delay, ease, event) {
    return { from, to, start, duration, delay, ease, eventId: event };
  }
  function sampleVerse(state, time) {
    return {
      opacity: sampleTransition(state.opacity, time),
      blur: sampleTransition(state.blur, time),
      translateY: sampleTransition(state.y, time),
      scale: sampleTransition(state.scale, time),
    };
  }
  function verseState(node) {
    let state = verseStates.get(node);
    if (!state) {
      const shown = node.parentElement.classList.contains('show'),
        c = css(node),
        size = parseFloat(c.fontSize);
      state = {
        id: 'verse-' + ++nextId,
        node,
        size,
        shown,
        delay: parseFloat(c.getPropertyValue('--d')) || 0,
        opacity: constant(shown ? 0.9 : 0),
        blur: constant(shown ? 0 : 7),
        y: constant(shown ? 0 : -0.18 * size),
        scale: constant(shown ? 1 : 1.04),
      };
      state.targetPath = '#' + node.parentElement.parentElement.id + '/' + state.id;
      verseStates.set(node, state);
    }
    return state;
  }
  function candidateState(node, index = 0) {
    let state = candidateStates.get(node);
    if (!state) {
      state = {
        id: 'candidate-' + ++nextId,
        node,
        start: -Infinity,
        delay: 90 + index * 28,
        pickStart: -Infinity,
        eventId: null,
      };
      candidateStates.set(node, state);
    }
    return state;
  }
  function listState(node) {
    if (!node) return null;
    let state = listStates.get(node);
    if (!state) {
      state = {
        id: 'list-' + ++nextId,
        node,
        oldStart: null,
        outStart: null,
        eventId: null,
        halfWidth: 0,
        halfHeight: 0,
        centerAtGone: 1,
        oldTiming: null,
        outTiming: null,
      };
      listStates.set(node, state);
    }
    return state;
  }
  function fontData(node) {
    const c = css(node),
      size = parseFloat(c.fontSize);
    return {
      font: `${c.fontStyle} ${c.fontWeight} ${size}px ${c.fontFamily}`,
      family: c.fontFamily,
      lang: node.closest('[lang]')?.getAttribute('lang') || '',
      fontSize: size,
      letterSpacing: parseFloat(c.letterSpacing) || 0,
      color: color(c.color),
      opacity: Number(c.opacity),
      direction: c.direction,
    };
  }
  function loadedSloganFace(family, text) {
    const code = text.codePointAt(0);
    for (const face of document.fonts || []) {
      if (
        String(face.family).replace(/["']/g, '').trim().toLowerCase() !== family ||
        face.status !== 'loaded' ||
        String(face.style).trim() !== 'normal' ||
        String(face.weight).trim() !== '400'
      )
        continue;
      const covered = String(face.unicodeRange || 'U+0-10FFFF')
        .split(',')
        .some(part => {
          const range = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
          if (!range) return false;
          const first = parseInt(range[1].replace(/\?/g, '0'), 16);
          const last = parseInt(range[2] || range[1].replace(/\?/g, 'F'), 16);
          return code >= first && code <= last;
        });
      if (covered) return true;
    }
    return false;
  }
  function verticalFontOrigin(text, font) {
    const family = String(font.family || '')
      .split(',')[0]
      .replace(/["']/g, '')
      .trim()
      .toLowerCase();
    const fallback = reason => ({ family, source: 'horizontal-font-box', approximate: true, reason, baseline: null });
    if (family !== 'yuji syuku' && family !== 'ma shan zheng')
      return fallback('No vertical metadata for this font family');
    if (!loadedSloganFace(family, text))
      return fallback('Matching font face is not loaded or does not cover this character');
    if (family === 'ma shan zheng' && '字在输入自'.includes(text)) {
      const fontAscent = Math.round(font.fontSize * 0.88),
        fontDescent = Math.round(font.fontSize * 0.12);
      return {
        family,
        source: 'Ma Shan Zheng hhea ascent 880, descent -120 / 1000',
        approximate: true,
        reason: 'Synthetic vertical ascent rounding; platform descent borrowing may differ',
        baseline: fontAscent,
        fontAscent,
        fontDescent,
        alphabeticToCentral: (fontAscent - fontDescent) / 2,
      };
    }
    if (family !== 'yuji syuku' || !Object.hasOwn(yujiTopBearing, text))
      return fallback('Character is outside the recorded vertical metadata');
    try {
      if (!verticalMeasure) {
        verticalMeasureCanvas =
          typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
        verticalMeasureCanvas.width = verticalMeasureCanvas.height = 1;
        verticalMeasure = verticalMeasureCanvas.getContext('2d');
      }
      if (!verticalMeasure) return fallback('Canvas glyph metrics are unavailable');
      verticalMeasure.font = font.font;
      verticalMeasure.textBaseline = 'alphabetic';
      verticalMeasure.direction = font.direction || 'ltr';
      const ascent = verticalMeasure.measureText(text).actualBoundingBoxAscent;
      if (!Number.isFinite(ascent)) return fallback('Canvas glyph ascent is unavailable');
      const fontAscent = Math.round(font.fontSize * 1.16),
        fontDescent = Math.round(font.fontSize * 0.288);
      return {
        family,
        source: 'Yuji Syuku vmtx + current Canvas glyph ascent; hhea 1160/-288 per 1000',
        approximate: true,
        reason: 'Blink vertical-origin and baseline construction; platform hinting/descent borrowing may differ',
        baseline: ascent + (yujiTopBearing[text] * font.fontSize) / 1000,
        glyphAscent: ascent,
        topSideBearing: yujiTopBearing[text],
        fontAscent,
        fontDescent,
        alphabeticToCentral: (fontAscent - fontDescent) / 2,
      };
    } catch (e) {
      return fallback('Canvas glyph metrics failed: ' + String(e?.message || e));
    }
  }
  function specFor(text, font, dpr, blurMax = 0) {
    const verticalLang = blurMax > 0 ? font.lang || '' : '';
    const key = JSON.stringify([fontGeneration, font.font, font.letterSpacing, dpr, blurMax, verticalLang, text]);
    if (specs.has(key)) return specs.get(key);
    const holder = document.createElement('span'),
      textNode = document.createTextNode(text),
      probe = document.createElement('span');
    holder.style.cssText = `display:inline-block;white-space:pre;writing-mode:horizontal-tb;font:${font.font};letter-spacing:${font.letterSpacing}px;line-height:normal;`;
    probe.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline';
    holder.append(textNode, probe);
    probeHost.appendChild(holder);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    geometryReads++;
    const r = copyRect(range.getBoundingClientRect()),
      baseline = rect(probe).top - r.top;
    let advance = r.width,
      verticalPrimaryAscent = null;
    if (blurMax > 0) {
      holder.style.letterSpacing = '0px';
      geometryReads++;
      advance = range.getBoundingClientRect().width;
      holder.lang = verticalLang;
      geometryReads++;
      const languageRange = range.getBoundingClientRect();
      verticalPrimaryAscent = rect(probe).top - languageRange.top;
    }
    holder.remove();
    const verticalFont = blurMax > 0 ? verticalFontOrigin(text, font) : null;
    const spec = {
      key,
      text,
      font: font.font,
      fontSize: font.fontSize,
      letterSpacing: font.letterSpacing,
      direction: font.direction,
      width: r.width,
      height: r.height,
      baseline,
      advance,
      verticalLang,
      verticalPrimaryAscent,
      verticalBaseline: verticalFont?.baseline ?? null,
      verticalFont,
      glyphs: [{ text, x: 0, y: 0 }],
      dpr,
      blurMax,
      plain: true,
    };
    specs.set(key, spec);
    return spec;
  }
  function makeWarmNode(host, kind, lang, weight, text) {
    const node = document.createElement('span');
    node.lang = lang === 'ja' ? 'ja' : 'zh-Hans';
    node.textContent = text;
    if (kind === 'candidate') {
      const parent = document.createElement('span');
      parent.className = 'cand' + (weight === 600 ? ' sel' : '');
      node.className = 't';
      parent.appendChild(node);
      host.appendChild(parent);
    } else if (kind === 'number') {
      const parent = document.createElement('span');
      parent.className = 'cand';
      node.className = 'n';
      parent.appendChild(node);
      host.appendChild(parent);
    } else if (kind === 'raw') {
      node.className = 'raw';
      host.appendChild(node);
    } else {
      const parent = document.createElement('span');
      parent.className = 'meter';
      const label = document.createElement('i');
      label.lang = node.lang;
      label.textContent = text;
      parent.appendChild(label);
      host.appendChild(parent);
      return label;
    }
    return node;
  }
  function prewarm(dpr) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;';
    document.body.appendChild(host);
    try {
      const candidateChars = new Map(),
        rawChars = new Set('n');
      for (const sentence of SCRIPT)
        for (const chunk of sentence.chunks) {
          for (const ch of chunk.keys || '') if (ch !== '|') rawChars.add(ch);
          for (const list of Object.values(chunk.c || {})) {
            const overridden = list[0]?.[0] === '@',
              def = overridden ? list[0].slice(1) : sentence.lang;
            const items = overridden ? list.slice(1) : list;
            items.forEach((item, index) => {
              const [text, lang] = candLang(item, def),
                weight = index === 0 ? 600 : 400,
                key = lang + '/' + weight;
              let group = candidateChars.get(key);
              if (!group) {
                group = { lang, weight, chars: new Set() };
                candidateChars.set(key, group);
              }
              for (const ch of text) group.chars.add(ch);
            });
          }
        }
      for (const { lang, weight, chars } of candidateChars.values()) {
        const node = makeWarmNode(host, 'candidate', lang, weight, '字'),
          font = fontData(node);
        for (const ch of chars) specFor(ch, font, dpr);
        node.parentElement.remove();
      }
      for (const [kind, lang, text] of [
        ['raw', 'zh', [...rawChars].join('')],
        ['number', 'zh', '1234567890'],
        ['meter', 'zh', '中'],
        ['meter', 'ja', '日'],
      ]) {
        const node = makeWarmNode(host, kind, lang, 400, text),
          font = fontData(node);
        for (const ch of text) specFor(ch, font, dpr);
      }
      for (const node of mark.querySelectorAll('.v i')) {
        const font = fontData(node);
        for (const ch of node.textContent) specFor(ch, font, dpr, 7);
      }
    } finally {
      host.remove();
    }
    needPrewarm = false;
  }
  function measureText(node, kind, owner, origin, dpr, output, descriptors, anchor = 'box') {
    const font = fontData(node),
      range = document.createRange(),
      walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const elementRect = rect(node),
      center = { x: elementRect.x + elementRect.width / 2, y: elementRect.y + elementRect.height / 2 };
    let text;
    while ((text = walker.nextNode())) {
      descriptors.set(text, { kind, owner, anchor, center: { x: center.x - origin.x, y: center.y - origin.y } });
      let index = 0;
      for (const char of text.data) {
        range.setStart(text, index);
        range.setEnd(text, index + char.length);
        index += char.length;
        geometryReads++;
        const r = copyRect(range.getBoundingClientRect());
        if (!r.width && !r.height) continue;
        const spec = specFor(char, font, dpr, kind === 'verse' ? 7 : 0);
        let x = r.x - origin.x,
          y = r.y - origin.y;
        if (kind === 'verse') {
          const central = spec.verticalFont?.alphabeticToCentral;
          x =
            Number.isFinite(central) && Number.isFinite(spec.verticalPrimaryAscent)
              ? r.right - origin.x - spec.verticalPrimaryAscent + central - spec.advance / 2
              : center.x - origin.x - spec.advance / 2;
          y +=
            spec.verticalBaseline === null
              ? (r.height - font.letterSpacing - spec.height) / 2
              : spec.verticalBaseline - spec.baseline;
        }
        output.push({
          id: owner?.id || 'meter',
          key: spec.key,
          text: char,
          spec,
          kind,
          owner,
          x,
          y,
          width: spec.width,
          height: spec.height,
          inkColor: font.color,
          opacity: font.opacity,
          anchor,
          center: { x: center.x - origin.x, y: center.y - origin.y },
        });
      }
    }
  }
  function measureLayout() {
    layoutFlushes++;
    const dpr = devicePixelRatio || 1;
    probeHost = document.createElement('div');
    probeHost.setAttribute('aria-hidden', 'true');
    probeHost.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;';
    document.body.appendChild(probeHost);
    try {
      if (needPrewarm) {
        specs = new Map();
        prewarm(dpr);
      }
      const b = rect(box),
        center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const meterOrigin = { x: b.right, y: b.top },
        descriptors = new Map(),
        boxRuns = [],
        swashes = [];
      const rawRect = rect(rawEl),
        wrapRect = rect(cwrap),
        innerRect = rect(inner);
      for (const node of rawEl.children) {
        let state = rawStates.get(node);
        if (!state) {
          state = { id: 'key-' + ++nextId, start: -Infinity, eventId: null };
          rawStates.set(node, state);
        }
        measureText(node, 'raw', state, center, dpr, boxRuns, descriptors);
      }
      for (const list of cwrap.querySelectorAll('.cands')) {
        const group = listState(list);
        const listRect = rect(list);
        group.halfWidth = listRect.width / 2;
        group.halfHeight = listRect.height / 2;
        [...list.children].forEach((node, i) => {
          const state = candidateState(node, i);
          state.group = group;
          for (const part of node.children) measureText(part, 'candidate', state, center, dpr, boxRuns, descriptors);
          if (node.classList.contains('sel')) {
            const r = rect(node),
              c = css(node),
              size = parseFloat(c.fontSize),
              height = 1.42 * size;
            swashes.push({
              x: r.x - center.x - 12,
              y: r.y - center.y + r.height / 2 - 0.44 * height,
              width: r.width + 26,
              height,
              state,
              color: color(
                c.getPropertyValue('--hl'),
                node.dataset.l === 'ja' ? [224 / 255, 142 / 255, 163 / 255, 1] : [111 / 255, 154 / 255, 104 / 255, 1],
              ),
            });
          }
        });
      }
      const cacheMatches =
        staticLayoutCache &&
        staticLayoutCache.specs === specs &&
        staticLayoutCache.dpr === dpr &&
        staticLayoutCache.W === innerWidth &&
        staticLayoutCache.H === innerHeight &&
        staticLayoutCache.fontGeneration === fontGeneration &&
        staticLayoutCache.boxX === b.x &&
        staticLayoutCache.boxY === b.y &&
        staticLayoutCache.boxWidth === b.width &&
        staticLayoutCache.boxHeight === b.height;
      if (!cacheMatches) {
        const staticDescriptors = new Map(),
          meterRuns = [],
          sloganRuns = [];
        for (const node of box.querySelectorAll('.meter i'))
          measureText(node, 'meter', null, meterOrigin, dpr, meterRuns, staticDescriptors, 'meter');
        for (const node of mark.querySelectorAll('.v i')) {
          const state = verseState(node),
            size = parseFloat(css(node).fontSize);
          if (state.size !== size) {
            const ratio = size / state.size;
            state.y = { ...state.y, from: state.y.from * ratio, to: state.y.to * ratio };
            state.size = size;
          }
          measureText(node, 'verse', state, { x: 0, y: 0 }, dpr, sloganRuns, staticDescriptors, 'screen');
        }
        const gauge = rect(box.querySelector('.gauge')),
          bar = rect(box.querySelector('.gauge .bar'));
        staticLayoutCache = {
          specs,
          dpr,
          W: innerWidth,
          H: innerHeight,
          fontGeneration,
          boxX: b.x,
          boxY: b.y,
          boxWidth: b.width,
          boxHeight: b.height,
          meterRuns,
          sloganRuns,
          markGlyphs: measureObservedGlyphs(['mark'], staticDescriptors, center, meterOrigin),
          seal: rect($('seal')),
          mark: rect(mark),
          gauge: localRect(gauge, meterOrigin.x, meterOrigin.y),
          bar: localRect(bar, meterOrigin.x, meterOrigin.y),
          paperColor: color(css(root).getPropertyValue('--paper'), [233 / 255, 236 / 255, 228 / 255, 1]),
        };
        staticLayoutBuilds++;
      } else staticLayoutHits++;
      const staticUI = staticLayoutCache;
      boxRuns.push(...staticUI.meterRuns);
      const glyphs = measureObservedGlyphs(['raw', 'cwrap'], descriptors, center, meterOrigin).concat(
        staticUI.markGlyphs,
      );
      for (const map of [rawStates, candidateStates, listStates, verseStates])
        for (const node of map.keys()) if (!node.isConnected) map.delete(node);
      const rc = rect(box.querySelector('.rc')),
        rule = rect(box.querySelector('.rule'));
      const signature = JSON.stringify([fontGeneration, dpr]);
      return {
        version: ++layoutGeneration,
        dirtySerial,
        W: innerWidth,
        H: innerHeight,
        dpr,
        boxRuns,
        sloganRuns: staticUI.sloganRuns,
        swashes,
        glyphs,
        center,
        rawRect: localRect(rawRect, center.x, center.y),
        wrapRect: localRect(wrapRect, center.x, center.y),
        innerRect,
        seal: staticUI.seal,
        mark: staticUI.mark,
        rule: localRect(rule, center.x, center.y),
        rawCaret: localRect(rc, center.x, center.y),
        gauge: staticUI.gauge,
        bar: staticUI.bar,
        paperColor: staticUI.paperColor,
        signature,
        specs: [...specs.values()],
        settings: { dpr, fontGeneration },
      };
    } finally {
      probeHost.remove();
      probeHost = null;
    }
  }
  function measureObservedGlyphs(ids, descriptors, center, meterOrigin) {
    const glyphs = [],
      range = document.createRange();
    for (const id of ids) {
      const walker = document.createTreeWalker($(id), NodeFilter.SHOW_TEXT);
      let text,
        n = 0;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue;
        const desc = descriptors.get(text) || { kind: 'static', owner: null, anchor: 'screen' };
        for (let i = 0; i < text.textContent.length; i++) {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          geometryReads++;
          const r = copyRect(range.getBoundingClientRect()),
            empty = !r.width && !r.height;
          const origin = desc.anchor === 'screen' ? { x: 0, y: 0 } : desc.anchor === 'meter' ? meterOrigin : center;
          glyphs.push({
            key: `${id}/${n}/${i}/${text.textContent[i]}`,
            rect: empty ? { x: 0, y: 0, width: 0, height: 0 } : localRect(r, origin.x, origin.y),
            empty,
            ...desc,
          });
        }
        n++;
      }
    }
    return glyphs;
  }
  function covered(value) {
    return value.signature === preparedSignature && value.specs.every(spec => preparedKeys.has(spec.key));
  }
  function signalError(reason, token) {
    if (token !== epoch) return;
    error = reason instanceof Error ? reason : Error(String(reason));
    pendingLayout = null;
    onError?.(error);
    siteFatal(error);
  }
  function restoreActiveLayout(target) {
    const meta = target.metadata,
      matches = value =>
        value && value.atlasEpoch === meta.activeAtlasEpoch && value.atlasGeneration === meta.activeAtlasGeneration;
    const restored = [activeLayout, submitted?._layout, safeLayout, layout].find(matches);
    if (!restored) {
      activeLayout = safeLayout = layout = null;
      atlasGeneration = 0;
      preparedSignature = '';
      preparedKeys.clear();
      eventPacket = null;
      eventPacketKey = '';
      return false;
    }
    activeLayout = safeLayout = layout = restored;
    atlasGeneration = restored.atlasGeneration;
    preparedSignature = restored.signature;
    preparedKeys = new Set(restored.specs.map(spec => spec.key));
    eventPacket = null;
    eventPacketKey = '';
    return true;
  }
  function cancelAtlasPreparation(cancelPending = true) {
    if (!enabled) return false;
    if (cancelPending) {
      pendingLayout = null;
      measured = null;
    }
    const restored = renderer.metadata?.atlasHandoffEnabled ? restoreActiveLayout(renderer) : true;
    if (cancelPending || (!restored && !pendingLayout)) dirty('demo-cancel');
    return restored;
  }
  function prepareCandidate(candidate) {
    pendingLayout = candidate;
    if (!preparing && covered(candidate)) {
      candidate.atlasGeneration = atlasGeneration;
      candidate.atlasEpoch = epoch;
      layout = candidate;
      pendingLayout = null;
      return;
    }
    if (preparing) return;
    const token = epoch,
      target = renderer;
    preparing = (async () => {
      while (enabled && token === epoch && pendingLayout) {
        const next = pendingLayout;
        if (!covered(next)) {
          const handoff = target.metadata?.atlasHandoffEnabled === true;
          let settings = next.settings;
          if (handoff) {
            let revokeReady;
            if (
              layout &&
              layout.atlasEpoch === target.metadata.readyAtlasEpoch &&
              layout.atlasGeneration === target.metadata.readyAtlasGeneration &&
              !target.wasAtlasPublished(layout)
            ) {
              revokeReady = { atlasEpoch: layout.atlasEpoch, atlasGeneration: layout.atlasGeneration };
              layout = safeLayout;
              preparedSignature = layout?.signature || '';
              preparedKeys = new Set(layout?.specs.map(spec => spec.key) || []);
            }
            settings = {
              ...next.settings,
              atlasEpoch: token,
              atlasGeneration: ++atlasSequence,
              ...(revokeReady ? { revokeReady } : {}),
            };
          }
          let prepared;
          try {
            prepared = await target.prepare(next.specs, settings);
          } catch (reason) {
            if (reason?.code !== 'UI_ATLAS_CANCELLED') throw reason;
            if (!enabled || token !== epoch) return;
            if (pendingLayout === next) pendingLayout = null;
            if (handoff) restoreActiveLayout(target);
            continue;
          }
          if (!enabled || token !== epoch) return;
          if (handoff && (prepared.atlasEpoch !== token || prepared.atlasGeneration !== settings.atlasGeneration))
            throw Error('UI prepare returned another atlas identity');
          preparedSignature = next.signature;
          preparedKeys = new Set(next.specs.map(spec => spec.key));
          if (handoff) {
            atlasGeneration = prepared.atlasGeneration;
            next.atlasEpoch = prepared.atlasEpoch;
            if (prepared.role === 'active') activeLayout = safeLayout = next;
          } else atlasGeneration++;
        }
        next.atlasGeneration = atlasGeneration;
        next.atlasEpoch = token;
        layout = next;
        if (pendingLayout === next || covered(pendingLayout)) {
          pendingLayout.atlasGeneration = atlasGeneration;
          pendingLayout.atlasEpoch = token;
          layout = pendingLayout;
          pendingLayout = null;
        }
      }
    })()
      .catch(e => signalError(e, token))
      .finally(() => {
        if (token === epoch) {
          preparing = null;
          if (enabled && !error && pendingLayout) prepareCandidate(pendingLayout);
        }
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
    } catch (e) {
      signalError(e, epoch);
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
  function normalizedInput(input = {}) {
    const vis = Number(input.vis ?? springs.vis.x);
    return {
      w: rnum(input.w ?? springs.w.x, 1),
      h: rnum(input.h ?? springs.h.x, 1),
      vis,
      opacity: rnum(clamp01(vis), 3),
      scale: rnum(0.955 + 0.045 * vis, 4),
      dy: rnum((1 - vis) * 8, 2),
      meter: rnum((input.meter ?? st.meter.x) * 100, 1) / 100,
      boxD: input.boxD ?? st.box.D,
      boxT: input.boxT ?? st.box.t,
      boxP: input.boxP ?? st.box.p,
    };
  }
  function sampleEntry(state, time, cfg, offset, delay = 0) {
    const age = time - state.start,
      progress = Number.isFinite(age) ? clamp01((age - delay) / cfg.duration) : 1;
    const eased = progress <= 0 ? 0 : progress >= 1 ? 1 : cfg.ease(progress);
    return { opacity: clamp01(eased), dy: offset * (1 - eased), age, progress, eased };
  }
  function sampleList(group, time) {
    if (!group) return { dx: 0, dy: 0, opacity: 1 };
    let remaining = 0,
      outY = 0,
      opacity = 1;
    if (group.outStart !== null) {
      const cfg = group.outTiming || timing.out,
        age = Math.max(0, time - group.outStart),
        p = clamp01(age / cfg.duration);
      const eased = p >= 1 ? 1 : p <= 0 ? 0 : cfg.ease(p);
      remaining = (1 - group.centerAtGone) * (1 - eased);
      opacity = 1 - clamp01(age / (cfg.duration * 0.45));
      outY = -7 * eased;
    } else if (group.oldStart !== null) {
      const cfg = group.oldTiming || timing.out,
        p = clamp01((time - group.oldStart) / cfg.duration);
      remaining = 1 - (p >= 1 ? 1 : p <= 0 ? 0 : cfg.ease(p));
    }
    return { dx: group.halfWidth * remaining, dy: group.halfHeight * remaining + outY, opacity };
  }
  function sampleCandidate(state, time) {
    const entry = sampleEntry(state, time, timing.candidate, 6, state.delay),
      group = sampleList(state.group, time);
    return { ...entry, opacity: entry.opacity * group.opacity, dx: group.dx, dy: entry.dy + group.dy };
  }
  function flipX(time) {
    if (!rawFlip) return 0;
    const p = clamp01((time - rawFlip.start) / 260);
    return rawFlip.delta * (1 - (p >= 1 ? 1 : timing.flip(p)));
  }
  function animationRecord(name, targetPath, state, time, duration, delay, eased, property) {
    const currentTime = time - state.start,
      progress = clamp01((currentTime - delay) / Math.max(0.001, duration));
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
      const t = state[key];
      if (!Number.isFinite(t.start) || time - t.start >= t.delay + t.duration) continue;
      const p = clamp01((time - t.start - t.delay) / Math.max(0.001, t.duration));
      output.push(
        animationRecord(name, targetPath, t, time, t.duration, t.delay, p <= 0 ? 0 : p >= 1 ? 1 : t.ease(p), property),
      );
    }
  }
  function eventFrame(time, input) {
    const L = layout;
    const key = [epoch, L.version, L.atlasEpoch, L.atlasGeneration, dirtySerial, eventId, LAB.glass, reduceMotion].join(
      '/',
    );
    if (eventPacket && key === eventPacketKey) return eventPacket;
    eventPacketKey = key;
    lastInput = normalizedInput(input);
    const model = eventData({
      version: 1,
      kind: 'ui',
      timeOrigin: performance.timeOrigin,
      layout: {
        version: L.version,
        atlasEpoch: L.atlasEpoch,
        atlasGeneration: L.atlasGeneration,
        W: L.W,
        H: L.H,
        dpr: L.dpr,
        center: L.center,
        boxRuns: L.boxRuns,
        swashes: L.swashes,
        sloganRuns: L.sloganRuns,
        seal: L.seal,
        rule: L.rule,
        rawCaret: L.rawCaret,
        bar: L.bar,
        gauge: L.gauge,
        paperColor: L.paperColor,
        mark: L.mark,
      },
      timing,
      rawFlip,
      sealState,
      coverState,
      blinkStart,
      reduceMotion,
      input: lastInput,
    });
    eventPacket = {
      generation: ++generation,
      frameTimeMs: time,
      layoutVersion: L.version,
      atlasGeneration: L.atlasGeneration,
      atlasEpoch: L.atlasEpoch ?? epoch,
      W: L.W,
      H: L.H,
      viewportCss: [L.W, L.H],
      dpr: L.dpr,
      animationModel: model,
      pending: !!(dirtyFlag || pendingLayout || preparing),
      _layout: L,
      _epoch: epoch,
    };
    return eventPacket;
  }
  function frame(time = clock(), input = {}) {
    if (!enabled) return null;
    ensureLayout();
    if (!layout) return null;
    if (renderer.workerAnimation) return eventFrame(time, input);
    const value = normalizedInput(input);
    lastInput = value;
    const L = layout,
      pmix = sstep(0.12, 0.88, value.boxP),
      mix = (a, b, alpha) => a.map((n, i) => (lerpUI(n, b[i], pmix) | 0) / 255).concat(alpha);
    const acc = mix([85, 122, 81], [201, 116, 137], 1),
      edge = mix([52, 72, 54], [150, 86, 104], 0.15),
      shade = mix([34, 52, 38], [92, 48, 62], 0.4);
    const green = [214 / 255, 231 / 255, 204 / 255, 0.74],
      pink = [248 / 255, 220 / 255, 228 / 255, 0.78],
      e = 1.35 - value.boxT * 1.7;
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
            ),
          );
        const group = run.owner.group;
        if (group && !seen.has(group.id)) {
          const start = group.outStart ?? group.oldStart,
            cfg = (group.outStart === null ? group.oldTiming : group.outTiming) || timing.out;
          if (start !== null && time - start < cfg.duration) {
            const t = { start, eventId: group.outStart === null ? group.oldEventId : group.eventId },
              p = clamp01((time - start) / cfg.duration);
            animations.push(
              animationRecord('transform', '#cwrap/' + group.id, t, time, cfg.duration, 0, cfg.ease(p), 'transform'),
            );
          }
          seen.add(group.id);
        }
      } else if (run.anchor === 'meter') {
        x += value.w / 2;
        y -= value.h / 2;
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
    if (rawFlip && time - rawFlip.start < 260) {
      const p = clamp01((time - rawFlip.start) / 260);
      animations.push(animationRecord('transform', '#raw', rawFlip, time, 260, 0, timing.flip(p), 'transform'));
    }
    const swashes = L.swashes.map(swash => {
      const sample = sampleCandidate(swash.state, time),
        age = time - swash.state.pickStart,
        duration = reduceMotion ? 10 : 360;
      let p = 0;
      if (age >= 0 && age < duration) {
        const t = age / duration;
        p = t < 0.4 ? timing.pick(t / 0.4) : 1 - timing.pick((t - 0.4) / 0.6);
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
      by = L.center.y + value.dy;
    const packet = {
      generation: ++generation,
      frameTimeMs: time,
      layoutVersion: L.version,
      atlasGeneration: L.atlasGeneration,
      W: L.W,
      H: L.H,
      viewportCss: [L.W, L.H],
      dpr: L.dpr,
      atlasEpoch: L.atlasEpoch ?? epoch,
      box: {
        x: bx,
        y: by,
        width: value.w,
        height: value.h,
        scale: value.scale,
        opacity: value.opacity,
        radius: 18,
        acc,
        edge,
        shade,
        glass: !!LAB.glass,
        ground: [252 / 255, 252 / 255, 249 / 255, 0.6],
        tint: {
          out: value.boxD ? pink : green,
          in: value.boxD ? green : pink,
          start: rnum((e - 0.35) * 100, 1) / 100,
          end: rnum((e + 0.35) * 100, 1) / 100,
        },
      },
      boxRuns,
      sloganRuns,
      swashes,
      rule: { ...L.rule, color: [26 / 255, 31 / 255, 27 / 255, 0.34], opacity: 0.5 },
      rawCaret: { ...L.rawCaret, color: acc, opacity: Math.max(0, time - blinkStart) % 1060 >= 530 ? 0 : 1, radius: 1 },
      meter: {
        bar: {
          x: L.bar.x + value.w / 2,
          y: L.bar.y - value.h / 2,
          width: L.bar.width,
          height: L.bar.height,
          opacity: 0.45,
          color0: [85 / 255, 122 / 255, 81 / 255, 1],
          color1: [201 / 255, 116 / 255, 137 / 255, 1],
        },
        dot: {
          x: L.gauge.x + value.w / 2 + L.gauge.width * value.meter - 3.5,
          y: L.gauge.y - value.h / 2,
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
          x: bx - (value.w * value.scale) / 2,
          y: by - (value.h * value.scale) / 2,
          width: value.w * value.scale,
          height: value.h * value.scale,
        },
        slogan: L.mark,
      },
      pending: !!(dirtyFlag || pendingLayout || preparing),
      _layout: L,
      _epoch: epoch,
      _transforms: transforms,
      _input: value,
    };
    return packet;
  }
  function beforeRaw() {
    if (!enabled) return null;
    const L = ensureLayout(),
      v = normalizedInput();
    return L ? L.center.x + (L.rawRect.x + flipX(clock())) * v.scale : 0;
  }
  function afterRaw(letters, before) {
    if (!enabled) return;
    const time = clock(),
      id = log('setRaw', '#raw', { time, text: letters.map(l => l.c).join('') });
    rawStates.clear();
    [...rawEl.children].forEach((node, i) =>
      rawStates.set(node, { id: 'key-' + ++nextId, start: letters[i]?.fresh ? time : -Infinity, eventId: id }),
    );
    const oldFlip = flipX(time);
    dirty('set-raw');
    const L = ensureLayout(),
      v = normalizedInput();
    const after = L ? L.center.x + (L.rawRect.x + oldFlip) * v.scale : before;
    if (letters.length > 1 && Math.abs(before - after) > 0.5)
      rawFlip = { start: time, delta: before - after, eventId: id };
  }
  function beforeCands(node = curList) {
    if (!enabled || !node) return;
    const state = listState(node),
      r = rect(node);
    state.halfWidth = r.width / 2;
    state.halfHeight = r.height / 2;
    state.oldStart = clock();
    state.oldTiming = timing.out;
    state.centerAtGone = 0;
    state.oldEventId = log('candidatesOld', '#cwrap/' + state.id, { time: state.oldStart });
  }
  function afterCands(node = curList) {
    if (!enabled) return;
    const time = clock(),
      id = log('setCands', '#cwrap', { time, text: node?.textContent || '' });
    if (node) {
      listState(node);
      [...node.children].forEach((li, i) => {
        const s = candidateState(li, i);
        s.start = time;
        s.eventId = id;
      });
    }
    dirty('set-candidates');
  }
  function oldGone(node) {
    if (!enabled || !node) return;
    const state = listState(node),
      time = clock(),
      cfg = state.oldTiming || timing.out;
    const p = state.oldStart === null ? 1 : clamp01((time - state.oldStart) / cfg.duration);
    state.centerAtGone = p >= 1 ? 1 : p <= 0 ? 0 : cfg.ease(p);
    state.outStart = time;
    state.outTiming = timing.out;
    state.eventId = log('candidatesGone', '#cwrap/' + state.id, { time });
  }
  function removeOld(node) {
    if (!enabled) return;
    listStates.delete(node);
    dirty('remove-old-candidates');
  }
  function pick(node = curList?.firstChild) {
    if (!enabled || !node) return;
    const state = candidateState(node);
    state.pickStart = clock();
    state.pickEventId = log('pick', '#cwrap/' + state.id, { time: state.pickStart });
  }
  function showBox(on) {
    if (enabled) log('showBox', '#box', { on: !!on });
  }
  function showVerse(index, language) {
    if (!enabled) return;
    const time = clock(),
      id = log('showVerse', '#col' + index, { time, language });
    for (const v of cols[index].children)
      for (const node of v.children) {
        const state = verseState(node),
          shown = v.dataset.l === language;
        if (shown === state.shown) continue;
        const current = sampleVerse(state, time),
          delay = state.delay + (shown ? 200 : 0);
        state.shown = shown;
        state.opacity = transition(
          current.opacity,
          shown ? 0.9 : 0,
          time,
          shown ? 1100 : 450,
          delay,
          shown ? timing.verseIn : timing.ease,
          id,
        );
        state.blur = transition(
          current.blur,
          shown ? 0 : 7,
          time,
          shown ? 1200 : 450,
          delay,
          shown ? timing.verseIn : timing.ease,
          id,
        );
        state.y = transition(
          current.translateY,
          shown ? 0 : -0.18 * state.size,
          time,
          shown ? 1400 : 450,
          delay,
          shown ? timing.verseMove : timing.ease,
          id,
        );
        state.scale = transition(
          current.scale,
          shown ? 1 : 1.04,
          time,
          shown ? 1400 : 450,
          delay,
          shown ? timing.verseMove : timing.ease,
          id,
        );
      }
  }
  function markOn(on) {
    if (!enabled || sealState.shown === !!on) return;
    const time = clock(),
      id = log('markOn', '#mark', { time, on: !!on });
    sealState.shown = !!on;
    sealState.opacity = transition(
      sampleTransition(sealState.opacity, time),
      on ? 0.92 : 0,
      time,
      800,
      1400,
      timing.ease,
      id,
    );
    sealState.scale = transition(
      sampleTransition(sealState.scale, time),
      on ? 1 : 1.12,
      time,
      1000,
      1400,
      timing.seal,
      id,
    );
  }
  function liftCover(time = clock(), duration = OPENING.dur) {
    if (!enabled) return;
    const id = log('liftCover', '#cover', { duration, time });
    coverState = {
      opacity: transition(
        coverState ? sampleTransition(coverState.opacity, time) : 0.999,
        0,
        time,
        duration,
        0,
        timing.cover,
        id,
      ),
    };
  }
  function restart() {
    if (enabled) {
      log('restart', '#box');
      dirty('restart');
    }
  }
  async function enable(nextRenderer, options = {}) {
    if (!nextRenderer || typeof nextRenderer.prepare !== 'function') throw Error('GPU_UI requires renderer.prepare');
    if (enabled) dispose();
    epoch++;
    renderer = nextRenderer;
    onError = options.onError || null;
    error = null;
    enabled = true;
    layout = measured = pendingLayout = preparing = submitted = null;
    safeLayout = activeLayout = null;
    rawFlip = null;
    lastInput = null;
    staticLayoutCache = null;
    rawStates.clear();
    candidateStates.clear();
    listStates.clear();
    verseStates.clear();
    specs = new Map();
    preparedKeys = new Set();
    preparedSignature = '';
    needPrewarm = true;
    updateTiming();
    numberFeatures = null;
    applyNumberFeatures();
    const t = clock(),
      blink = box
        .querySelector('.rc')
        .getAnimations()
        .find(a => a.animationName === 'blink');
    blinkStart = t - Number(blink?.currentTime || 0);
    for (const node of mark.querySelectorAll('.v i')) verseState(node);
    sealState = {
      shown: mark.classList.contains('on'),
      opacity: constant(mark.classList.contains('on') ? 0.92 : 0),
      scale: constant(mark.classList.contains('on') ? 1 : 1.12),
    };
    const cover = $('cover');
    coverState = cover ? { opacity: constant(cover.classList.contains('off') ? 0 : 0.999) } : null;
    for (const node of rawEl.children) {
      const animation = node.getAnimations().find(a => a.animationName === 'keyIn');
      rawStates.set(node, {
        id: 'key-' + ++nextId,
        start: animation ? t - Number(animation.currentTime || 0) : -Infinity,
        eventId: null,
      });
    }
    for (const list of cwrap.querySelectorAll('.cands')) {
      const group = listState(list);
      if (list.classList.contains('gone')) group.outStart = t - timing.out.duration;
      [...list.children].forEach((node, i) => {
        const state = candidateState(node, i),
          animation = node.getAnimations().find(a => a.animationName === 'candIn');
        state.start = animation ? t - Number(animation.currentTime || 0) : -Infinity;
      });
    }
    installStyle();
    root.classList.add('gpu-ui-layout');
    if (!listening) {
      document.fonts?.addEventListener('loadingdone', fontEvent);
      addEventListener('resize', resizeEvent);
      listening = true;
    }
    dirty('enable');
    try {
      await flush();
      return api;
    } catch (e) {
      dispose();
      throw e;
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
    staticLayoutCache = null;
    verticalMeasure = verticalMeasureCanvas = null;
    rawStates.clear();
    candidateStates.clear();
    listStates.clear();
    verseStates.clear();
    savedNumberFeatures.clear();
    eventPacket = null;
    eventPacketKey = '';
    renderer = null;
    safeLayout = activeLayout = null;
    layout = measured = pendingLayout = preparing = submitted = null;
    specs.clear();
    preparedKeys.clear();
    dirtyFlag = true;
  }
  function publish(packet) {
    if (enabled && packet?._epoch === epoch) safeLayout = packet._layout;
  }
  function ack(packet, sample) {
    if (!enabled || !packet || packet._epoch !== epoch || (packet.animationModel && !sample)) return;
    submitted = sample
      ? {
          ...packet,
          ...sample,
          _layout: packet._layout,
          _epoch: packet._epoch,
          _transforms: new Map(Object.entries(sample.transforms || {})),
        }
      : packet;
    if (
      packet._layout?.atlasEpoch === renderer.metadata?.activeAtlasEpoch &&
      packet._layout.atlasGeneration === renderer.metadata?.activeAtlasGeneration
    )
      activeLayout = packet._layout;
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
      geometryReads,
      staticLayoutBuilds,
      staticLayoutHits,
      dirtyReasons: dirtyReasons.slice(),
      eventsDropped,
    };
  }
  function debugSnapshot() {
    const packet = submitted;
    const base = {
      enabled,
      active: !!(enabled && packet),
      pending: !!(enabled && (dirtyFlag || pendingLayout || preparing)),
      error: error?.message || null,
      frameTimeMs: packet?.frameTimeMs ?? null,
      submittedGeneration: packet?.generation || 0,
      counters: counters(),
      events: events.slice(),
      numberFontFeatures: numberFeatures
        ? { ...numberFeatures, faces: numberFeatures.faces.map(face => ({ ...face })) }
        : null,
    };
    if (!enabled || !packet) return { ...base, glyphs: {}, animations: [] };
    const glyphs = {},
      b = packet.box;
    for (const glyph of packet._layout.glyphs) {
      if (glyph.empty) {
        glyphs[glyph.key] = { ...glyph.rect };
        continue;
      }
      const r = glyph.rect,
        t = packet._transforms.get(glyph.owner?.id) || { x: 0, y: 0, scale: 1 };
      let x = r.x + t.x,
        y = r.y + t.y,
        width = r.width,
        height = r.height;
      if (glyph.kind === 'verse') {
        const c = t.center || glyph.center;
        x = c.x + (r.x - c.x) * t.scale;
        y = c.y + (r.y - c.y) * t.scale + t.y;
        width *= t.scale;
        height *= t.scale;
      } else if (glyph.anchor !== 'screen') {
        if (glyph.anchor === 'meter') {
          x += b.width / 2;
          y -= b.height / 2;
        }
        x = b.x + x * b.scale;
        y = b.y + y * b.scale;
        width *= b.scale;
        height *= b.scale;
      }
      glyphs[glyph.key] = { x, y, width, height };
    }
    return {
      ...base,
      layoutVersion: packet.layoutVersion,
      atlasGeneration: packet.atlasGeneration,
      viewportCss: packet.viewportCss,
      dpr: packet.dpr,
      glyphs,
      crops: packet.crops,
      box: packet.box,
      seal: packet.seal,
      cover: packet.cover,
      verticalFontMetrics: packet._layout.specs
        .filter(spec => spec.verticalFont)
        .map(spec => ({
          text: spec.text,
          fontSize: spec.fontSize,
          lang: spec.verticalLang,
          primaryAscent: spec.verticalPrimaryAscent,
          ...spec.verticalFont,
        })),
      animations: packet.animations.map(a => ({ ...a, submittedGeneration: packet.generation })),
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
    ensureLayout,
    flush,
    beforeRaw,
    afterRaw,
    beforeCands,
    afterCands,
    oldGone,
    removeOld,
    pick,
    showBox,
    showVerse,
    markOn,
    liftCover,
    restart,
    frame,
    ack,
    sample,
    publish,
    cancelAtlasPreparation,
    markSubmitted: ack,
    debugSnapshot,
  };
  return api;
})();
