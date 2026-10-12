function viewport() {
  return [Math.max(1, innerWidth), Math.max(1, innerHeight)];
}

function glScale(W, H) {
  let s = Math.min(LAB.res, devicePixelRatio || 1);
  const px = W * H * s * s;
  if (RES_CAP && px > 3.4e6) s *= Math.sqrt(3.4e6 / px);
  return s;
}

function markRect() {
  const m = mark.getBoundingClientRect(),
    [W, H] = viewport(),
    line = $('line').getBoundingClientRect(),
    ls = parseFloat(getComputedStyle(track).fontSize) || 0;
  world.mark = [m.left / W, m.top / H, m.right / W, m.bottom / H];
  world.read = [(line.top + ls) / H, (line.bottom - 0.5 * ls) / H];
  if (ls && ls !== world.ls) {
    world.ls = ls;
    invalidateTextGround();
  }
}
function worldUrgent() {
  return !!comp?.uploadUrgent;
}
function worldIdle() {
  return !comp?.uploading;
}
function worldWant(cam, D) {
  comp.world({ era: worldEra, dprGL, cam, D });
}

function worldView(cam) {
  const { W, H, geo, mtn } = world,
    fr = x => x - Math.floor(x);
  return {
    sc: geo.map(g => (W * g.ts) / g.R),
    of: geo.map((g, i) => fr((cam * LAYERS[i].pan * H * g.ts) / g.R)),
    n1: LAYERS.map(L => fr(cam * L.pan * 0.5)),
    n3: LAYERS.map(L => fr(cam * L.pan * 1.5)),
    ms: W / mtn.Pc,
    mo: MTN.pan.map(p => fr((cam * p * H) / mtn.Pc)),
  };
}

function whenPainted(fn, t0 = performance.now()) {
  if (!worldUrgent() || performance.now() - t0 > 3000) fn();
  else setTimeout(() => whenPainted(fn, t0), 50);
}

function resizeScene() {
  const [W, H] = viewport();
  dprGL = glScale(W, H);
  comp.resize(Math.round(W * dprGL), Math.round(H * dprGL));
}
function buildWorld(all = false) {
  if (mainStopped || !comp) return false;
  try {
    const [W, H] = viewport();
    world.W = W;
    world.H = H;
    world.kc = clamp(Math.sqrt(W / H) / 1.15, 0.62, 1);
    world.hero = CAM0 * LAYERS[CLOSE].pan * H + 0.3 * W;
    world.seed = WORLD_SEED;
    markRect();
    world.first = OPEN_JA
      ? CAM0
      : CAM0 +
        ((SCRIPT[0].chunks.reduce((n, c) => n + [...c.out].length, 0) *
          (world.ls || parseFloat(getComputedStyle(track).fontSize) || 0)) /
          H) *
          PAN_K *
          TUNE.pan;
    world.geo = worldGeometry(W, H, dprGL, comp.maxTex);
    world.rings = {};
    for (const sc of ['zh', 'ja'])
      world.rings[sc] = world.geo.map(g => ({ has: new Array(g.n).fill(null), want: new Array(g.n).fill(null) }));
    worldEra++;
    comp.alloc(world.geo, { ...world, era: worldEra, dprGL, cam: springs.cam.x, D: st.page.D });
    world.mtn = mountainDimensions(W, H);
    comp.mountains(world.mtn);
    worldWant(springs.cam.x, st.page.D);
    WORLD_BUILT_KEY = [world.W, world.H, dprGL].join('x');
    rzSize = [world.W, world.H].join('x');
    if (GPU_BOOT) {
      GPU_BOOT.worldComp = comp;
      GPU_BOOT.worldEra = worldEra;
    }
    return true;
  } catch (error) {
    siteFatal(error);
    return false;
  }
}
