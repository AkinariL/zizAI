async function createGLParticles(gl, canvasFormat = 'rgba8', options = {}) {
  if (!gl || typeof gl.drawArraysInstanced !== 'function' || typeof gl.createVertexArray !== 'function')
    throw Error('GL particles need a WebGL2 context');
  if (
    typeof particleInitialState !== 'function' ||
    typeof particleControl !== 'function' ||
    typeof particleRandom !== 'function'
  )
    throw Error('GL particles need the shared particle state helpers');
  const C = GLTextUICommon;
  const stateStride = GPU_PARTICLE_STATE_BYTES || 80;
  const floatsPerParticle = stateStride / 4;
  const instanceStride = 20 * 4;
  const metadata = {
    backend: 'webgl2-instanced-particles',
    motion: 'cpu-gl',
    motionBackend: 'cpu-gl-gpu-particle-motion-v1',
    transformBackend: 'webgl2-vertex',
    rng: 'per-particle-u32-mulberry32-high24',
    stateStride: stateStride,
    contactStride: 16,
    instanceStride,
    atlasSource: null,
    atlasWidth: 0,
    atlasHeight: 0,
    atlasBytes: 0,
    bufferBytes: 0,
    cpuStateBytes: 0,
    byteCount: 0,
    peakBytes: 0,
    instances: 0,
    simulationSteps: 0,
    drawCalls: 0,
    instanceUploadBytes: 0,
    fallbackResets: 0,
    shaderReady: false,
    atlasReady: false,
    warnings: [],
    lastTargetWidth: 0,
    lastTargetHeight: 0,
  };
  const slots = new Map();
  let disposed = false,
    atlas = null,
    spriteRecords = null,
    program = null,
    uniforms = null;

  const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPose;
layout(location=1) in vec4 aStyle;
layout(location=2) in vec4 aBox;
layout(location=3) in vec4 aUV;
layout(location=4) in vec4 aExtra;
uniform vec4 uViewport;
uniform float uFade;
out vec2 vUV;
out float vAlpha;
flat out vec4 vRect;
void main(){
  vRect=aUV;
  const vec2 corners[6]=vec2[6](vec2(0.,0.),vec2(1.,0.),vec2(0.,1.),vec2(0.,1.),vec2(1.,0.),vec2(1.,1.));
  if(aExtra.z>0.5){gl_Position=vec4(2.,2.,0.,1.);vUV=vec2(0.);vAlpha=0.;return;}
  vec2 c=aBox.xy+corners[gl_VertexID]*aBox.zw;
  float leaf=1.-aExtra.y,k=aStyle.x/max(aExtra.x,1e-6);
  float c1=cos(aPose.w),c2=cos(aPose.w*0.7+1.1);
  float sx=k*mix(0.35+0.65*abs(c2),1.,leaf),sy=k*(0.22+0.78*abs(c1));
  float r=cos(aPose.z),s=sin(aPose.z);
  vec2 p=vec2(r*sx*c.x-s*sy*c.y,s*sx*c.x+r*sy*c.y)+aPose.xy+uViewport.zw;
  gl_Position=vec4(p.x/uViewport.x*2.-1.,1.-p.y/uViewport.y*2.,0.,1.);
  vUV=aUV.xy+corners[gl_VertexID]*aUV.zw;
  float fade=1.-smoothstep(0.5,1.3,aStyle.w);
  float turn=mix(0.75+0.25*abs(c1),0.8+0.2*abs(c1),leaf);
  vAlpha=aStyle.y*uFade*min(1.,aStyle.z*1.2)*fade*turn;
}`;
  const fragmentSource = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUV;
in float vAlpha;
flat in vec4 vRect;
uniform sampler2D uAtlas;
out vec4 outColor;
void main(){
  vec2 dx=dFdx(vUV),dy=dFdy(vUV),texels=vec2(textureSize(uAtlas,0));
  if(max(length(dx*texels),length(dy*texels))<=1.){outColor=texture(uAtlas,vUV)*vAlpha;return;}
  vec2 lo=vRect.xy,hi=vRect.xy+vRect.zw;vec4 sum=vec4(0.);
  for(int j=0;j<4;j++)for(int i=0;i<4;i++){vec2 o=(vec2(float(i),float(j))+.5)*.25-.5;sum+=textureLod(uAtlas,clamp(vUV+dx*o.x+dy*o.y,lo,hi),0.);}
  outColor=sum*(vAlpha/16.);
}`;

  function recount() {
    let gpu = 0,
      cpu = 0;
    for (const s of slots.values()) {
      gpu += s.glCapacity * instanceStride;
      cpu +=
        s.state.byteLength +
        s.contacts.byteLength +
        s.instances.byteLength +
        s.control.byteLength +
        s.hashes.byteLength;
    }
    metadata.bufferBytes = gpu;
    metadata.cpuStateBytes = cpu;
    metadata.byteCount = metadata.atlasBytes + gpu + cpu;
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
  }
  function assertAlive() {
    if (disposed) throw Error('GL particle renderer was disposed');
  }
  function nextCapacity(count) {
    return Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
  }
  function destroySlot(s) {
    if (s.vao) gl.deleteVertexArray(s.vao);
    if (s.buffer) gl.deleteBuffer(s.buffer);
    s.vao = s.buffer = null;
    s.glCapacity = 0;
  }
  function stateFromDrift(drift) {
    const raw = particleInitialState(drift.ps, false);
    const source = ArrayBuffer.isView(raw)
      ? new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
      : new Float32Array(raw);
    const state = new Float32Array(source.length);
    state.set(source);
    const words = new Uint32Array(state.buffer);
    for (let n = 0; n < drift.ps.length; n++) {
      const p = drift.ps[n],
        i = n * floatsPerParticle;
      if (Number.isInteger(p._glRng)) words[i + 19] = p._glRng >>> 0;
      if (p._glResting) words[i + 18] = 2;
    }
    return state;
  }
  function createSlot(drift, capacity) {
    const state = stateFromDrift(drift),
      count = drift.ps.length;
    const seedHashes = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seedHashes[i * 3] = particleHash1(i * 3 + 1);
      seedHashes[i * 3 + 1] = particleHash1(i * 3 + 2);
      seedHashes[i * 3 + 2] = particleHash1(i * 3 + 3);
    }
    const contacts = new Float32Array(count * 4);
    for (let n = 0; n < count; n++) {
      const saved = drift.ps[n]._glContact;
      if (saved && saved.length >= 4) contacts.set(saved, n * 4);
    }
    return {
      drift,
      count,
      list: drift.ps,
      capacity,
      state,
      floats: state,
      words: new Uint32Array(state.buffer),
      contacts,
      instances: new Float32Array(capacity * 20),
      control: new Float32Array(28),
      seeds: drift.ps.map(p => ({ ...p })),
      hashes: seedHashes,
      width: drift.w,
      height: drift.h,
      steps: 0,
      buffer: null,
      vao: null,
      glCapacity: 0,
      last: { blend: { D: 0, t: 0, F: 0.65, J: 0.5, L: 0.61 } },
    };
  }
  function getSlot(drift, key = drift, reset = false) {
    assertAlive();
    if (!drift || !Array.isArray(drift.ps)) throw Error('GL particles need a Drift');
    const capacity = nextCapacity(drift.ps.length);
    let s = slots.get(key);
    const changed = !s || s.drift !== drift || s.count !== drift.ps.length || s.list !== drift.ps;
    if (!s || s.capacity < capacity || s.drift !== drift) {
      if (s) destroySlot(s);
      s = createSlot(drift, Math.max(capacity, s?.capacity || 0));
      slots.set(key, s);
    } else if (changed || reset) {
      const fresh = createSlot(drift, s.capacity);
      destroySlot(s);
      s = fresh;
      slots.set(key, s);
    }
    recount();
    return s;
  }

  function packSprites(input, maxTextureSize) {
    const items = [],
      sprites = Array.from({ length: 24 }, () => null);
    let x = 2,
      y = 2,
      row = 0,
      usedWidth = 0;
    const width = Math.min(1024, maxTextureSize);
    for (const kind of ['leaf', 'petal'])
      for (let blur = 0; blur < 3; blur++)
        for (let variant = 0; variant < 4; variant++) {
          const source = input[kind][blur][variant],
            w = source.width,
            h = source.height;
          if (w + 4 > width) throw Error('Particle sprite exceeds WebGL texture width');
          if (x + w + 2 > width) {
            x = 2;
            y += row + 4;
            row = 0;
          }
          const index = (kind === 'leaf' ? 0 : 12) + blur * 4 + variant;
          const item = { ...source, x, y, w, h, kind, blur, variant, index };
          items.push(item);
          sprites[index] = item;
          x += w + 4;
          row = Math.max(row, h);
          usedWidth = Math.max(usedWidth, x);
        }
    const height = y + row + 2,
      atlasWidth = Math.max(1, usedWidth);
    if (height > maxTextureSize || atlasWidth > maxTextureSize)
      throw Error('Particle sprite atlas exceeds WebGL texture dimensions');
    return { items, sprites, width: atlasWidth, height };
  }
  function buildAtlasCanvas(pack) {
    const surface = C.canvas(pack.width, pack.height),
      ctx = surface.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw Error('Canvas2D particle atlas preparation is unavailable');
    ctx.clearRect(0, 0, pack.width, pack.height);
    ctx.imageSmoothingEnabled = true;
    for (const item of pack.items) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(item.x, item.y, item.w, item.h);
      ctx.clip();
      ctx.filter = item.blur > 0 ? 'blur(' + item.blur + 'px)' : 'none';
      ctx.drawImage(item.canvas, item.x, item.y);
      ctx.restore();
    }
    const image = ctx.getImageData(0, 0, pack.width, pack.height),
      pixels = new Uint8Array(image.data.length);
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = image.data[i + 3] / 255;
      pixels[i] = Math.round(image.data[i] * alpha);
      pixels[i + 1] = Math.round(image.data[i + 1] * alpha);
      pixels[i + 2] = Math.round(image.data[i + 2] * alpha);
      pixels[i + 3] = image.data[i + 3];
    }
    surface.width = surface.height = 1;
    for (const item of pack.items) {
      item.canvas.width = item.canvas.height = 1;
      delete item.canvas;
    }
    return pixels;
  }

  async function prepareGPU(helpers = {}) {
    assertAlive();
    const { rng, rr, inkLeaf, petalPath } = helpers;
    if (![rng, rr, inkLeaf, petalPath].every(value => typeof value === 'function'))
      throw Error('GL particle atlas needs rng, rr, inkLeaf and petalPath');
    if (atlas) return spriteRecords;
    const began = performance.now();
    const input = { leaf: [[], [], []], petal: [[], [], []] };
    for (let variant = 0; variant < 4; variant++) {
      const random = rng(700 + variant * 13),
        L = 150,
        Wd = L * rr(random, 0.075, 0.095);
      const bend = rr(random, -0.07, 0.07),
        asym = rr(random, -0.2, 0.2);
      for (let blur = 0; blur < 3; blur++) {
        const sigma = [0, 5, 11][blur],
          pad = 6 + sigma * 2.6,
          width = Math.round(L + pad * 2),
          height = Math.round(Wd * 2 + 18 + pad * 2);
        const canvas = C.canvas(width, height),
          ctx = canvas.getContext('2d');
        if (!ctx) throw Error('Canvas2D particle atlas preparation is unavailable');
        brushLeafParticle(ctx, pad, height / 2, L, Wd, bend, asym < 0 ? -1 : 1);
        input.leaf[blur][variant] = { canvas, width, height, len: L, ax: pad + L * 0.5, ay: height / 2, blur: sigma };
      }
      const scale = 2,
        R = 28 * scale;
      for (let blur = 0; blur < 3; blur++) {
        const sigma = [0, 3.5, 8][blur] * scale,
          pad = 5 * scale + sigma * 2.6,
          width = Math.round(R + pad * 2),
          height = Math.round(R * 1.1 + pad * 2);
        const canvas = C.canvas(width, height),
          ctx = canvas.getContext('2d');
        if (!ctx) throw Error('Canvas2D particle atlas preparation is unavailable');
        const oy = height / 2;
        ctx.save();
        ctx.translate(pad, oy);
        ctx.scale(1, rr(random, 0.86, 1.08));
        ctx.beginPath();
        petalPath(ctx, R);
        ctx.restore();
        const gradient = ctx.createLinearGradient(pad, oy, pad + R, oy);
        gradient.addColorStop(0, 'rgba(221,131,156,0.660)');
        gradient.addColorStop(0.4, 'rgba(241,186,201,0.580)');
        gradient.addColorStop(1, 'rgba(251,229,234,0.800)');
        ctx.fillStyle = gradient;
        ctx.fill();
        input.petal[blur][variant] = { canvas, width, height, len: R, ax: pad + R * 0.5, ay: oy, blur: sigma };
      }
    }
    const pack = packSprites(input, gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      pixels = buildAtlasCanvas(pack),
      saved = C.beginState(gl);
    try {
      atlas = C.texture(gl, pack.width, pack.height, pixels, 'GL particle atlas');
    } catch (error) {
      atlas = null;
      throw error;
    } finally {
      C.endState(gl, saved);
    }
    spriteRecords = pack.sprites.map(item => ({
      box: [-item.ax, -item.ay, item.w, item.h],
      tex: [item.x / pack.width, item.y / pack.height, item.w / pack.width, item.h / pack.height],
      size: [item.len, 0, 0, 0],
    }));
    metadata.atlasSource = 'canvas2d-brushLeaf-petalPath-three-blur-levels';
    metadata.atlasWidth = pack.width;
    metadata.atlasHeight = pack.height;
    metadata.atlasBytes = pixels.byteLength;
    metadata.atlasReady = true;
    metadata.prepareMs = performance.now() - began;
    recount();
    return spriteRecords;
  }

  function ensureProgram() {
    if (program) return;
    const saved = C.beginState(gl);
    try {
      program = C.program(gl, vertexSource, fragmentSource, 'GL particles');
      uniforms = C.locations(gl, program, ['uViewport', 'uFade', 'uAtlas']);
      metadata.shaderReady = true;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      program = null;
      throw error;
    } finally {
      C.endState(gl, saved);
    }
  }

  ensureProgram();

  function particleHash1(n) {
    let x = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
    x = Math.imul(((x >>> ((x >>> 28) + 4)) ^ x) >>> 0, 277803737) >>> 0;
    return (((x >>> 22) ^ x) >>> 0) / 4294967296;
  }
  function particleHash2(x, y) {
    return particleHash1((Math.imul(x >>> 0, 1597334677) ^ Math.imul(y >>> 0, 3812015801)) >>> 0);
  }
  function particleNoise(x, y) {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = x - ix,
      fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx),
      uy = fy * fy * (3 - 2 * fy);
    const a = particleHash2(ix, iy),
      b = particleHash2(ix + 1, iy);
    const c = particleHash2(ix, iy + 1),
      d = particleHash2(ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }
  function particleSmoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function particleWeightGPU(kind, x, t, blend) {
    const D = blend[12] > 0.5 ? 1 : 0,
      F = blend[14],
      J = blend[15],
      L = blend[16];
    const edge = 1 + 0.5 * F + 0.5 * J + L - t * (1 + F + J + 2 * L);
    const q = Math.max(0, Math.min(1, (x - (edge - F * 0.5)) / F)),
      m = q * q * (3 - 2 * q);
    const zh = D ? m : 1 - m;
    return kind === 0 ? zh : 1 - zh;
  }
  function randomAt(words, index) {
    let t = (words[index] = (words[index] + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 8) / 16777216;
  }
  function particleOutline(s, i) {
    const f = s.floats,
      u = s.words,
      spriteIndex = u[i + 16];
    const outlineIndex = Math.floor(spriteIndex / 12) * 12 + (spriteIndex % 4);
    const sprite = spriteRecords?.[outlineIndex];
    const box = sprite?.box || [-f[i + 12] * 0.5, -f[i + 12] * 0.5, f[i + 12], f[i + 12]];
    const sizeX = sprite?.size[0] || (u[i + 17] ? 28 : 150),
      leaf = u[i + 17] === 0;
    const k = f[i + 12] / sizeX;
    const sx = k * (leaf ? 1 : 0.35 + 0.65 * Math.abs(Math.cos(f[i + 3] * 0.7 + 1.1)));
    const sy = k * (0.22 + 0.78 * Math.abs(Math.cos(f[i + 3])));
    const cx = (box[0] + 0.5 * box[2]) * sx,
      cy = (box[1] + 0.5 * box[3]) * sy;
    const co = Math.cos(f[i + 2]),
      si = Math.sin(f[i + 2]);
    return [co * cx - si * cy, si * cx + co * cy, 0.46 * box[2] * sx, 0.46 * box[3] * sy];
  }
  function particleReach(o, turn, nx, ny) {
    const ux = Math.cos(turn),
      uy = Math.sin(turn);
    const along = nx * ux + ny * uy,
      across = nx * -uy + ny * ux;
    return Math.hypot(o[2] * along, o[3] * across);
  }
  function placeParticle(s, i, control) {
    const f = s.floats,
      u = s.words,
      random = () => randomAt(u, i + 19);
    const left = control[8],
      top = control[9],
      right = control[10],
      bottom = control[11];
    const width = right - left,
      height = bottom - top;
    if (control[17] > control[13] + 0.0001) {
      f[i] = left + random() * 1.1 * width;
      f[i + 1] = top + random() * height;
    } else if (random() < 0.7) {
      f[i] = left + (0.05 + random() * 1.2) * width;
      f[i + 1] = top - f[i + 12] * 0.8 - 4;
    } else {
      f[i] = right + f[i + 12] * 0.8 + 4;
      f[i + 1] = top + (-0.05 + random() * 0.85) * height;
    }
  }

  function simulateParticleSlot(s, control) {
    const f = s.floats,
      u = s.words,
      contacts = s.contacts,
      count = s.count;
    const dt = control[0],
      left = control[8],
      top = control[9],
      right = control[10],
      bottom = control[11];
    const worldWidth = Math.max(0.000001, right - left),
      worldHeight = Math.max(1, bottom - top);
    const boxOn = control[18] > 0.5,
      corner = control[18],
      unit = control[19],
      fast = 90 * unit;
    const boxLeft = control[20],
      boxTop = control[21],
      boxRight = control[22],
      boxBottom = control[23];
    const leftSpeed = control[24],
      topSpeed = control[25],
      rightSpeed = control[26],
      bottomSpeed = control[27];
    for (let n = 0; n < count; n++) {
      const i = n * floatsPerParticle,
        k = n * 4,
        mode = u[i + 18];
      f[i] *= control[4];
      f[i + 1] *= control[5];
      if (mode === 0) f[i] -= control[2] * (0.8 + 0.25 * f[i + 11]);
      if (control[3] <= 0.5) continue;

      if (mode === 1) {
        f[i + 15] -= dt;
        if (f[i + 15] <= 0) {
          placeParticle(s, i, control);
          const xf = Math.max(0, Math.min(1, (f[i] - left) / worldWidth));
          if (randomAt(u, i + 19) < particleWeightGPU(u[i + 17], xf, control[17], control)) {
            u[i + 18] = 0;
            f[i + 14] = 0;
            f[i + 15] = 0;
            contacts[k] = contacts[k + 1] = contacts[k + 2] = contacts[k + 3] = 0;
          } else f[i + 15] = 0.25 + randomAt(u, i + 19) * 0.65;
        }
        continue;
      }

      if (mode === 2) {
        const h = (u[i + 19] & 1023) / 1023,
          pi = Math.PI,
          lying = particleOutline(s, i);
        contacts[k + 2] = 1;
        f[i + 14] += dt;
        f[i + 15] = 0;
        if (boxOn) {
          f[i] += 0.5 * (leftSpeed + rightSpeed) * dt;
          f[i + 1] = boxTop - particleReach(lying, f[i + 2], 0, 1) - lying[1] - f[i + 12] * 0.05 * h;
        }
        const flat = Math.round(f[i + 2] / pi) * pi + (h - 0.5) * 0.5;
        f[i + 2] += (flat - f[i + 2]) * Math.min(1, dt * 7);
        const lean = Math.floor(f[i + 3] / pi) * pi + 1.2;
        f[i + 3] += (lean - f[i + 3]) * Math.min(1, dt * 7);
        if (
          !boxOn ||
          f[i] + lying[0] < boxLeft + corner * 0.6 ||
          f[i] + lying[0] > boxRight - corner * 0.6 ||
          topSpeed > 2 * fast
        ) {
          u[i + 18] = 0;
          f[i + 15] = -1.5;
          contacts[k] = contacts[k + 1] = contacts[k + 2] = 0;
          contacts[k + 3] = boxOn && topSpeed > 2 * fast ? 0 : 0.3;
        } else if (topSpeed < -fast) {
          const side = f[i] > 0.5 * (boxLeft + boxRight) ? 1 : -1;
          u[i + 18] = 0;
          f[i + 15] = -1.5;
          contacts[k] = side * -topSpeed * 0.4 * (0.3 + randomAt(u, i + 19));
          contacts[k + 1] = topSpeed * 1.25 - 40 * unit * (0.5 + randomAt(u, i + 19));
          contacts[k + 2] = 0;
          contacts[k + 3] = 0.12;
        }
        continue;
      }

      const leaf = u[i + 17] === 0,
        ha = s.hashes[n * 3],
        hb = s.hashes[n * 3 + 1],
        hc = s.hashes[n * 3 + 2];
      let modeFall = 2;
      if (leaf) {
        if (ha < 0.5) modeFall = 0;
        else if (ha < 0.78) modeFall = 1;
      } else {
        if (ha < 0.3) modeFall = 0;
        else if (ha < 0.5) modeFall = 1;
      }
      const clock = control[7],
        tall = worldHeight;
      const qx = (f[i] / tall) * 1.3 + clock * 0.14,
        qy = (f[i + 1] / tall) * 1.3 - clock * 0.03;
      const g = particleNoise(qx, qy),
        gust = control[1] * (0.7 + 0.8 * g * g);
      const lift = particleSmoothstep(0.7, 1, g);
      const turbX = 2 * (particleNoise(qx * 1.7 + 17, qy * 1.7) - 0.5);
      const turbY = 2 * (particleNoise(qx * 1.7, qy * 1.7 + 41) - 0.5);
      const answer = (leaf ? 1.25 : 0.8) * (0.7 + 0.6 * hb);
      f[i + 14] += dt;
      const rate = f[i + 9] * 1.6 * (0.85 + 0.3 * particleNoise(f[i + 14] * 0.25, hc * 50));
      f[i + 8] += rate * dt;
      const c = Math.cos(f[i + 8]);
      let goX = 0,
        goY = 0,
        spin = 0;
      if (modeFall === 0) {
        goX = f[i + 4] * gust * answer + f[i + 10] * 0.9 * rate * c;
        goY = f[i + 5] * (0.7 + 0.5 * c * c) - lift * f[i + 5] * 0.3 * answer;
        spin = f[i + 6] * 0.3 + 0.4 * c * rate;
      } else if (modeFall === 1) {
        const turn = 0.7 * (2 * particleNoise(f[i + 14] * 0.16 + hc * 30, hb * 10) - 1);
        const pace = Math.hypot(f[i + 4], f[i + 5]) * 1.25;
        const course = Math.atan2(f[i + 5], f[i + 4] * gust * answer) + turn;
        goX = pace * Math.cos(course) * (0.8 + 0.4 * g);
        goY = pace * Math.sin(course) * (1 - 0.3 * lift * answer);
        spin = f[i + 6] * 0.5 + 0.2 * c * rate;
      } else {
        const way = f[i + 6] >= 0 ? 1 : -1;
        spin = (0.8 + 0.9 * hc) * way * (0.85 + 0.3 * g);
        goX = f[i + 4] * gust * answer + way * 0.3 * f[i + 5] + 0.15 * f[i + 5] * Math.cos(2 * f[i + 2]);
        goY = f[i + 5] * (0.9 + 0.2 * Math.sin(2 * f[i + 2])) - lift * f[i + 5] * 0.4 * answer;
      }
      f[i] += (goX + turbX * 10 * unit * answer) * dt;
      f[i + 1] += (goY + turbY * 6 * unit * answer) * dt;
      f[i + 2] += spin * dt;
      f[i + 3] += f[i + 7] * (modeFall === 2 ? 1.2 : 1) * dt;
      f[i] += contacts[k] * dt;
      f[i + 1] += contacts[k + 1] * dt;
      f[i + 2] += contacts[k] * 0.01 * dt;
      const drag = Math.exp(-2.6 * dt);
      contacts[k] *= drag;
      contacts[k + 1] *= drag;
      contacts[k + 3] = Math.max(0, contacts[k + 3] - dt);

      if (boxOn) {
        const o = particleOutline(s, i),
          atX = f[i] + o[0],
          atY = f[i + 1] + o[1],
          most = Math.max(o[2], o[3]);
        if (atX + most > boxLeft && atX - most < boxRight && atY + most > boxTop && atY - most < boxBottom) {
          const midX = 0.5 * (boxLeft + boxRight),
            midY = 0.5 * (boxTop + boxBottom);
          const halfX = 0.5 * (boxRight - boxLeft),
            halfY = 0.5 * (boxBottom - boxTop);
          const offX = atX - midX,
            offY = atY - midY,
            wayX = offX >= 0 ? 1 : -1,
            wayY = offY >= 0 ? 1 : -1;
          const qx = Math.abs(offX) - (halfX - corner),
            qy = Math.abs(offY) - (halfY - corner);
          const outsideX = Math.max(qx, 0),
            outsideY = Math.max(qy, 0);
          const away = Math.hypot(outsideX, outsideY) + Math.min(Math.max(qx, qy), 0) - corner;
          let nx = 0,
            ny = wayY;
          if (qx > 0 && qy > 0) {
            const length = Math.hypot(qx, qy);
            nx = (qx / length) * wayX;
            ny = (qy / length) * wayY;
          } else if (qx > qy) {
            nx = wayX;
            ny = 0;
          }
          const over = particleReach(o, f[i + 2], nx, ny) - away;
          if (over > 0) {
            const push =
              Math.max(nx, 0) * rightSpeed -
              Math.max(-nx, 0) * leftSpeed +
              Math.max(ny, 0) * bottomSpeed -
              Math.max(-ny, 0) * topSpeed;
            const reach = 260 * unit * dt + Math.max(push, 0) * dt;
            if (push > fast) {
              f[i] += nx * over;
              f[i + 1] += ny * over;
              contacts[k] += nx * push * 1.25 + (randomAt(u, i + 19) - 0.5) * push * 0.5;
              contacts[k + 1] += ny * push * 1.25 - 30 * unit * (0.5 + randomAt(u, i + 19));
              contacts[k + 3] = 0.12;
            } else if (ny < -0.9 && contacts[k + 3] <= 0 && over <= reach + 3 * unit) {
              u[i + 18] = 2;
              contacts[k] = contacts[k + 1] = 0;
              contacts[k + 2] = 1;
              contacts[k + 3] = 0;
            } else {
              const amount = Math.min(over, reach);
              f[i] += nx * amount;
              f[i + 1] += ny * amount;
            }
          }
        }
      }

      const here = Math.max(0, Math.min(1, (f[i] - left) / worldWidth));
      const currentWeight = particleWeightGPU(u[i + 17], here, control[13], control);
      const futureWeight = particleWeightGPU(u[i + 17], here, control[17], control);
      if (contacts[k + 2] < 0.5 && Math.max(currentWeight, futureWeight) < 0.5) f[i + 15] += dt;
      else if (f[i + 15] > 0) f[i + 15] = Math.max(0, f[i + 15] - 2 * dt);
      if (
        u[i + 18] === 0 &&
        (f[i] < left - f[i + 12] * 1.4 || f[i + 1] > bottom + f[i + 12] * 1.4 || f[i + 15] >= 1.3)
      ) {
        u[i + 18] = 1;
        f[i + 15] = 0;
      }
    }
    s.steps++;
    metadata.simulationSteps++;
    s.last.blend.D = control[12];
    s.last.blend.t = control[13];
    s.last.blend.F = control[14];
    s.last.blend.J = control[15];
    s.last.blend.L = control[16];
  }

  function step(drift, frame = {}) {
    if (disposed) return false;
    const s = getSlot(drift, frame.key || drift);
    const sx = s.width > 0 ? drift.w / s.width : 1,
      sy = s.height > 0 ? drift.h / s.height : 1;
    s.width = drift.w;
    s.height = drift.h;
    const control = particleControl(drift, frame, sx, sy, true, s.control);
    simulateParticleSlot(s, control);
    recount();
    return true;
  }

  function ensureSlotGL(s) {
    if (s.vao && s.buffer && s.glCapacity >= s.capacity) return;
    destroySlot(s);
    const vao = gl.createVertexArray(),
      buffer = gl.createBuffer();
    if (!vao || !buffer) {
      if (vao) gl.deleteVertexArray(vao);
      if (buffer) gl.deleteBuffer(buffer);
      throw Error('Unable to allocate GL particle instance buffer');
    }
    try {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, s.capacity * instanceStride, gl.DYNAMIC_DRAW);
      for (let i = 0; i < 5; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 4, gl.FLOAT, false, instanceStride, i * 16);
        gl.vertexAttribDivisor(i, 1);
      }
      s.vao = vao;
      s.buffer = buffer;
      s.glCapacity = s.capacity;
    } catch (error) {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buffer);
      throw error;
    }
  }
  function fillInstances(s) {
    if (!spriteRecords) return;
    const f = s.floats,
      u = s.words,
      data = s.instances;
    for (let n = 0; n < s.count; n++) {
      const i = n * floatsPerParticle,
        at = n * 20,
        sprite = spriteRecords[u[i + 16]];
      if (!sprite) {
        data.fill(0, at, at + 20);
        data[at + 18] = 1;
        continue;
      }
      data[at] = f[i];
      data[at + 1] = f[i + 1];
      data[at + 2] = f[i + 2];
      data[at + 3] = f[i + 3];
      data[at + 4] = f[i + 12];
      data[at + 5] = f[i + 13];
      data[at + 6] = f[i + 14];
      data[at + 7] = f[i + 15];
      data[at + 8] = sprite.box[0];
      data[at + 9] = sprite.box[1];
      data[at + 10] = sprite.box[2];
      data[at + 11] = sprite.box[3];
      data[at + 12] = sprite.tex[0];
      data[at + 13] = sprite.tex[1];
      data[at + 14] = sprite.tex[2];
      data[at + 15] = sprite.tex[3];
      data[at + 16] = sprite.size[0];
      data[at + 17] = u[i + 17];
      data[at + 18] = u[i + 18] === 1 ? 1 : 0;
      data[at + 19] = 0;
    }
  }
  function encode() {
    return 0;
  }
  function draw(target, drift, fade, viewportW, viewportH, drawOptions = {}) {
    if (disposed || !atlas || fade <= 0.003 || !(viewportW > 0 && viewportH > 0)) return 0;
    const s = getSlot(drift, drawOptions.key || drift);
    metadata.instances = s.count;
    if (!s.count) return 0;
    fillInstances(s);
    const saved = C.beginState(gl);
    try {
      const targetInfo = C.bindTarget(gl, target, target?.width, target?.height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      C.usePremultipliedBlend(gl);
      gl.useProgram(program);
      gl.uniform4f(uniforms.uViewport, viewportW, viewportH, drawOptions.offsetX || 0, drawOptions.offsetY || 0);
      gl.uniform1f(uniforms.uFade, fade);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(uniforms.uAtlas, 0);
      ensureSlotGL(s);
      gl.bindVertexArray(s.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.instances.subarray(0, s.count * 20));
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, s.count);
      metadata.lastTargetWidth = targetInfo.width;
      metadata.lastTargetHeight = targetInfo.height;
      metadata.instanceUploadBytes += s.count * instanceStride;
      metadata.drawCalls++;
    } finally {
      C.endState(gl, saved);
    }
    recount();
    return s.count;
  }

  function restoreCPU() {
    let restored = 0;
    const fields = [
      'x',
      'y',
      'rot',
      'flip',
      'vx',
      'vy',
      'vr',
      'vf',
      'sw',
      'vsw',
      'amp',
      'z',
      'size',
      'alpha',
      'life',
      'retry',
    ];
    for (const s of slots.values()) {
      const f = s.floats,
        u = s.words,
        c = s.contacts;
      for (let n = 0; n < s.count; n++) {
        const i = n * floatsPerParticle,
          k = n * 4,
          p = s.drift.ps[n];
        for (let j = 0; j < fields.length; j++) p[fields[j]] = f[i + j];
        p.kind = u[i + 17] ? 'petal' : 'leaf';
        p.dormant = u[i + 18] === 1;
        p._glResting = u[i + 18] === 2;
        p._glRng = u[i + 19];
        p._glContact = [c[k], c[k + 1], c[k + 2], c[k + 3]];
        restored++;
      }
      s.last = s.last || { blend: {} };
      s.control[12] = s.last.blend.D;
      s.control[13] = s.last.blend.t;
    }
    metadata.fallbackResets++;
    metadata.fallbackState = 'cpu-state-restored';
    return restored;
  }
  function reset(drift, resetOptions = {}) {
    if (disposed) return false;
    getSlot(drift, resetOptions.key || drift, true);
    return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const s of slots.values()) destroySlot(s);
    slots.clear();
    if (atlas) gl.deleteTexture(atlas);
    if (program) gl.deleteProgram(program);
    atlas = program = null;
    spriteRecords = uniforms = null;
    metadata.atlasBytes = metadata.bufferBytes = metadata.cpuStateBytes = metadata.byteCount = 0;
    metadata.atlasReady = false;
    metadata.disposed = true;
  }
  return {
    prepareGPU,
    step,
    encode,
    draw,
    restoreCPU,
    reset,
    dispose,
    metadata,
    get ready() {
      return !disposed && !!program;
    },
    debugSnapshot() {
      return {
        metadata: { ...metadata },
        slots: [...slots.entries()].map(([key, s]) => ({
          key: typeof key === 'string' ? key : 'drift',
          count: s.count,
          capacity: s.capacity,
          steps: s.steps,
        })),
      };
    },
  };
}
