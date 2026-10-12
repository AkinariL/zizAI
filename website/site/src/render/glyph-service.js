function createGlyphCPUModel() {
  const finite = (x, fallback = 0) => (Number.isFinite(x) ? x : fallback);
  const metricNames = [
    'width',
    'actualBoundingBoxLeft',
    'actualBoundingBoxRight',
    'actualBoundingBoxAscent',
    'actualBoundingBoxDescent',
    'fontBoundingBoxAscent',
    'fontBoundingBoxDescent',
    'emHeightAscent',
    'emHeightDescent',
    'hangingBaseline',
    'alphabeticBaseline',
    'ideographicBaseline',
  ];
  function requests(kind, specs, settings) {
    const result = [],
      seen = new Set();
    for (const raw of specs) {
      const spec = { ...raw, dpr: finite(raw.dpr, finite(settings.dpr, 1)) };
      if (kind === 'text') {
        if (seen.has(spec.key)) throw Error('Duplicate GPU text run key: ' + spec.key);
        seen.add(spec.key);
        if (
          !(spec.fontSize > 0 && spec.width >= 0 && spec.height > 0 && spec.dpr > 0) ||
          !Number.isFinite(spec.baseline) ||
          !spec.font
        )
          throw Error('Invalid GPU text run metrics: ' + spec.key);
      } else if (!(spec.fontSize > 0 && spec.dpr > 0) || !spec.font)
        throw Error('Invalid UI glyph metrics: ' + spec.key);
      if (
        kind === 'seal' &&
        (!(spec.canvasWidth > 0 && spec.canvasHeight > 0) || !Number.isFinite(spec.x) || !Number.isFinite(spec.y))
      )
        throw Error('Invalid seal glyph canvas');
      const placements =
        spec.glyphs ||
        (kind === 'text' ? Array.from(spec.text || '', text => ({ text })) : [{ text: spec.text, x: 0 }]);
      for (const placement of placements)
        result.push({ spec, text: String(placement.text), key: key(kind, spec, String(placement.text), settings) });
    }
    return result;
  }
  function key(kind, spec, text, settings) {
    const dpr = finite(spec.dpr, finite(settings.dpr, 1));
    const fields =
      kind === 'text'
        ? [settings.fontGeneration || 0, spec.font, dpr, spec.direction || 'ltr', text]
        : kind === 'seal'
          ? [
              settings.fontGeneration || 0,
              spec.font,
              dpr,
              text,
              spec.canvasWidth,
              spec.canvasHeight,
              spec.x,
              spec.y,
              spec.textAlign,
              spec.textBaseline,
            ]
          : [settings.fontGeneration || 0, spec.font, dpr, text, Math.max(0, finite(spec.blurMax))];
    if (settings.fontSignature) fields.push(settings.fontSignature);
    return JSON.stringify(fields);
  }
  function sealStroke(c, text, x, y) {
    const H = 17.6,
      W = H * 0.572,
      X = u => x + (u - 0.5) * W,
      Y = v => y + (v - 0.5) * H;
    const line = (a, b, u, v) => {
      c.moveTo(X(a), Y(b));
      c.lineTo(X(u), Y(v));
    };
    const curve = flat => {
      const p = [];
      for (let i = 0; i < flat.length; i += 2) p.push([X(flat[i]), Y(flat[i + 1])]);
      c.moveTo(p[0][0], p[0][1]);
      for (let i = 0; i + 1 < p.length; i++) {
        const a = p[Math.max(0, i - 1)],
          b = p[i],
          d = p[i + 1],
          e = p[Math.min(p.length - 1, i + 2)];
        c.bezierCurveTo(
          b[0] + (d[0] - a[0]) / 6,
          b[1] + (d[1] - a[1]) / 6,
          d[0] - (e[0] - b[0]) / 6,
          d[1] - (e[1] - b[1]) / 6,
          d[0],
          d[1],
        );
      }
    };
    c.beginPath();
    if (text === '字') {
      line(0.5, 0, 0.5, 0.085);
      curve([
        0.03, 1, 0.05, 0.86, 0.06, 0.62, 0.06, 0.32, 0.09, 0.175, 0.2, 0.122, 0.5, 0.115, 0.8, 0.122, 0.91, 0.175, 0.94,
        0.32, 0.94, 0.62, 0.95, 0.86, 0.97, 1,
      ]);
      c.moveTo(X(0.5 + 0.2), Y(0.34));
      c.ellipse(X(0.5), Y(0.34), 0.2 * W, 0.1 * H, 0, 0, Math.PI * 2);
      curve([0.2, 0.455, 0.26, 0.525, 0.36, 0.575, 0.5, 0.598, 0.64, 0.575, 0.74, 0.525, 0.8, 0.455]);
      curve([0.5, 0.44, 0.508, 0.57, 0.505, 0.7, 0.47, 0.82, 0.4, 0.92, 0.3, 0.995]);
    } else if (text === '在') {
      curve([
        0.54, 0.02, 0.41, 0.035, 0.32, 0.09, 0.285, 0.19, 0.285, 0.34, 0.29, 0.5, 0.275, 0.65, 0.225, 0.8, 0.15, 0.925,
        0.085, 0.995,
      ]);
      line(0.03, 0.235, 0.93, 0.235);
      line(0.04, 0.47, 0.44, 0.43);
      line(0.46, 0.575, 0.93, 0.575);
      line(0.695, 0.33, 0.695, 0.765);
      line(0.41, 0.765, 0.985, 0.765);
    } else return false;
    c.lineWidth = 1.05;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.stroke();
    return true;
  }
  function raster(kind, request, measure, canvasFactory, limit) {
    const { spec, text } = request,
      dpr = spec.dpr,
      blur = kind === 'ui' ? Math.max(0, finite(spec.blurMax)) : 0;
    measure.font = spec.font;
    measure.textBaseline = kind === 'seal' ? spec.textBaseline : 'alphabetic';
    measure.textAlign = kind === 'seal' ? spec.textAlign : 'start';
    measure.direction = kind === 'text' ? spec.direction || 'ltr' : 'ltr';
    const m = measure.measureText(text),
      left = -finite(m.actualBoundingBoxLeft),
      top = -finite(m.actualBoundingBoxAscent, spec.fontSize);
    const right = finite(m.actualBoundingBoxRight, m.width),
      bottom = finite(m.actualBoundingBoxDescent, spec.fontSize * 0.25),
      pad = 2 + Math.ceil(blur * dpr * 3);
    const w = kind === 'seal' ? spec.canvasWidth : Math.max(1, Math.ceil((right - left) * dpr) + pad * 2),
      h = kind === 'seal' ? spec.canvasHeight : Math.max(1, Math.ceil((bottom - top) * dpr) + pad * 2);
    if (w > limit || h > limit)
      throw Error(
        kind === 'text' ? 'GPU text glyph exceeds texture dimension limit' : 'UI glyph exceeds device dimension limit',
      );
    const canvas = canvasFactory(w, h),
      context = canvas.getContext('2d');
    if (!context) throw Error('Canvas2D glyph rasterization is unavailable');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = spec.font;
    context.textBaseline = measure.textBaseline;
    context.textAlign = measure.textAlign;
    context.direction = measure.direction;
    context.fillStyle = '#fff';
    if (!(kind === 'seal' && sealStroke(context, text, spec.x, spec.y)))
      context.fillText(text, kind === 'seal' ? spec.x : pad / dpr - left, kind === 'seal' ? spec.y : pad / dpr - top);
    return {
      key: request.key,
      canvas,
      w,
      h,
      dpr,
      blur,
      left: left - pad / dpr,
      top: top - pad / dpr,
      advance: m.width,
      metrics: metricNames.map(name => m[name]),
      font: measure.font,
      direction: measure.direction,
    };
  }
  async function collect(kind, specs, settings, getGlyph, checkpoint) {
    requests(kind, specs, settings);
    const unique = new Map(),
      runs = [],
      uiRuns = new Map();
    for (const raw of specs) {
      const spec = { ...raw, dpr: finite(raw.dpr, finite(settings.dpr, 1)) };
      let placements = spec.glyphs;
      if (!placements && kind === 'text') {
        placements = [];
        let x = 0;
        for (const text of Array.from(spec.text || '')) {
          const glyph = await getGlyph({ spec, text, key: key(kind, spec, text, settings) });
          placements.push({ text, x });
          x += glyph.advance + finite(spec.letterSpacing);
          await checkpoint();
        }
      }
      if (!placements) placements = [{ text: spec.text, x: 0 }];
      let run = { ...spec, glyphs: [] };
      if (kind === 'text') {
        const radiusCss = Number(Math.max(0.01, finite(settings.base, 0.085) * spec.fontSize).toFixed(2));
        const sigmaCss = Number(Math.max(0.01, finite(settings.baseSoft, 0.028) * spec.fontSize).toFixed(2)),
          drySigmaCss = spec.fontSize * 0.2;
        const padding = Math.ceil((Math.max(radiusCss + 3 * sigmaCss + 18, 3 * drySigmaCss, 18) + 2) * spec.dpr);
        run = {
          ...run,
          padding,
          radius: radiusCss * spec.dpr,
          sigma: sigmaCss * spec.dpr,
          drySigma: drySigmaCss * spec.dpr,
          w: Math.max(1, Math.ceil(spec.width * spec.dpr)) + padding * 2,
          h: Math.max(1, Math.ceil(spec.height * spec.dpr)) + padding * 2,
        };
        if (Math.max(run.radius, run.sigma * 3, run.drySigma * 3, spec.dpr * 18) > 256)
          throw Error('GPU text filter exceeds supported local kernel extent');
      }
      for (const placement of placements) {
        const text = String(placement.text),
          glyph = await getGlyph({ spec, text, key: key(kind, spec, text, settings) });
        unique.set(glyph.key, glyph);
        run.glyphs.push({ glyph, x: finite(placement.x), y: finite(placement.y) });
        await checkpoint();
      }
      if (kind === 'text') runs.push(run);
      else uiRuns.set(run.key, run);
    }
    return { runs: kind === 'text' ? runs : [...uiRuns.values()], glyphs: [...unique.values()] };
  }
  function packText(items, limit) {
    const native = typeof getCPUUtilsRuntime === 'function' && getCPUUtilsRuntime('glyph');
    if (native) return native.pack(items, limit);
    const gutter = 2,
      widest = Math.max(1, ...items.map(r => r.w + gutter * 2)),
      area = items.reduce((sum, r) => sum + (r.w + gutter * 2) * (r.h + gutter * 2), 0);
    let width = Math.min(limit, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(widest, Math.sqrt(area))))));
    if (widest > limit) throw Error('GPU text run exceeds texture dimension limit');
    for (;;) {
      let x = gutter,
        y = gutter,
        rowHeight = 0,
        usedWidth = 1;
      for (const rect of items) {
        if (x + rect.w + gutter > width) {
          x = gutter;
          y += rowHeight + gutter * 2;
          rowHeight = 0;
        }
        rect.atlasX = x;
        rect.atlasY = y;
        x += rect.w + gutter * 2;
        rowHeight = Math.max(rowHeight, rect.h);
        usedWidth = Math.max(usedWidth, x);
      }
      const height = Math.max(1, y + rowHeight + gutter);
      if (height <= limit) return { width: Math.min(width, usedWidth), height };
      if (width >= limit) throw Error('GPU text atlas exceeds texture dimension limit');
      width = Math.min(limit, width * 2);
    }
  }
  function packUI(items, limit) {
    const native = typeof getCPUUtilsRuntime === 'function' && getCPUUtilsRuntime('glyph');
    if (native) return native.pack(items, limit, true);
    const widest = Math.max(4, ...items.map(g => g.w + 4));
    let w = Math.min(
      limit,
      Math.max(
        64,
        2 **
          Math.ceil(Math.log2(Math.max(widest, Math.sqrt(items.reduce((sum, g) => sum + (g.w + 4) * (g.h + 4), 0))))),
      ),
    );
    if (widest > limit) throw Error('UI glyph is too large');
    for (;;) {
      let x = 2,
        y = 2,
        row = 0;
      for (const g of items) {
        if (x + g.w + 2 > w) {
          x = 2;
          y += row + 4;
          row = 0;
        }
        g.ax = x;
        g.ay = y;
        x += g.w + 4;
        row = Math.max(row, g.h);
      }
      const h = y + row + 2;
      if (h <= limit) return { w, h };
      if (w >= limit) throw Error('UI glyph atlas exceeds device limits');
      w = Math.min(limit, w * 2);
    }
  }
  function finish(kind, collected, limit, alignment, nativePrewarm = false) {
    const glyphs = collected.glyphs.map(g => ({ ...g })),
      byKey = new Map(glyphs.map(g => [g.key, g]));
    const runs = collected.runs.map(run => ({
      ...run,
      glyphs: run.glyphs.map(p => ({ ...p, glyph: byKey.get(p.glyph.key) })),
    }));
    alignment = Math.max(256, alignment || 256);
    if (kind === 'seal') return { runs: new Map(runs.map(r => [r.key, r])), glyphs };
    if (kind === 'text') {
      const glyphPack = packText(glyphs, limit),
        runPack = packText(runs, limit),
        maxW = Math.max(1, ...runs.map(r => r.w)),
        maxH = Math.max(1, ...runs.map(r => r.h));
      const native = nativePrewarm && typeof getCPUUtilsRuntime === 'function' && getCPUUtilsRuntime('glyph');
      if (native) return { runs, glyphs, glyphPack, runPack, ...native.prewarmText(runs, glyphPack, alignment) };
      const glyphCount = runs.reduce((n, run) => n + run.glyphs.length, 0),
        vertices = new Float32Array(Math.max(1, glyphCount) * 8),
        uniformData = new Float32Array((Math.max(1, runs.length * 12) * alignment) / 4);
      let gi = 0,
        ui = 0;
      const uniform = values => {
        uniformData.set(values, (ui++ * alignment) / 4);
      };
      for (const run of runs) {
        for (const p of run.glyphs) {
          const g = p.glyph;
          vertices.set(
            [
              run.padding + (p.x + g.left) * run.dpr,
              run.padding + (run.baseline + p.y + g.top) * run.dpr,
              g.w,
              g.h,
              g.atlasX / glyphPack.width,
              g.atlasY / glyphPack.height,
              g.w / glyphPack.width,
              g.h / glyphPack.height,
            ],
            gi++ * 8,
          );
        }
        uniform([run.w, run.h, 0, 0]);
        for (const [op, amount] of [
          [0, run.radius],
          [1, run.radius],
          [2, run.sigma],
          [3, run.sigma],
          [4, 0],
          [2, 6 * run.dpr],
          [3, 6 * run.dpr],
          [2, run.drySigma],
          [3, run.drySigma],
        ])
          uniform([maxW, maxH, run.w, run.h, op, amount, 0, 0]);
        uniform([run.atlasX, run.atlasY, run.w, run.h, 0, 0, 0, 0]);
      }
      return { runs, glyphs, glyphPack, runPack, maxW, maxH, vertices, uniformData };
    }
    const size = packUI(glyphs, limit),
      blurred = glyphs.filter(g => g.blur > 0.08),
      maxW = Math.max(1, ...blurred.map(g => g.w)),
      maxH = Math.max(1, ...blurred.map(g => g.h));
    const native = nativePrewarm && typeof getCPUUtilsRuntime === 'function' && getCPUUtilsRuntime('glyph');
    if (native)
      return {
        runs: new Map(runs.map(r => [r.key, r])),
        glyphs,
        size,
        blurred,
        ...native.prewarmUI(blurred, size, alignment),
      };
    const parameters = new Float32Array((alignment * blurred.length * 2) / 4),
      vertices = new Float32Array(blurred.length * 16);
    blurred.forEach((g, i) => {
      parameters.set([maxW, maxH, maxW, maxH, 0, 0, 0, 0], (i * 2 * alignment) / 4);
      parameters.set([size.w, size.h, maxW, maxH, 1, g.ax, g.ay, 0], ((i * 2 + 1) * alignment) / 4);
      vertices.set([0, 0, g.w, g.h, g.blur * g.dpr, 0, 0, 0, g.ax, g.ay, g.w, g.h, g.blur * g.dpr, 0, 0, 0], i * 16);
    });
    return { runs: new Map(runs.map(r => [r.key, r])), glyphs, size, blurred, maxW, maxH, parameters, vertices };
  }
  function sample(glyph) {
    const data = glyph.canvas.getContext('2d').getImageData(0, 0, glyph.w, glyph.h).data;
    return {
      w: glyph.w,
      h: glyph.h,
      left: glyph.left,
      top: glyph.top,
      advance: glyph.advance,
      metrics: glyph.metrics,
      font: glyph.font,
      direction: glyph.direction,
      data,
    };
  }
  function equalSample(a, b) {
    if (!a || !b) return false;
    for (const name of ['w', 'h', 'left', 'top', 'advance', 'font', 'direction']) if (a[name] !== b[name]) return false;
    if (a.metrics.length !== b.metrics.length || a.metrics.some((x, i) => x !== b.metrics[i])) return false;
    if (a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
    return true;
  }
  function sampleDifference(expected, actual) {
    const metrics = [],
      fields = [];
    for (const name of ['w', 'h', 'left', 'top', 'advance', 'font', 'direction'])
      if (expected?.[name] !== actual?.[name])
        fields.push({ name, expected: expected?.[name], actual: actual?.[name] });
    metricNames.forEach((name, i) => {
      if (expected?.metrics[i] !== actual?.metrics[i])
        metrics.push({ name, expected: expected?.metrics[i], actual: actual?.metrics[i] });
    });
    let pixelBytes = 0,
      alphaPixels = 0,
      first = null;
    const bounds = value => {
      if (!value) return null;
      let left = value.w,
        top = value.h,
        right = -1,
        bottom = -1;
      for (let i = 3; i < value.data.length; i += 4)
        if (value.data[i]) {
          const p = (i - 3) / 4,
            x = p % value.w,
            y = Math.floor(p / value.w);
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      return right < 0 ? null : [left, top, right, bottom];
    };
    if (expected && actual)
      for (let i = 0; i < Math.max(expected.data.length, actual.data.length); i++)
        if (expected.data[i] !== actual.data[i]) {
          pixelBytes++;
          if (i % 4 === 3) alphaPixels++;
          if (!first)
            first = {
              x: Math.floor(i / 4) % expected.w,
              y: Math.floor(i / 4 / expected.w),
              channel: i % 4,
              expected: expected.data[i],
              actual: actual.data[i],
            };
        }
    return {
      fields,
      metrics,
      pixelBytes,
      alphaPixels,
      first,
      expectedInkBounds: bounds(expected),
      actualInkBounds: bounds(actual),
    };
  }
  return { requests, key, raster, collect, packText, packUI, finish, sample, equalSample, sampleDifference };
}

function glyphFontContract() {
  const defaults = {
    style: 'normal',
    weight: 'normal',
    stretch: 'normal',
    unicodeRange: 'U+0-10FFFF',
    featureSettings: 'normal',
    variationSettings: 'normal',
    display: 'auto',
    ascentOverride: 'normal',
    descentOverride: 'normal',
    lineGapOverride: 'normal',
    sizeAdjust: '100%',
  };
  const names = Object.keys(defaults),
    rangeCache = new Map(),
    manifestCache = new WeakMap(),
    faceCache = new WeakMap();
  let nextFace = 0;
  const family = value =>
    String(value)
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim()
      .toLowerCase();
  function ranges(value) {
    value = String(value || defaults.unicodeRange);
    if (rangeCache.has(value)) return rangeCache.get(value);
    const result = [];
    for (const part of value.split(',')) {
      const m = part.trim().match(/^U\+([\da-f?]+)(?:-([\da-f]+))?$/i);
      if (!m) throw Error('Unsupported font unicode-range: ' + part);
      const low = parseInt(m[1].replace(/\?/g, '0'), 16),
        high = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'f'), 16);
      if (!(low <= high && high <= 0x10ffff)) throw Error('Invalid font unicode-range');
      result.push([low, high]);
    }
    result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    rangeCache.set(value, result);
    if (rangeCache.size > 1024) rangeCache.delete(rangeCache.keys().next().value);
    return result;
  }
  function canonical(name, value) {
    value = String(value || defaults[name] || '').trim();
    if (name === 'weight')
      return value
        .toLowerCase()
        .replace(/\bnormal\b/g, '400')
        .replace(/\bbold\b/g, '700')
        .replace(/\s+/g, ' ');
    if (name === 'stretch') return value.toLowerCase() === 'normal' ? '100%' : value.toLowerCase();
    if (name === 'unicodeRange') return JSON.stringify(ranges(value));
    return value.toLowerCase().replace(/\s+/g, '').replace(/'/g, '"');
  }
  function descriptors(face) {
    const result = {};
    for (const name of names) result[name] = String(face[name] || defaults[name]);
    return result;
  }
  function fontRequest(font) {
    const match = String(font).match(/([\d.]+)px(?:\/[^\s]+)?\s+(.+)$/i);
    if (!match) throw Error('Unsupported Canvas font shorthand: ' + font);
    const prefix = font.slice(0, match.index),
      familyList = match[2].match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,])+/g) || [];
    const families = familyList.map(family).filter(Boolean),
      weight =
        prefix
          .trim()
          .split(/\s+/)
          .filter(value => /^(?:\d+(?:\.\d+)?|\.\d+|bold)$/i.test(value))
          .pop() || '400';
    const style = /\bitalic\b/.test(prefix) ? 'italic' : /\boblique\b/.test(prefix) ? 'oblique' : 'normal';
    if (!families.length) throw Error('Canvas font has no family');
    const normalized = canonical('weight', weight);
    if (!(Number(normalized) >= 1 && Number(normalized) <= 1000))
      throw Error('Unsupported Canvas font weight: ' + weight);
    return { families, weight: normalized, style };
  }
  function weightRange(value) {
    const values = canonical('weight', value).split(' ').map(Number);
    if (
      !values.length ||
      values.length > 2 ||
      values.some(v => !(v >= 1 && v <= 1000)) ||
      values[0] > values[values.length - 1]
    )
      throw Error('Unsupported font weight descriptor: ' + value);
    return [values[0], values[values.length - 1]];
  }
  function matchingFaces(rows, request) {
    const candidates = rows.filter(row => row.style === request.style && row.stretch === '100%'),
      target = Number(request.weight);
    const exact = candidates.filter(row => row.weight[0] <= target && target <= row.weight[1]);
    if (exact.length) return exact;
    const search =
      target >= 400 && target <= 500
        ? [
            [target, 500, 1],
            [1, target, -1],
            [500, 1000, 1],
          ]
        : target < 400
          ? [
              [1, target, -1],
              [target, 1000, 1],
            ]
          : [
              [target, 1000, 1],
              [1, target, -1],
            ];
    for (const [low, high, direction] of search) {
      let chosen = direction > 0 ? Infinity : -Infinity;
      for (const row of candidates) {
        const start = Math.max(low, row.weight[0]),
          end = Math.min(high, row.weight[1]);
        if (start <= end) chosen = direction > 0 ? Math.min(chosen, start) : Math.max(chosen, end);
      }
      if (Number.isFinite(chosen)) return candidates.filter(row => row.weight[0] <= chosen && chosen <= row.weight[1]);
    }
    return [];
  }
  function base(familyName, values) {
    return JSON.stringify([
      family(familyName),
      ...['style', 'weight', 'stretch', 'unicodeRange'].map(name => canonical(name, values[name])),
    ]);
  }
  function compileEntry(entry) {
    const values = entry.descriptors || {},
      name = family(entry.family);
    return {
      entry,
      values,
      name,
      style: canonical('style', values.style),
      stretch: canonical('stretch', values.stretch),
      weight: weightRange(values.weight),
      range: ranges(values.unicodeRange),
      base: base(name, values),
      effective: null,
      face: null,
      identity: '',
    };
  }
  function documentFace(face) {
    const values = names.map(name => String(face[name] || defaults[name])),
      familyName = String(face.family),
      previous = faceCache.get(face);
    if (previous && previous.family === familyName && previous.values.every((value, i) => value === values[i]))
      return previous;
    const effective = Object.fromEntries(names.map((name, i) => [name, values[i]]));
    const result = {
      id: previous?.id || ++nextFace,
      family: familyName,
      values,
      effective,
      base: base(familyName, effective),
    };
    faceCache.set(face, result);
    return result;
  }
  function snapshot(manifest, fonts, requests) {
    const result = new Map(),
      contexts = [],
      loaded = new Map(),
      parsedFonts = new Map(),
      coverageCache = new Map();
    for (const face of fonts ? Array.from(fonts) : []) {
      if (face.status !== 'loaded') continue;
      const info = documentFace(face),
        identity = info.base;
      if (!loaded.has(identity)) loaded.set(identity, []);
      loaded.get(identity).push(info);
    }
    let byFamily = manifestCache.get(manifest);
    if (!byFamily) {
      byFamily = new Map();
      for (const item of manifest) {
        const row = item.entry && item.base ? item : compileEntry(item);
        if (!byFamily.has(row.name)) byFamily.set(row.name, []);
        byFamily.get(row.name).push(row);
      }
      manifestCache.set(manifest, byFamily);
    }
    for (const rows of byFamily.values())
      for (const row of rows) {
        row.matches = loaded.get(row.base) || [];
        const info = row.matches.length === 1 ? row.matches[0] : null;
        if (!info) continue;
        if (row.effective !== info.effective || row.documentFaceId !== info.id) {
          const entry = row.entry;
          row.effective = info.effective;
          row.documentFaceId = info.id;
          row.face = {
            family: entry.family,
            sourceURL: entry.sourceURL,
            sourceID: entry.sourceID,
            bytes: entry.bytes,
            descriptors: info.effective,
          };
          row.identity = JSON.stringify([
            row.name,
            entry.sourceURL || '',
            entry.sourceID || '',
            info.id,
            info.effective,
          ]);
        }
      }
    for (const request of requests) {
      let parsed = parsedFonts.get(request.spec.font);
      if (!parsed) {
        parsed = fontRequest(request.spec.font);
        parsed.primary = parsed.families[0];
        parsed.relevant = parsed.families.flatMap(name => matchingFaces(byFamily.get(name) || [], parsed));
        parsed.primaryFaces = parsed.relevant.filter(row => family(row.entry.family) === parsed.primary);
        if (!parsed.primaryFaces.length) throw Error('Original source unavailable for primary font ' + parsed.primary);
        for (const row of parsed.relevant) if (row.matches.length === 1) result.set(row.identity, row.face);
        parsedFonts.set(request.spec.font, parsed);
      }
      const coverageKey = request.spec.font + '\0' + request.text;
      let context = coverageCache.get(coverageKey);
      if (context === undefined) {
        const used = new Set();
        for (const text of Array.from(request.text)) {
          const cp = text.codePointAt(0),
            covered = parsed.primaryFaces.filter(row => row.range.some(([a, b]) => cp >= a && cp <= b));
          if (!covered.length) throw Error('Primary font unicode-range does not cover U+' + cp.toString(16));
          for (const row of covered) used.add(row);
        }
        const identities = [];
        for (const row of used) {
          if (row.matches.length !== 1)
            throw Error(
              row.matches.length
                ? 'Ambiguous loaded font face ' + row.entry.family
                : 'Font face is not loaded: ' + row.entry.family,
            );
          identities.push(row.identity);
        }
        if (request.text && !identities.length) throw Error('No loaded font for glyph');
        context = identities.sort().join('|');
        coverageCache.set(coverageKey, context);
      }
      contexts.push(context);
    }
    const faces = [...result.entries()].sort(([a], [b]) => a.localeCompare(b));
    return {
      faces: faces.map(([, face]) => face),
      signature: JSON.stringify(faces.map(([identity]) => identity)),
      contexts,
    };
  }
  return { defaults, family, ranges, canonical, descriptors, fontRequest, compileEntry, snapshot };
}

