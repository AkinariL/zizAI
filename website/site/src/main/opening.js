const OPENING = {
  up: true,
  ready: false,
  drained: false,
  t0: 0,
  fr: [],
  dur: reduceMotion ? 600 : 1800,
  lifted: null,
  lift: null,
};

OPENING.lifted = new Promise(res => {
  OPENING.lift = res;
});

function watchOpening(now) {
  bootProgress();
  if (GPU_DIAG.textPreparing || GPU_DIAG.uiPreparing || !worldIdle()) return;
  if (!OPENING.ready || !worldIdle()) {
    OPENING.drained = false;
    OPENING.fr = [];
    return;
  }
  if (!comp.valid) return;
  if (!OPENING.drained) {
    if (!OPENING.drainPending) {
      const current = comp,
        era = worldEra,
        token = { finish: GPU_BOOT?.begin('opening-fence', { era }) };
      OPENING.drainPending = token;
      Promise.resolve(comp.finish()).then(
        () => {
          token.finish?.(comp === current && worldEra === era ? 'completed' : 'superseded');
          if (comp === current && OPENING.drainPending === token) {
            OPENING.drainPending = false;
            OPENING.drained = worldEra === era && worldIdle();
          }
        },
        error => {
          token.finish?.('failed', error);
          if (comp === current && OPENING.drainPending === token) {
            OPENING.drainPending = false;
            siteFatal(error);
          }
        },
      );
    }
    return;
  }
  if (GPU_BOOT && !GPU_BOOT.stableDone) GPU_BOOT.stableDone = GPU_BOOT.begin('stable-opening-frames');
  const frames = OPENING.fr;
  frames.push(now);
  if (frames.length > 13) frames.shift();
  if (frames.length < 13) return;
  const gaps = frames.slice(1).map((time, index) => time - frames[index]),
    median = gaps.slice().sort((a, b) => a - b)[6];
  if (gaps.every(gap => gap < Math.max(20, median * 1.5))) liftCover(now);
}
function liftCover(now) {
  comp.setTileOpeningMode(false);
  GPU_UI.liftCover(now, OPENING.dur);
  OPENING.up = false;
  if (GPU_BOOT) {
    GPU_BOOT.metadata.lift = now;
    GPU_BOOT.stableDone?.();
    GPU_BOOT.stableDone = null;
  }
  const cover = $('cover');
  root.style.setProperty('--cover-dur', OPENING.dur + 'ms');
  cover.classList.add('off');
  setTimeout(() => cover.remove(), OPENING.dur + 200);
  bg.classList.add('on');
  const loading = $('loading');
  if (loading) {
    loading.classList.add('off');
    setTimeout(() => loading.remove(), 700);
  }
  if (window.__zz) window.__zz.opening = { t0: OPENING.t0, lift: now, dur: OPENING.dur };
  OPENING.lift();
}
