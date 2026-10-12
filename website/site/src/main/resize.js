function createWorldResizeScheduler(options) {
  const { getCurrentKey, getBuiltKey, getEra, getVeil, setVeil, rebuild, whenPainted } = options;
  for (const [name, value] of Object.entries({
    getCurrentKey,
    getBuiltKey,
    getEra,
    getVeil,
    setVeil,
    rebuild,
    whenPainted,
  })) {
    if (typeof value !== 'function') throw Error('Missing world resize dependency: ' + name);
  }
  const timers = options.timers || {
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
    },
    delayMs = options.delayMs ?? 320;
  if (!(Number.isFinite(delayMs) && delayMs >= 0)) throw Error('Invalid GPU mesh resize delay');
  let pending = null,
    activeBuild = null,
    disposed = false;

  function clearPending() {
    const old = pending;
    if (old) timers.clearTimeout(old.timer);
    pending = null;
    return old;
  }
  function liveBuild(record) {
    return record === activeBuild && record.era === getEra() && record.key === getBuiltKey();
  }
  function forgetExternalBuild() {
    if (activeBuild && !liveBuild(activeBuild)) activeBuild = null;
  }
  function reveal(record) {
    if (!record || !record.settled || !liveBuild(record) || record.key !== getCurrentKey() || pending) return;
    if (getVeil() === 1) setVeil(0);
    activeBuild = null;
  }
  function restorePendingVeil(record) {
    if (record && record.era === getEra() && getVeil() === 1) setVeil(record.previousVeil);
  }
  function keepBuiltWorld(record) {
    forgetExternalBuild();
    reveal(activeBuild);
    restorePendingVeil(record);
  }
  function request() {
    if (disposed) return;
    forgetExternalBuild();
    const key = getCurrentKey();
    if (key === getBuiltKey()) {
      keepBuiltWorld(clearPending());
      return;
    }
    const old = clearPending(),
      era = getEra();
    const record = { key, era, previousVeil: old?.era === era ? old.previousVeil : getVeil(), timer: null };
    pending = record;
    if (getVeil() !== 1) setVeil(1);
    record.timer = timers.setTimeout(() => {
      if (disposed || pending !== record) return;
      if (getCurrentKey() !== record.key) {
        request();
        return;
      }
      pending = null;
      if (record.key === getBuiltKey()) {
        keepBuiltWorld(record);
        return;
      }
      activeBuild = null;
      rebuild();
      const built = (activeBuild = { key: getBuiltKey(), era: getEra(), settled: false });
      whenPainted(() => {
        if (!liveBuild(built)) return;
        built.settled = true;
        reveal(built);
      });
    }, delayMs);
  }
  function cancel({ restoreVeil = true } = {}) {
    const old = clearPending();
    activeBuild = null;
    if (restoreVeil && getCurrentKey() === getBuiltKey()) restorePendingVeil(old);
  }
  function dispose({ restoreVeil = false } = {}) {
    cancel({ restoreVeil });
    disposed = true;
  }
  return {
    request,
    cancel,
    dispose,
    get pending() {
      return pending !== null;
    },
  };
}

let rzTimer = 0,
  rzSize = viewport().join('x'),
  WORLD_BUILT_KEY = null;