function createGlyphPreparationService(options = {}) {
  const model = createGlyphCPUModel(),
    contract = glyphFontContract(),
    clients = new Map(),
    jobs = [],
    valid = new Map(),
    signatures = new Map();
  const metadata = {
    backend: 'shared-cpu-glyph-worker',
    mode: 'main',
    tasks: 0,
    workerRasterTasks: 0,
    workerPackTasks: 0,
    mainRasterTasks: 0,
    fontRestarts: 0,
    validationSamples: 0,
    validationFailures: 0,
    validationDifferences: [],
    workerWallMs: 0,
    jobWallMs: 0,
    mainFontSnapshotActiveMs: 0,
    mainValidationActiveMs: 0,
    mainRasterActiveMs: 0,
    mainPackingActiveMs: 0,
    mainGlyphBytes: 0,
    workerGlyphBytes: 0,
    cpuGlyphBytes: 0,
    transferredBitmaps: 0,
    closedBitmaps: 0,
    openBitmaps: 0,
    workerFontFaces: 0,
    workerFontSources: 0,
    workerFontSourceBytes: 0,
    validationCacheEntries: 0,
    pending: 0,
    peakPending: 0,
    workerPending: 0,
    peakWorkerPending: 0,
    warnings: [],
    closed: false,
    validation:
      options.validation === 'all'
        ? 'all used glyphs; exact metrics and RGBA'
        : 'one used glyph per effective face/font/DPR/direction/blur; exact metrics and RGBA',
  };
  if (typeof nativeTransportStats === 'function') metadata.transport = nativeTransportStats();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    fonts = () => options.fonts || self.fonts;
  const canvasFactory = options.canvasFactory || ((w, h) => new OffscreenCanvas(w, h));
  let disposed = false,
    active = null,
    nextOwner = 0,
    nextSignature = 0,
    manifest = [],
    manifestGeneration = 0,
    manifestReady = Promise.resolve();
  const warn = message => {
    if (!metadata.warnings.includes(message)) {
      metadata.warnings.push(message);
      if (metadata.warnings.length > 12) metadata.warnings.shift();
    }
  };
  const abort = () => {
    const error = Error('Glyph preparation cancelled or disposed');
    error.name = 'AbortError';
    return error;
  };
  const check = job => {
    if (disposed || job.client.released || job.cancelled) throw abort();
  };
  function closeGlyph(glyph) {
    if (!glyph.bitmap) return;
    glyph.bitmap.close();
    glyph.bitmap = null;
    if (glyph.deliveredBitmap) {
      glyph.deliveredBitmap = false;
      metadata.closedBitmaps++;
      metadata.openBitmaps--;
    }
  }
  function closeBitmaps(packet) {
    for (const glyph of packet?.glyphs || []) closeGlyph(glyph);
  }
  function closePacket(packet) {
    closeBitmaps(packet);
    packet?.releaseData?.();
  }
  function signatureKey(signature) {
    if (!signatures.has(signature)) {
      signatures.set(signature, manifestGeneration + ':' + ++nextSignature);
      if (signatures.size > 32) signatures.delete(signatures.keys().next().value);
    }
    return signatures.get(signature);
  }
  function validationResult(key, result) {
    valid.delete(key);
    valid.set(key, result);
    if (valid.size > 256) valid.delete(valid.keys().next().value);
    metadata.validationCacheEntries = valid.size;
  }
  function memory() {
    metadata.mainGlyphBytes = metadata.workerGlyphBytes = 0;
    for (const client of clients.values()) {
      metadata.mainGlyphBytes += [...client.cache.values()].reduce((n, g) => n + g.w * g.h * 4, 0);
      metadata.workerGlyphBytes += client.workerGlyphBytes;
    }
    metadata.cpuGlyphBytes = metadata.mainGlyphBytes + metadata.workerGlyphBytes;
  }
  async function run(job) {
    check(job);
    await manifestReady;
    check(job);
    metadata.tasks++;
    const start = now(),
      { client, specs, limits } = job,
      kind = client.kind;
    const requests = model.requests(kind, specs, job.settings);
    let snapshot = null,
      fallbackReason = '',
      settings = { ...job.settings },
      packet;
    const currentSnapshot = () => {
      const t = now();
      try {
        return contract.snapshot(manifest, fonts(), requests);
      } finally {
        metadata.mainFontSnapshotActiveMs += now() - t;
      }
    };
    const mainSignature = () =>
      signatureKey(
        'main:' + JSON.stringify(Array.from(fonts() || []).map(f => [f.family, f.status, contract.descriptors(f)])),
      );
    try {
      snapshot = currentSnapshot();
    } catch (error) {
      fallbackReason = String(error.message || error);
    }
    settings.fontSignature = snapshot ? signatureKey(snapshot.signature) : mainSignature();
    if (!packet) {
      check(job);
      if (fallbackReason && metadata.mode !== 'main') warn('Page glyph fallback: ' + fallbackReason);
      if (snapshot) {
        try {
          snapshot = currentSnapshot();
          settings.fontSignature = signatureKey(snapshot.signature);
        } catch {
          settings.fontSignature = mainSignature();
        }
      }
      if (client.signature !== settings.fontSignature) {
        for (const g of client.cache.values()) g.canvas.width = g.canvas.height = 1;
        client.cache.clear();
        client.signature = settings.fontSignature;
      }
      const measure = canvasFactory(1, 1).getContext('2d');
      if (!measure) throw Error('Canvas2D glyph metrics unavailable');
      let slice = now(),
        rasterizations = 0;
      const checkpoint = async () => {
        check(job);
        if (now() - slice >= 2) {
          await new Promise(resolve => setTimeout(resolve, 0));
          slice = now();
          check(job);
        }
      };
      const collected = await model.collect(
        kind,
        specs,
        settings,
        request => {
          if (!client.cache.has(request.key)) {
            const t = now();
            client.cache.set(request.key, model.raster(kind, request, measure, canvasFactory, limits.limit));
            metadata.mainRasterActiveMs += now() - t;
            rasterizations++;
          }
          return client.cache.get(request.key);
        },
        checkpoint,
      );
      check(job);
      metadata.mainRasterTasks++;
      if (!packet) {
        const t = now();
        packet = model.finish(kind, collected, limits.limit, limits.alignment, options.nativePrewarm === true);
        metadata.mainPackingActiveMs += now() - t;
      }
      for (const glyph of packet.glyphs) glyph.canvas = client.cache.get(glyph.key).canvas;
      const wanted = new Set(packet.glyphs.map(g => g.key));
      for (const [key, glyph] of client.cache)
        if (!wanted.has(key)) {
          glyph.canvas.width = glyph.canvas.height = 1;
          client.cache.delete(key);
        }
      packet.rasterizations = rasterizations;
      packet.cpuGlyphBytes = [...client.cache.values()].reduce((n, g) => n + g.w * g.h * 4, 0);
      let afterSignature;
      try {
        afterSignature = signatureKey(currentSnapshot().signature);
      } catch {
        afterSignature = mainSignature();
      }
      if (afterSignature !== settings.fontSignature) {
        closePacket(packet);
        for (const g of client.cache.values()) g.canvas.width = g.canvas.height = 1;
        client.cache.clear();
        metadata.fontRestarts++;
        metadata.jobWallMs += now() - start;
        memory();
        check(job);
        return run(job);
      }
    }
    check(job);
    if (options.nativePrewarm && packet.nativeNumeric && !packet.releaseData) {
      let release;
      job.localLease = new Promise(resolve => {
        release = resolve;
      });
      let released = false;
      packet.releaseData = () => {
        if (released) return;
        released = true;
        release();
      };
      job.releaseLocalData = packet.releaseData;
    }
    packet.rasterBackend = 'main';
    packet.packingBackend = kind === 'seal' ? 'none' : 'main';
    packet.fallbackReason = fallbackReason;
    client.plans.add(packet);
    packet.closeGlyph = closeGlyph;
    packet.closeBitmaps = () => closeBitmaps(packet);
    packet.dispose = () => {
      closePacket(packet);
      client.plans.delete(packet);
    };
    client.metadata.rasterBackend = packet.rasterBackend;
    client.metadata.packingBackend = packet.packingBackend;
    client.metadata.fallbackReason = fallbackReason;
    client.metadata.cpuGlyphBytes = packet.cpuGlyphBytes;
    client.metadata.rasterizations += packet.rasterizations;
    metadata.jobWallMs += now() - start;
    memory();
    return packet;
  }
  async function pump() {
    if (active || disposed) return;
    while (jobs.length && !disposed) {
      const job = jobs.shift();
      active = job;
      metadata.pending = jobs.length + 1;
      try {
        job.resolve(await run(job));
        if (job.localLease) await job.localLease;
      } catch (error) {
        for (const g of job.client.cache.values()) g.canvas.width = g.canvas.height = 1;
        job.client.cache.clear();
        job.client.workerGlyphBytes = 0;
        memory();
        job.reject(error);
      }
      active = null;
      metadata.pending = jobs.length;
    }
  }
  function cancel(job) {
    job.cancelled = true;
    job.releaseLocalData?.();
    job.reject(abort());
  }
  return {
    metadata,
    setFontManifest(entries) {
      if (disposed) return;
      manifestGeneration++;
      const generation = manifestGeneration,
        sourceIDs = new Map();
      const records = entries.map(entry => {
        const source = entry.bytes || entry.sourceURL;
        if (!sourceIDs.has(source)) sourceIDs.set(source, generation + ':' + sourceIDs.size);
        return {
          family: String(entry.family),
          sourceURL: entry.sourceURL ? String(entry.sourceURL) : '',
          sourceID: sourceIDs.get(source),
          bytes: entry.bytes,
          descriptors: { ...entry.descriptors },
        };
      });
      valid.clear();
      signatures.clear();
      metadata.validationCacheEntries = 0;
      manifestReady = (async () => {
        const compiled = [];
        let slice = now();
        for (const entry of records) {
          if (disposed || generation !== manifestGeneration) return;
          const start = now();
          compiled.push(contract.compileEntry(entry));
          metadata.mainFontSnapshotActiveMs += now() - start;
          if (now() - slice >= 2) {
            await new Promise(resolve => setTimeout(resolve, 0));
            slice = now();
          }
        }
        if (!disposed && generation === manifestGeneration) manifest = compiled;
      })();
      return manifestReady;
    },
    acquire(kind) {
      if (disposed) throw abort();
      if (!['text', 'ui', 'seal'].includes(kind)) throw Error('Unsupported glyph renderer kind');
      const client = {
        id: ++nextOwner,
        kind,
        released: false,
        signature: '',
        cache: new Map(),
        plans: new Set(),
        workerGlyphBytes: 0,
        metadata: {
          rasterBackend: 'pending',
          packingBackend: 'pending',
          fallbackReason: '',
          cpuGlyphBytes: 0,
          rasterizations: 0,
        },
      };
      clients.set(client.id, client);
      return {
        metadata: client.metadata,
        prepare(specs, settings = {}, limits = {}) {
          if (disposed || client.released) return Promise.reject(abort());
          if (!(limits.limit > 0)) return Promise.reject(Error('Glyph preparation needs a positive texture limit'));
          const copy = specs.map(spec => ({ ...spec, glyphs: spec.glyphs?.map(g => ({ ...g })) }));
          return new Promise((resolve, reject) => {
            for (let i = jobs.length - 1; i >= 0; i--)
              if (jobs[i].client === client) {
                cancel(jobs[i]);
                jobs.splice(i, 1);
              }
            jobs.push({
              client,
              specs: copy,
              settings: { ...settings },
              limits: { limit: limits.limit, alignment: limits.alignment || 256 },
              resolve,
              reject,
              cancelled: false,
              rpcId: null,
            });
            metadata.pending = jobs.length + Number(!!active);
            metadata.peakPending = Math.max(metadata.peakPending, metadata.pending);
            void pump();
          });
        },
        release() {
          if (client.released) return;
          client.released = true;
          for (let i = jobs.length - 1; i >= 0; i--)
            if (jobs[i].client === client) {
              cancel(jobs[i]);
              jobs.splice(i, 1);
            }
          if (active?.client === client) cancel(active);
          for (const plan of client.plans) plan.dispose();
          for (const g of client.cache.values()) g.canvas.width = g.canvas.height = 1;
          client.cache.clear();
          client.workerGlyphBytes = 0;
          client.metadata.cpuGlyphBytes = 0;
          clients.delete(client.id);
          memory();
          metadata.pending = jobs.length + Number(!!active);
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      metadata.closed = true;
      for (const job of jobs) cancel(job);
      jobs.length = 0;
      if (active) cancel(active);
      for (const client of clients.values()) {
        client.released = true;
        for (const plan of client.plans) plan.dispose();
        for (const g of client.cache.values()) g.canvas.width = g.canvas.height = 1;
        client.cache.clear();
        client.workerGlyphBytes = 0;
        client.metadata.cpuGlyphBytes = 0;
      }
      clients.clear();
      valid.clear();
      signatures.clear();
      manifest = [];
      memory();
      metadata.validationCacheEntries = 0;
      metadata.pending = 0;
    },
  };
}
