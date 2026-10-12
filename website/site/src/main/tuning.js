const TUNING_KEY = 'zizai-v3-tuning';

function loadTuning() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(TUNING_KEY) || 'null');
  } catch (e) {
    saved = null;
  }
  if (!saved) return;
  for (const k in CURVES)
    if (saved.curves && saved.curves[k])
      Object.assign(CURVES[k], saved.curves[k], { bz: [...(saved.curves[k].bz || CURVES[k].bz)] });
  if (saved.trans) for (const k in saved.trans) if (k in TRANS) TRANS[k] = saved.trans[k];
  if (saved.tune) for (const k in saved.tune) if (k in TUNE && k !== 'pause') TUNE[k] = saved.tune[k];
}

let saveTimer = 0;

function saveTuning() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(TUNING_KEY, JSON.stringify({ curves: CURVES, trans: TRANS, tune: TUNE }));
    } catch (e) {}
  }, 250);
}

const CSS_LINEAR = (() => {
  try {
    return CSS.supports('animation-timing-function', 'linear(0, 0.5, 1)');
  } catch (e) {
    return false;
  }
})();

function curveT(c) {
  if (c.type === 'exp') return 4.6 * c.tau;
  if (c.type !== 'spring') return c.dur;
  const w = Math.sqrt(Math.max(0.01, c.k)),
    z = Math.max(0.01, c.z);
  return clamp(z < 1 ? 4.6 / (z * w) : 6.6 / (w * (z - Math.sqrt(z * z - 1))), 0.1, 12);
}

function response(c, n) {
  const out = [];
  if (c.type === 'spring' || c.type === 'exp') {
    const m = new Motion(0, c),
      T = curveT(c);
    m.target = 1;
    for (let i = 0; i <= n; i++) {
      out.push(m.x);
      m.step(T / n);
    }
    return { pts: out, T };
  }
  const f = easeOf(c);
  for (let i = 0; i <= n; i++) out.push(f(i / n));
  return { pts: out, T: c.dur };
}

function cssEase(c) {
  if (c.type === 'bezier') return 'cubic-bezier(' + c.bz.map(v => +v.toFixed(3)).join(',') + ')';
  if (!CSS_LINEAR) return 'cubic-bezier(.2,.8,.2,1)';
  const { pts } = response(c, 48);
  pts[pts.length - 1] = 1;
  return 'linear(' + pts.map(v => +v.toFixed(4)).join(',') + ')';
}

function applyCss() {
  GPU_LINE.dirty('tuning');
  GPU_UI.dirty('tuning');
  const set = (name, c) => {
    const T = curveT(c);
    root.style.setProperty('--' + name + '-dur', (T / (SPEED * TUNE.speed)).toFixed(3) + 's');
    root.style.setProperty('--' + name + '-ease', cssEase(c));
  };
  set('cand', CURVES.candIn);
  set('out', CURVES.candOut);
  set('key', CURVES.keyIn);
  set('ink', CURVES.inkIn);
}

