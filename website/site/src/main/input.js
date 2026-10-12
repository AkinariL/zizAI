let rawKeys = [];

function addKey(c, gap) {
  rawKeys.forEach(k => (k.fresh = false));
  rawKeys.push({ c, gap, fresh: true });
  setRaw(rawKeys);
}

function clearRaw() {
  rawKeys = [];
  setRaw(rawKeys);
}

let curList = null;

function setRaw(letters) {
  const before = GPU_UI.beforeRaw();
  rawEl.textContent = '';
  for (const letter of letters) {
    const node = document.createElement('span');
    node.className = 'k' + (letter.gap ? ' gap' : '') + (letter.fresh ? '' : ' old');
    node.textContent = letter.c;
    rawEl.appendChild(node);
  }
  GPU_UI.afterRaw(letters, before);
  retarget();
}
function setCands(list, def) {
  GPU_UI.beforeCands(curList);
  if (curList) {
    const old = curList;
    old.classList.add('old');
    requestAnimationFrame(() => {
      old.classList.add('gone');
      GPU_UI.oldGone(old);
    });
    setTimeout(
      () => {
        old.remove();
        GPU_UI.removeOld(old);
      },
      Math.max(340, (CURVES.candOut.dur * 1000) / TUNE.speed + 80),
    );
    curList = null;
  }
  if (list) {
    let lang = def,
      items = list;
    if (items[0][0] === '@') {
      lang = items[0].slice(1);
      items = items.slice(1);
    }
    const ol = document.createElement('ol');
    ol.className = 'cands';
    let chars = 0;
    items = items.filter((text, index) => {
      chars += candLang(text, lang)[0].length;
      return index < 3 || chars <= 14;
    });
    items.forEach((entry, index) => {
      const [text, language] = candLang(entry, lang),
        li = document.createElement('li');
      li.className = 'cand' + (index === 0 ? ' sel' : '');
      li.dataset.l = language;
      const number = document.createElement('span');
      number.className = 'n';
      number.textContent = String(index + 1);
      const value = document.createElement('span');
      value.className = 't';
      value.lang = language === 'ja' ? 'ja' : 'zh-Hans';
      value.textContent = text;
      li.append(number, value);
      ol.appendChild(li);
    });
    cwrap.appendChild(ol);
    curList = ol;
    const room = viewport()[0] - 24;
    while (ol.children.length > 2 && inner.offsetWidth > room) ol.lastElementChild.remove();
  }
  retarget();
  GPU_UI.afterCands(curList);
}
function pick() {
  if (curList?.firstChild) {
    curList.firstChild.classList.add('pick');
    GPU_UI.pick(curList.firstChild);
  }
}
function retarget() {
  springs.w.target = Math.max(220, inner.offsetWidth);
  springs.h.target = inner.offsetHeight;
}
function showBox(on) {
  st.boxOn = on ? 1 : 0;
  springs.vis.target = on ? 1 : 0;
  caret.classList.toggle('idle', !on);
  GPU_LINE.showBox(on);
  GPU_UI.showBox(on);
}
function inkSpan(text) {
  const ink = document.createElement('span');
  ink.className = 'ink';
  ink.textContent = text;
  return ink;
}

let pre = null;

function startPre(lang) {
  pre = document.createElement('span');
  pre.className = 'pre';
  pre.lang = lang === 'ja' ? 'ja' : 'zh-Hans';
  track.insertBefore(pre, caret);
  GPU_LINE.dirty('start-pre');
}

function addChunk(text, l) {
  const s = document.createElement('span');
  s.className = 'chunk in';
  s.dataset.l = l;
  s.appendChild(inkSpan(text));
  pre.appendChild(s);
  GPU_LINE.addChunk(s);
  s.addEventListener('animationend', () => s.classList.remove('in'), { once: true });
  springs.track.target = -caret.offsetLeft;
  st.camT += (s.offsetWidth / world.H) * PAN_K * TUNE.pan;
}

function commit() {
  const p = pre;
  pre = null;
  p.classList.add('done');
  GPU_LINE.commit(p);
  setTimeout(() => {
    p.className = 'sent';
    for (const c of p.querySelectorAll('.chunk')) {
      c.removeAttribute('class');
      c.removeAttribute('data-l');
    }
    GPU_LINE.dirty('commit-cleanup');
  }, 1300);
  setTimeout(trim, 1500);
}

function trim() {
  GPU_LINE.trim();
}

const cols = [$('col0'), $('col1')];

function buildVerse() {
  cols.forEach((col, i) => {
    for (const l of ['zh', 'ja']) {
      const v = document.createElement('div');
      v.className = 'v';
      v.lang = l === 'ja' ? 'ja' : 'zh-Hans';
      v.dataset.l = l;
      [...SLOGAN[l][i]].forEach((ch, k) => {
        const e = document.createElement('i');
        e.textContent = ch;
        e.style.setProperty('--d', String(k * 110 + i * 260));
        v.appendChild(e);
      });
      col.appendChild(v);
    }
  });
}

function showVerse(i, l) {
  for (const v of cols[i].children) v.classList.toggle('show', v.dataset.l === l);
  GPU_UI.showVerse(i, l);
}
