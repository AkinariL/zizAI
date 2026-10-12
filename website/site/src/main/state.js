let bg = $('bg');
const box = $('box'),
  inner = $('inner'),
  rawEl = $('raw'),
  cwrap = $('cwrap'),
  track = $('track'),
  caret = $('caret'),
  mark = $('mark');

const CAM0 = parseFloat(param('cam') || '4.2') || 0;
const WORLD_SEED =
  param('seed') !== null ? parseInt(param('seed')) >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0] || 1;
const CAM_VIEW = (SITE_DEBUG && parseFloat(param('view') || '')) || CAM0;

const PAN_K = (parseFloat(param('pan') || '1') || 1) * (reduceMotion ? 0.5 : 1);

const st = {
  camT: CAM_VIEW,
  camLead: CAM_VIEW,
  camPrev: CAM_VIEW,
  target: OPEN_P,
  page: new Blend(OPEN_P, CURVES.page),
  box: new Blend(OPEN_P, CURVES.box),
  meter: new Motion(OPEN_P, CURVES.meter),
  boxOn: 0,
  mouse: [0, 0],
  mouseT: [0, 0],
  mouseV: [0, 0],
  veil: 0,
  veilT: 0,
  clock: 0,
  time: 0,
  verse: [OPEN_LANG, OPEN_LANG],
};

const springs = {
  w: new Motion(240, CURVES.w),
  h: new Motion(116, CURVES.h),
  vis: new Motion(0, CURVES.vis),
  track: new Motion(0, CURVES.track),
  cam: new Motion(CAM_VIEW, CURVES.cam),
};

let comp = null,
  dprGL = 1,
  worldEra = 0;
const world = { W: 0, H: 0, kc: 1, hero: 0, geo: null, rings: null, mtn: null, mark: [2, 2, 2, 2], read: [-1, -1] };
const DIAG = { js: 0, jsMax: 0, n: 0 };
const waits = [];
const wait = ms => new Promise(res => waits.push({ t: st.clock + ms, res }));

function invalidateTextGround() {
  GPU_LINE.dirty('ground-parameters');
}
function stopMainAnimation(error) {
  if (mainStopped) return;
  mainStopped = true;
  cancelAnimationFrame(mainFrameId);
  mainFrameId = 0;
  demoGen++;
  for (const pending of waits.splice(0)) pending.res();
  GPU_BOOT?.cancel(error || Error('Main animation stopped'));
  WORLD_RESIZE?.dispose();
  GPU_LINE.dispose();
  GPU_UI.dispose();
}
