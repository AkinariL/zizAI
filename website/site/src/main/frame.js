const PACE = { per: 1000 / 60, gaps: [], owed: 0, ok: false, n: 0, lock: 0, fast: 0, missed: [] };

function pace(raw, now) {
  const P = PACE;
  if (!(raw > 0)) return P.per;
  if (raw > 200) {
    P.owed = 0;
    return raw;
  }
  P.gaps.push(raw);
  if (P.gaps.length > 90) P.gaps.shift();
  if (P.gaps.length >= 32 && P.n++ % 10 === 0) {
    const g = P.gaps,
      runs = [];
    for (let i = 0, acc = 0; i < g.length; i++) {
      acc += g[i];
      if (i >= 16) acc -= g[i - 16];
      if (i >= 15) runs.push(acc);
    }
    runs.sort((x, y) => x - y);
    const e = runs[runs.length >> 2] / 16,
      ok = e > 3.5 && e < 36 && g.filter(x => x > 0.3 * e && x < 1.7 * e).length >= 0.85 * g.length;
    if (ok && (!P.ok || Math.abs(P.per - e) > 0.08 * e)) {
      P.per = e;
      P.owed = 0;
      P.lock = 0;
    }
    P.ok = ok;
  }
  if (!P.ok) return raw;
  P.fast = raw < 0.7 * P.per ? P.fast + 1 : 0;
  if (P.fast >= 6) {
    const g = P.gaps.slice(-6);
    P.per = g.reduce((x, y) => x + y, 0) / 6;
    P.owed = 0;
    P.lock = 0;
    P.fast = 0;
    P.gaps = g;
  }
  const n = Math.max(1, Math.round((raw + P.owed) / P.per)),
    dt = n * P.per;
  if (n > 1) {
    P.missed.push(now);
    if (P.missed.length > 600) P.missed.shift();
  }
  P.owed = clamp(P.owed + raw - dt, -P.per, P.per);
  const k = P.lock++ < 90 ? 0.08 : 0.03,
    back = P.owed * k;
  P.per += (P.owed * k * k) / 4;
  P.owed -= back;
  return dt + back;
}

let last = 0;

function frame(now) {
  if (mainStopped || !comp) return;
  window.__blockmain?.step(now);
  const __p = window.__probe?.begin(now),
    f0 = performance.now();
  try {
    const dt = Math.min(0.05, last ? pace(now - last, now) / 1000 : 0.016);
    last = now;
    const dts = TUNE.pause ? 0 : dt * SPEED * TUNE.speed;
    st.clock += dts * 1000;
    st.time += dt;
    for (let i = waits.length - 1; i >= 0; i--)
      if (st.clock >= waits[i].t) {
        waits[i].res();
        waits.splice(i, 1);
      }
    st.page.step(st.target, dts / transShape().slow);
    st.box.step(st.target, dts);
    st.meter.target = st.target;
    const meter = st.meter.step(dts);
    if (STATIC === 'zh') {
      st.page.D = 0;
      st.page.t = 0;
    }
    if (STATIC === 'ja') {
      st.page.D = 1;
      st.page.t = 0;
    }
    if (STATIC === 'mix') {
      st.page.D = 0;
      st.page.t = parseFloat(param('t') || '.5');
    }
    const pj = st.page.D ? 1 - st.page.t * 0.9 : st.page.t * 0.9,
      want = pj > 0.55 ? 'ja' : pj < 0.45 ? 'zh' : null;
    if (want && want !== st.verse[0]) {
      st.verse[0] = want;
      showVerse(0, want);
      setTimeout(() => {
        st.verse[1] = want;
        showVerse(1, want);
      }, 520);
    }
    for (let k = 0; k < 2; k++) {
      const m = clamp(st.mouseT[k], -1, 1),
        goal = m * (1.5 - 0.5 * m * m),
        w = 6,
        d = st.mouse[k] - goal,
        e = Math.exp(-w * dt),
        g = st.mouseV[k] + w * d;
      st.mouse[k] = goal + (d + g * dt) * e;
      st.mouseV[k] = (st.mouseV[k] - w * g * dt) * e;
    }
    st.veil += (st.veilT - st.veil) * (1 - Math.exp(-dt / (st.veilT > st.veil ? 0.16 : 0.55)));
    const w = springs.w.step(dts),
      h = springs.h.step(dts),
      vis = springs.vis.step(dts),
      trackX = springs.track.step(dts);
    const cc = CURVES.cam,
      lead = cc.type === 'spring' || cc.type === 'exp' ? cc.lead : 0;
    st.camLead = lead > 0.005 ? st.camLead + (st.camT - st.camLead) * (1 - Math.exp(-dts / lead)) : st.camT;
    springs.cam.target = st.camLead;
    const cam = springs.cam.step(dts),
      dCam = cam - st.camPrev;
    st.camPrev = cam;
    worldWant(cam, st.page.D);
    window.__probe?.set(__p, 2, cam);
    const gust = 0.85 + 0.35 * N1(st.time * 0.13 + 3) + 0.15 * Math.sin(st.time * 0.21);
    if (!STILL) comp.stepParticles({ dt, gust, pan: dCam * world.H, page: st.page, box: st.box });
    const f = {
      time: st.time,
      t: st.page.t,
      D: st.page.D,
      veil: st.veil,
      sway: reduceMotion || STILL ? 0 : 0.0022,
      mx: st.mouse[0],
      my: st.mouse[1],
      dpr: dprGL,
      cam,
      view: worldView(cam),
    };
    if (GPU_LINE.enabled) comp.setTextFrame(GPU_LINE.frame(now, Number(trackX.toFixed(2))));
    if (GPU_UI.enabled)
      comp.setUIFrame(GPU_UI.frame(now, { w, h, vis, meter, boxD: st.box.D, boxT: st.box.t, boxP: st.box.p }));
    const uploadAt = performance.now();
    comp.uploadTiles();
    bootProgress();
    window.__probe?.done(__p, 3, uploadAt);
    const renderAt = performance.now();
    if (window.__zzTest) window.__zzTest.lastFrame = f;
    comp.render(f);
    window.__probe?.done(__p, 4, renderAt);
    window.__probe?.set(__p, 7, GPU_DIAG.tileBacklog?.visibleMissing || 0);
    if (OPENING.up) watchOpening(now);
    const js = performance.now() - f0;
    DIAG.js += js;
    DIAG.n++;
    if (js > DIAG.jsMax) DIAG.jsMax = js;
    window.__probe?.set(__p, 6, js);
  } catch (error) {
    siteFatal(error);
    return;
  }
  if (!mainStopped) mainFrameId = requestAnimationFrame(frame);
}
