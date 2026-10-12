const $ = id => document.getElementById(id);

const root = document.documentElement;

const HASH = decodeURIComponent(location.hash.slice(1));

const param = k => {
  const m = HASH.match(new RegExp('(?:^|&)' + k + '(?:=([^&]*))?(?:&|$)'));
  return m ? (m[1] ?? '') : null;
};

const STATIC = param('scene');

const OPEN_JA = (() => {
  if (STATIC === 'zh' || STATIC === 'ja' || STATIC === 'mix') return STATIC === 'ja';
  const forced = param('open');
  if (forced === 'zh' || forced === 'ja') return forced === 'ja';
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  for (const tag of list) {
    const primary = String(tag).toLowerCase().split(/[-_]/)[0];
    if (['zh', 'yue', 'cmn', 'wuu', 'hak', 'nan', 'gan', 'lzh'].includes(primary)) return false;
    if (primary === 'ja' || primary === 'en') return true;
  }
  return false;
})();
const OPEN_P = OPEN_JA ? 0.97 : 0.03,
  OPEN_LANG = OPEN_JA ? 'ja' : 'zh';

const STILL = param('still') !== null;

const SPEED = parseFloat(param('speed') || '1') || 1;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const GPU_DIAG = { samples: [], timings: {}, state: 'initializing' };
let mainFrameId = 0,
  mainStopped = false,
  paperValue = 0.8;
