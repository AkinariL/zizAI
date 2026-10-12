function keyDelay(boundary, idx) {
  let d = 74 + Math.random() * 48;
  if (boundary) d += 34 + Math.random() * 46;
  if (idx === 0) d += 70;
  return d;
}

let demoGen = 0;

const STOP = {};

async function pause(ms, gen) {
  await SITE_DEMO_SCHEDULE.pause(ms, gen);
}
const demoEvent = (gen, apply) => SITE_DEMO_SCHEDULE.event(apply, gen);

async function typeSentence(se, first, gen) {
  await demoEvent(gen, () => startPre(se.lang));
  for (const ch of se.chunks) {
    if (ch.punct) {
      await pause(150 + Math.random() * 90, gen);
      await demoEvent(gen, () => addChunk(ch.out, se.lang));
      if (ch.commit) {
        await pause(420, gen);
        await demoEvent(gen, () => {
          commit();
          showBox(false);
          setCands(null);
          clearRaw();
        });
        await pause(1350, gen);
      } else await pause(260, gen);
      continue;
    }
    if (!st.boxOn) await demoEvent(gen, () => showBox(true));
    const l = ch.lang || se.lang;
    let n = 0,
      boundary = false;
    for (const c of ch.keys) {
      if (c === '|') {
        boundary = true;
        continue;
      }
      await pause(keyDelay(boundary, n), gen);
      n++;
      await demoEvent(gen, () => {
        addKey(c, boundary);
        if (ch.p) for (const [k, v] of ch.p) if (k === n && !(first && ch === se.chunks[0])) st.target = v;
        if (ch.c && ch.c[n]) setCands(ch.c[n], se.lang);
      });
      boundary = false;
    }
    await pause(ch.hold || 430, gen);
    await demoEvent(gen, () => pick());
    await pause(200, gen);
    await demoEvent(gen, () => {
      addChunk(ch.out, l);
      setCands(null);
      clearRaw();
    });
    await pause(260, gen);
  }
}

async function runDemo(gen) {
  let first = true;
  try {
    SITE_DEMO_SCHEDULE.begin(gen);
    for (;;)
      for (const se of OPEN_JA ? [SCRIPT[1], SCRIPT[0]] : SCRIPT) {
        await typeSentence(se, first, gen);
        first = false;
      }
  } catch (e) {
    if (e !== STOP) siteFatal(e);
  }
}

function restartDemo() {
  const gen = ++demoGen;
  SITE_DEMO_SCHEDULE.cancel(gen);
  for (const w of waits.splice(0)) w.res();
  clearRaw();
  setCands(null);
  showBox(false);
  st.target = OPEN_P;
  st.veilT = 1;
  setTimeout(() => {
    if (gen !== demoGen) return;
    for (const e of [...track.children]) if (e !== caret && e.id !== 'strut') e.remove();
    pre = null;
    GPU_LINE.restart();
    GPU_UI.restart();
    st.page.reset(OPEN_P);
    st.box.reset(OPEN_P);
    st.meter.set(OPEN_P);
    st.camT = st.camLead = st.camPrev = CAM0;
    springs.cam.set(CAM0);
    springs.track.set(-caret.offsetLeft);
    const ready = () => {
      if (gen !== demoGen) return;
      if (worldUrgent()) {
        setTimeout(ready, 60);
        return;
      }
      st.veilT = 0;
      setTimeout(() => {
        if (gen === demoGen) runDemo(gen);
      }, 900);
    };
    setTimeout(ready, 80);
  }, 380);
}

function consumeDemoParticleRandomGroup(count) {
  for (let i = 0; i < count; i++) for (let draw = 0; draw < 13; draw++) Math.random();
}
function consumeDemoParticleSeedRandom(W, H) {
  const area = clamp((W * H) / (1440 * 900), 0.45, 1.5) * (reduceMotion ? 0.35 : 1);
  consumeDemoParticleRandomGroup(Math.round(24 * area));
  consumeDemoParticleRandomGroup(Math.round(46 * area));
  consumeDemoParticleRandomGroup(6);
  consumeDemoParticleRandomGroup(9);
}