const worldResizeKey = () => [...viewport(), dprGL].join('x');
const WORLD_RESIZE = createWorldResizeScheduler({
  getCurrentKey: worldResizeKey,
  getBuiltKey: () => WORLD_BUILT_KEY,
  getEra: () => worldEra,
  getVeil: () => st.veilT,
  setVeil: value => {
    st.veilT = value;
  },
  rebuild: () => buildWorld(st.page.t > 0.001 || STATIC !== null),
  whenPainted,
});
const POINTER = {
  on: !reduceMotion && param('parallax') !== '0',
  mouse: [0, 0],
  drag: [0, 0],
  tilt: [0, 0],
  touch: null,
  rest: null,
  at: 0,
};
function pointerAim() {
  for (let k = 0; k < 2; k++) st.mouseT[k] = clamp(POINTER.mouse[k] + POINTER.drag[k] + POINTER.tilt[k], -1, 1);
}
if (POINTER.on) {
  addEventListener(
    'pointermove',
    event => {
      if (event.pointerType !== 'mouse') return;
      POINTER.mouse[0] = (event.clientX / innerWidth) * 2 - 1;
      POINTER.mouse[1] = -((event.clientY / innerHeight) * 2 - 1);
      pointerAim();
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'mouse') return;
    POINTER.mouse[0] = 0;
    POINTER.mouse[1] = 0;
    pointerAim();
  });
  const finger = event => {
    for (const t of event.touches) if (t.identifier === POINTER.touch?.id) return t;
    return null;
  };
  addEventListener(
    'touchstart',
    event => {
      if (POINTER.touch) return;
      const t = event.changedTouches[0];
      POINTER.touch = { id: t.identifier, x: t.clientX, y: t.clientY };
    },
    { passive: true },
  );
  addEventListener(
    'touchmove',
    event => {
      const t = POINTER.touch && finger(event);
      if (!t) return;
      const full = 0.4 * Math.min(innerWidth, innerHeight);
      POINTER.drag[0] = clamp(-(t.clientX - POINTER.touch.x) / full, -1, 1);
      POINTER.drag[1] = clamp((t.clientY - POINTER.touch.y) / full, -1, 1);
      pointerAim();
    },
    { passive: true },
  );
  const lift = event => {
    if (!POINTER.touch || finger(event)) return;
    POINTER.touch = null;
    POINTER.drag[0] = 0;
    POINTER.drag[1] = 0;
    pointerAim();
  };
  addEventListener('touchend', lift, { passive: true });
  addEventListener('touchcancel', lift, { passive: true });
  if (/Android/i.test(navigator.userAgent) && param('tilt') !== '0' && 'DeviceOrientationEvent' in window)
    addEventListener(
      'deviceorientation',
      event => {
        if (event.beta === null || event.gamma === null) return;
        const turn = (((screen.orientation?.angle ?? window.orientation ?? 0) % 360) + 360) % 360,
          b = event.beta,
          g = event.gamma;
        const now = turn === 90 ? [b, g] : turn === 270 ? [-b, -g] : turn === 180 ? [-g, b] : [g, -b],
          at = performance.now(),
          dt = Math.min(0.25, (at - POINTER.at) / 1000);
        const rest = POINTER.rest,
          jump =
            !rest ||
            rest.turn !== turn ||
            at - POINTER.at > 1000 ||
            Math.abs(now[0] - rest.last[0]) > 25 ||
            Math.abs(now[1] - rest.last[1]) > 25;
        POINTER.at = at;
        if (jump) {
          POINTER.rest = { turn, hold: now.slice(), last: now };
          POINTER.tilt[0] = 0;
          POINTER.tilt[1] = 0;
          pointerAim();
          return;
        }
        const ease = 1 - Math.exp(-dt / 4);
        let moved = false;
        for (let k = 0; k < 2; k++) {
          rest.hold[k] += (now[k] - rest.hold[k]) * ease;
          const v = Math.round(clamp((now[k] - rest.hold[k]) / (k ? 6 / 1.4 : 6), -1, 1) * 100) / 100;
          if (v !== POINTER.tilt[k]) {
            POINTER.tilt[k] = v;
            moved = true;
          }
        }
        rest.last = now;
        if (moved) pointerAim();
      },
      { passive: true },
    );
}
addEventListener('resize', () => {
  GPU_LINE.dirty('resize');
  GPU_UI.dirty('resize');
  if (!comp || mainStopped) return;
  try {
    resizeScene();
    retarget();
    springs.track.target = -caret.offsetLeft;
    WORLD_RESIZE.request();
  } catch (error) {
    siteFatal(error);
  }
});