function buildPanel() {
  const CH = [
    ['cam', '背景移动（镜头跟随文字）'],
    ['track', '文字移动（输入行滚动）'],
    ['w', '候选框宽度变化'],
    ['h', '候选框高度变化'],
    ['vis', '候选框出现 / 消失'],
    ['page', '竹樱切换：背景跟随语种'],
    ['box', '竹樱切换：候选框配色'],
    ['meter', '语种刻度圆点'],
    ['candIn', '候选词出现'],
    ['candOut', '旧候选词退出'],
    ['keyIn', '拼音字母出现'],
    ['inkIn', '上屏文字出现'],
  ];
  const CSSCH = new Set(['candIn', 'candOut', 'keyIn', 'inkIn']);
  const TYPES = [
    ['spring', '弹簧 spring'],
    ['exp', '指数趋近 exp'],
    ['linear', 'linear'],
    ['sine', 'sine'],
    ['quad', 'quad'],
    ['cubic', 'cubic'],
    ['quart', 'quart'],
    ['quint', 'quint'],
    ['expo', 'expo'],
    ['circ', 'circ'],
    ['pow', '幂函数 pow'],
    ['back', 'back'],
    ['elastic', 'elastic'],
    ['bounce', 'bounce'],
    ['bezier', '贝塞尔 cubic-bezier'],
  ];
  const MODES = [
    ['in', 'ease-in'],
    ['out', 'ease-out'],
    ['inOut', 'ease-in-out'],
  ];
  const BEZ = {
    ease: [0.25, 0.1, 0.25, 1],
    'ease-in': [0.42, 0, 1, 1],
    'ease-out': [0, 0, 0.58, 1],
    'ease-in-out': [0.42, 0, 0.58, 1],
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  function slider(parent, label, get, set, min, max, step, log, done, show) {
    const row = el('label', 'dbg-row'),
      inp = el('input'),
      out = el('output', 'dbg-v');
    row.append(el('span', 'dbg-k', label), inp, out);
    inp.type = 'range';
    const toS = v => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : v),
      fromS = s => (log ? min * Math.pow(max / min, s / 1000) : s);
    inp.min = log ? 0 : min;
    inp.max = log ? 1000 : max;
    inp.step = log ? 1 : step;
    const say = show || fmt;
    inp.value = toS(get());
    out.value = say(get());
    inp.addEventListener('input', () => {
      let v = fromS(+inp.value);
      if (log) v = +v.toPrecision(3);
      set(v);
      out.value = say(v);
    });
    if (done) inp.addEventListener('change', done);
    parent.append(row);
  }
  const touched = () => {
    CURVE_VER++;
    saveTuning();
  };
  function drawCurve(cv, c) {
    const x = cv.getContext('2d'),
      w = cv.width,
      h = cv.height,
      { pts, T } = response(c, 80);
    const lo = Math.min(0, ...pts),
      hi = Math.max(1, ...pts),
      Y = v => h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
    x.clearRect(0, 0, w, h);
    x.strokeStyle = 'rgba(26,31,27,.18)';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(0, Y(0));
    x.lineTo(w, Y(0));
    x.moveTo(0, Y(1));
    x.lineTo(w, Y(1));
    x.stroke();
    x.strokeStyle = '#557a51';
    x.lineWidth = 1.6;
    x.beginPath();
    pts.forEach((v, i) => {
      const px = (i / (pts.length - 1)) * w;
      i ? x.lineTo(px, Y(v)) : x.moveTo(px, Y(v));
    });
    x.stroke();
    x.fillStyle = 'rgba(26,31,27,.55)';
    x.font = '10px sans-serif';
    x.fillText(T.toFixed(2) + 's', w - 30, 11);
  }
  function channel(parent, key, name) {
    const c = CURVES[key],
      det = el('details', 'dbg-ch'),
      sum = el('summary'),
      body = el('div', 'dbg-body');
    const label = () => {
      sum.textContent =
        name +
        ' · ' +
        (TYPES.find(t => t[0] === c.type) || [0, c.type])[1].split(' ').pop() +
        (/^(spring|exp|bezier|linear)$/.test(c.type) ? '' : ' ' + (MODES.find(m => m[0] === c.mode) || ['', ''])[1]);
    };
    det.append(sum, body);
    parent.append(det);
    label();
    const render = () => {
      body.textContent = '';
      const top = el('div', 'dbg-line'),
        ty = el('select'),
        cv = el('canvas', 'dbg-cv');
      cv.width = 132;
      cv.height = 52;
      for (const [v, t] of TYPES) {
        const o = el('option', null, t);
        o.value = v;
        ty.append(o);
      }
      ty.value = c.type;
      ty.addEventListener('change', () => {
        c.type = ty.value;
        touched();
        label();
        render();
        if (CSSCH.has(key)) applyCss();
      });
      top.append(ty);
      if (!/^(spring|exp|bezier|linear)$/.test(c.type)) {
        const md = el('select');
        for (const [v, t] of MODES) {
          const o = el('option', null, t);
          o.value = v;
          md.append(o);
        }
        md.value = c.mode;
        md.addEventListener('change', () => {
          c.mode = md.value;
          changed();
          label();
        });
        top.append(md);
      }
      body.append(top);
      const row = el('div', 'dbg-split'),
        ctl = el('div', 'dbg-ctl');
      row.append(ctl, cv);
      body.append(row);
      const changed = () => {
        touched();
        drawCurve(cv, c);
        if (CSSCH.has(key)) applyCss();
      };
      const S = (label, k, min, max, step, log) =>
        slider(
          ctl,
          label,
          () => c[k],
          v => {
            c[k] = v;
            changed();
          },
          min,
          max,
          step,
          log,
        );
      if (c.type === 'spring') {
        S('刚度 k', 'k', 1, 1200, 1, true);
        S('阻尼比 ζ', 'z', 0.05, 2, 0.01);
      } else if (c.type === 'exp') S('时间常数 τ', 'tau', 0.02, 4, 0.01, true);
      if (c.type !== 'spring' && c.type !== 'exp') S('时长 s', 'dur', 0.05, 5, 0.01, true);
      if (c.type === 'pow') S('指数 n', 'n', 1, 10, 0.1);
      if (c.type === 'back') S('回拉 s', 's', 0, 5, 0.01);
      if (c.type === 'elastic') {
        S('振幅', 'amp', 1, 3, 0.01);
        S('周期', 'per', 0.05, 1.2, 0.01);
      }
      if (key === 'cam' && (c.type === 'spring' || c.type === 'exp')) S('前导缓入 τ', 'lead', 0, 2, 0.01);
      if (c.type === 'bezier') {
        const pre = el('select');
        for (const n of ['自定义', ...Object.keys(BEZ)]) {
          const o = el('option', null, n);
          o.value = n;
          pre.append(o);
        }
        pre.value = Object.keys(BEZ).find(n => BEZ[n].every((v, i) => Math.abs(v - c.bz[i]) < 1e-3)) || '自定义';
        pre.addEventListener('change', () => {
          if (BEZ[pre.value]) {
            c.bz = [...BEZ[pre.value]];
            changed();
            render();
          }
        });
        top.append(pre);
        ['x1', 'y1', 'x2', 'y2'].forEach((n, i) =>
          slider(
            ctl,
            n,
            () => c.bz[i],
            v => {
              c.bz[i] = v;
              changed();
            },
            i % 2 ? -1 : 0,
            i % 2 ? 2 : 1,
            0.01,
          ),
        );
      }
      drawCurve(cv, c);
    };
    det.addEventListener('toggle', () => {
      if (det.open && !body.firstChild) render();
    });
  }
  const btn = el('button', 'dbg-btn', '调试'),
    panel = el('div', 'dbg');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  panel.hidden = true;
  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', String(!panel.hidden));
  });
  const head = el('div', 'dbg-head'),
    fps = el('span', 'dbg-fps', '— fps');
  head.append(el('b', null, '动画调试'), fps);
  const diag = el('div', 'dbg-diag');
  panel.append(head, diag);
  const g = el('div', 'dbg-sec');
  slider(
    g,
    '演示速度',
    () => TUNE.speed,
    v => {
      TUNE.speed = v;
      applyCss();
      saveTuning();
    },
    0.1,
    3,
    0.01,
    true,
  );
  slider(
    g,
    '镜头行进倍率',
    () => TUNE.pan,
    v => {
      TUNE.pan = v;
      saveTuning();
    },
    0.1,
    3,
    0.01,
    true,
  );
  slider(
    g,
    '近景移动倍率',
    () => TUNE.closePan,
    v => {
      TUNE.closePan = v;
      LAYERS[CLOSE].pan = v;
      saveTuning();
    },
    0.6,
    4,
    0.01,
    true,
    () => {
      st.veilT = 1;
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        buildWorld(st.page.t > 0.001);
        whenPainted(() => {
          st.veilT = 0;
        });
      }, 320);
    },
  );
  const acts = el('div', 'dbg-line'),
    pause = el('button', null, '暂停'),
    again = el('button', null, '从头播放'),
    copy = el('button', null, '复制参数'),
    reset = el('button', null, '恢复默认');
  for (const b of [pause, again, copy, reset]) b.type = 'button';
  pause.addEventListener('click', () => {
    TUNE.pause = !TUNE.pause;
    pause.textContent = TUNE.pause ? '继续' : '暂停';
  });
  again.addEventListener('click', () => restartDemo());
  copy.addEventListener('click', () => {
    const text = JSON.stringify({ curves: CURVES, trans: TRANS, tune: { ...TUNE, pause: undefined } }, null, 1);
    const showParameters = () => {
      let ta = panel.querySelector('textarea');
      if (!ta) {
        ta = el('textarea', 'dbg-out');
        panel.append(ta);
      }
      ta.value = text;
      ta.focus();
      ta.select();
    };
    try {
      navigator.clipboard.writeText(text).then(() => {
        copy.textContent = '已复制';
        setTimeout(() => (copy.textContent = '复制参数'), 1400);
      }, showParameters);
    } catch (e) {
      showParameters();
    }
  });
  reset.addEventListener('click', () => {
    const d = JSON.parse(DEFAULTS);
    for (const k in CURVES) Object.assign(CURVES[k], d.curves[k]);
    const rebuild = LAYERS[CLOSE].pan !== d.tune.closePan;
    Object.assign(TRANS, d.trans);
    Object.assign(TUNE, d.tune);
    LAYERS[CLOSE].pan = TUNE.closePan;
    invalidateTextGround();
    if (rebuild) {
      st.veilT = 1;
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        buildWorld(st.page.t > 0.001);
        whenPainted(() => {
          st.veilT = 0;
        });
      }, 320);
    }
    TUNE.pause = false;
    CURVE_VER++;
    applyCss();
    saveTuning();
    panel.remove();
    btn.remove();
    buildPanel();
    const np = document.querySelector('.dbg'),
      nb = document.querySelector('.dbg-btn');
    np.hidden = false;
    nb.setAttribute('aria-expanded', 'true');
  });
  acts.append(pause, again, copy, reset);
  g.append(acts);
  panel.append(g);
  const tr = el('details', 'dbg-ch'),
    trb = el('div', 'dbg-body');
  tr.append(el('summary', null, '竹樱切换的过渡形状'), trb);
  const T = (label, k, min, max, step) =>
    slider(
      trb,
      label,
      () => TRANS[k],
      v => {
        TRANS[k] = v;
        saveTuning();
      },
      min,
      max,
      step,
    );
  T('过渡带宽度', 'F', 0.1, 1.6, 0.01);
  T('边缘起伏', 'J', 0, 1, 0.01);
  T('远近先后', 'lag', 0, 2, 0.01);
  T('近景经雾过渡', 'dip', 0, 1, 0.01);
  T('宽屏加宽', 'wideF', 0, 1.5, 0.01);
  T('宽屏放慢', 'wideT', 0, 1.5, 0.01);
  panel.append(tr);
  const hl = el('details', 'dbg-ch'),
    hlb = el('div', 'dbg-body');
  hl.append(el('summary', null, '上屏文字的底色'), hlb);
  const px = v => (v * (world.ls || parseFloat(getComputedStyle(track).fontSize) || 24)).toFixed(1) + 'px';
  const HL = (label, k, min, max, step, show) =>
    slider(
      hlb,
      label,
      () => TUNE[k],
      v => {
        TUNE[k] = v;
        if (show) invalidateTextGround();
        saveTuning();
      },
      min,
      max,
      step,
      false,
      null,
      show,
    );
  HL('厚度', 'base', 0, 0.3, 0.001, px);
  HL('边缘虚化', 'baseSoft', 0, 0.2, 0.001, px);
  HL('浓度', 'baseA', 0, 1, 0.01);
  HL('提亮', 'baseLift', 0, 1, 0.01);
  panel.append(hl);
  const lab = el('details', 'dbg-ch'),
    labb = el('div', 'dbg-body');
  lab.append(el('summary', null, '性能试验（不保存）'), labb);
  slider(
    labb,
    '画面精细度',
    () => LAB.res,
    v => {
      LAB.res = v;
    },
    0.5,
    4,
    0.05,
    false,
    () => {
      resizeScene();
      st.veilT = 1;
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        buildWorld(st.page.t > 0.001);
        whenPainted(() => {
          st.veilT = 0;
        });
      }, 320);
    },
  );
  const tog = (label, key, apply) => {
    const row = el('label', 'dbg-tog'),
      inp = el('input');
    inp.type = 'checkbox';
    inp.checked = LAB[key];
    inp.addEventListener('change', () => {
      LAB[key] = inp.checked;
      apply();
    });
    row.append(inp, el('span', null, label));
    labb.append(row);
  };
  tog('文字底色', 'ground', () => root.classList.toggle('lab-noground', !LAB.ground));
  tog('飘落的竹叶和花瓣', 'drift', () => {});
  tog('候选框的毛玻璃', 'glass', () => root.classList.toggle('lab-noglass', !LAB.glass));
  panel.append(lab);
  const gpuLine = el('pre', 'dbg-diag');
  gpuLine.style.whiteSpace = 'pre-wrap';
  panel.append(gpuLine);
  const copyDiag = el('button', null, '复制诊断');
  copyDiag.type = 'button';
  copyDiag.addEventListener('click', async () => {
    const data = JSON.stringify(
      {
        version: SITE_CONFIG.version || 'chapter-6',
        backend: comp?.kind,
        ...GPU_DIAG,
        meshSnapshot: comp?.debugTileSnapshot?.(),
        textLayout: GPU_LINE.debugSnapshot?.().counters,
        uiLayout: GPU_UI.debugSnapshot?.().counters,
        viewport: [innerWidth, innerHeight, devicePixelRatio],
        pace: { period: PACE.per, gaps: PACE.gaps.slice(-60) },
        userAgent: navigator.userAgent,
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(data);
      copyDiag.textContent = '已复制诊断';
    } catch (e) {
      const area = el('textarea');
      area.value = data;
      panel.append(area);
      area.select();
      copyDiag.textContent = '请复制下方诊断';
    }
  });
  panel.append(copyDiag);
  for (const [k, n] of CH) channel(panel, k, n);
  document.body.append(panel, btn);
  let n = 0,
    t0 = performance.now(),
    d0 = t0;
  (function tick(now) {
    if (!fps.isConnected || mainStopped) return;
    n++;
    if (now - t0 > 600) {
      fps.textContent = Math.round((n * 1000) / (now - t0)) + ' 主线程 rAF Hz';
      n = 0;
      t0 = now;
    }
    if (now - d0 > 1000 && DIAG.n) {
      const gaps = PACE.gaps.slice(-60);
      diag.textContent =
        '主线程 rAF间隔 ' +
        (gaps.length ? Math.round(Math.min(...gaps)) + '–' + Math.round(Math.max(...gaps)) : '—') +
        ' ms\n每帧脚本 ' +
        (DIAG.js / DIAG.n).toFixed(1) +
        ' ms，最长 ' +
        DIAG.jsMax.toFixed(1) +
        ' ms';
      gpuLine.textContent =
        '当前画法 ' +
        GPU_DIAG.state +
        '\n最近错误 ' +
        (GPU_DIAG.error || '无') +
        '\n渲染线程 ' +
        (GPU_DIAG.workerFrameDiagnostics?.workerRAF?.frequencyHz?.toFixed(1) || '—') +
        ' Hz\n可见缺片 ' +
        (GPU_DIAG.tileBacklog?.visibleMissing || 0);
      DIAG.js = DIAG.jsMax = DIAG.n = 0;
      d0 = now;
    }
    requestAnimationFrame(tick);
  })(t0);
}
