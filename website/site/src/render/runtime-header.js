let HASH = '',
  innerWidth = 1,
  innerHeight = 1,
  devicePixelRatio = 1;
let selectedBackend = 'webgpu';
const param = key => {
  const m = HASH.match(new RegExp('(?:^|&)' + key + '(?:=([^&]*))?(?:&|$)'));
  return m ? (m[1] ?? '') : null;
};
globalThis.GPU_CPU_OPTIONS = { sharedMemory: false };
const renderWorld = { era: 0 };
const DIAG = { tiles: 0, up: 0, upMax: 0 };
const TRANS = { F: 0.65, J: 0.5, lag: 0.6, dip: 0.7, wideF: 0.5, wideT: 0.3 };
const LAB = { res: 1.5, ground: true, drift: true, glass: true };
const st = { page: { D: 0, t: 0 }, box: { D: 0, t: 0 } };
const springs = { cam: { x: 4.2 }, w: { x: 0 }, h: { x: 0 } };
const c3 = colour => colour.map(value => value / 255);
const unitOf = (sc, li) => (sc === 'zh' ? 0 : 4) + li;
let drift, boxDrift, comp, tilePainter, textRenderer, uiRenderer;
let debugTileMode = false,
  debugTileConfig = null,
  debugTilePacket = null,
  captureAdvancedAt = null;
const captureEnabled = () => param('debug') !== null && param('capture') === '1';
let sceneState = null,
  stateAt = 0;
let drawState = null,
  drawAt = 0;
const stateQueue = [];
const cadenceMeter = () => ({
  last: 0,
  gaps: [],
  mean: 0,
  add(now) {
    const gap = this.last ? now - this.last : 0;
    this.last = now;
    if (gap > 3 && gap < 60 && this.gaps.push(gap) >= 60) {
      const sorted = this.gaps.slice().sort((a, b) => a - b),
        middle = sorted[30];
      let sum = 0,
        count = 0;
      for (const value of this.gaps)
        if (value > middle * 0.7 && value < middle * 1.3) {
          sum += value;
          count++;
        }
      this.mean = sum / count;
      this.gaps.length = 0;
      return true;
    }
    return false;
  },
});
const ownCadence = cadenceMeter(),
  stateCadence = cadenceMeter();
let cadenceMismatch = 0;
let rafID = 0,
  visible = true,
  disposed = false,
  opening = true,
  nextJobID = 0;
let lastRAF = 0,
  lastDiagnostic = 0,
  lastCamera = 0,
  notifiedValid = false,
  frameCadenceMs = 1000 / 60;
let slowCadenceCount = 0,
  slowCadenceMs = 0;
let refreshWindowAt = 0,
  refreshWindowCount = 0;
const workerFrames = createFrameDiagnostics({ role: 'render-worker', capacity: 360 });
const GPU_LINE = { enabled: false, ack: frame => acknowledge('text', frame) };
const GPU_UI = { enabled: false, ack: frame => acknowledge('ui', frame) };
const acked = { text: null, ui: null };
let pendingFrameAck = null;
