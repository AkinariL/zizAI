const GPU_PARTICLE_STATE_BYTES = 80;
const GPU_PARTICLE_CONTROL_BYTES = 112;
function particleInitialState(ps, directUpload = false) {
  const native = typeof getCPUUtilsRuntime === 'function' && getCPUUtilsRuntime('particle');
  const buffer =
    directUpload && native
      ? native.particleWorkspace(ps.length)
      : new ArrayBuffer(ps.length * GPU_PARTICLE_STATE_BYTES);
  const f = ArrayBuffer.isView(buffer) ? buffer : new Float32Array(buffer),
    u = new Uint32Array(f.buffer, f.byteOffset, f.length);
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
  for (let n = 0; n < ps.length; n++) {
    const p = ps[n],
      i = n * 20;
    for (let k = 0; k < 16; k++) {
      const value = p[fields[k]] ?? (fields[k] === 'retry' ? 0 : NaN);
      if (!Number.isFinite(value)) throw Error('Non-finite particle ' + fields[k]);
      f[i + k] = value;
    }
    if (!p.dormant) f[i + 15] = 0;
    if (
      !['leaf', 'petal'].includes(p.kind) ||
      !Number.isInteger(p.blur) ||
      p.blur < 0 ||
      p.blur > 2 ||
      !Number.isInteger(p.spr) ||
      p.spr < 0 ||
      p.spr > 3
    )
      throw Error('Invalid particle sprite');
    u[i + 16] = (p.kind === 'leaf' ? 0 : 12) + p.blur * 4 + p.spr;
    u[i + 17] = p.kind === 'leaf' ? 0 : 1;
    u[i + 18] = p.dormant ? 1 : 0;
    if (native) continue;
    let seed = (0x811c9dc5 ^ n) >>> 0;
    for (let k = 0; k < 16; k++) seed = Math.imul(seed ^ u[i + k], 0x01000193) >>> 0;
    u[i + 19] = seed;
  }
  if (native) native.hashParticles(buffer, ps.length);
  return buffer;
}
function particleRandom(state) {
  let t = (state.value = (state.value + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
  return ((t ^ (t >>> 14)) >>> 8) / 16777216;
}
function particleWeight(kind, x, blend) {
  const { D, t, F, J, L } = blend,
    e = 1 + 0.5 * F + 0.5 * J + L - t * (1 + F + J + 2 * L);
  const q = Math.max(0, Math.min(1, (x - (e - F / 2)) / F)),
    m = q * q * (3 - 2 * q),
    zh = D ? m : 1 - m;
  return kind === 'leaf' ? zh : 1 - zh;
}
function particleControl(drift, frame, sx = 1, sy = 1, simulate = true, output) {
  const reg = drift.o.region ? drift.o.region() : { x0: 0, x1: drift.w, y0: 0, y1: drift.h };
  const b = frame.blend || { D: 0, t: 0, F: 0.65, J: 0.5, L: 0.61 };
  const a = output || new Float32Array(28);
  a[0] = frame.dt ?? 0;
  a[1] = frame.gust ?? 1;
  a[2] = frame.pan ?? 0;
  a[3] = simulate ? 1 : 0;
  if (simulate && frame.dt > 0) drift.clock = ((drift.clock || 0) + frame.dt) % 3600;
  a[4] = sx;
  a[5] = sy;
  a[6] = drift.ps.length;
  a[7] = drift.clock || 0;
  a[8] = reg.x0;
  a[9] = reg.y0;
  a[10] = reg.x1;
  a[11] = reg.y1;
  const lead = drift.lead || (drift.lead = { t: b.t, D: b.D, rate: 0 });
  if (simulate && frame.dt > 0) {
    const now = b.D === lead.D && b.t >= lead.t ? (b.t - lead.t) / frame.dt : 0;
    lead.rate = b.D === lead.D ? lead.rate + (now - lead.rate) * Math.min(1, frame.dt * 8) : 0;
    lead.t = b.t;
    lead.D = b.D;
  }
  a[12] = b.D;
  a[13] = b.t;
  a[14] = b.F;
  a[15] = b.J;
  a[16] = b.L;
  a[17] = Math.max(0, Math.min(1, b.t + lead.rate));
  a[18] = 0;
  a[19] = (reg.y1 - reg.y0) / 900;
  const rect = frame.rect,
    on = !!rect && rect.opacity > 0.5 && rect.width > 20 && rect.height > 8,
    was = drift.boxBefore;
  for (let i = 20; i < 28; i++) a[i] = 0;
  if (on) {
    const k = Math.max(0.001, rect.scale ?? 1),
      hw = (rect.width * k) / 2,
      hh = (rect.height * k) / 2;
    a[18] = Math.max(1, Math.min(hw, hh, (rect.radius ?? 18) * k));
    a[20] = rect.x - hw;
    a[21] = rect.y - hh;
    a[22] = rect.x + hw;
    a[23] = rect.y + hh;
    if (was && simulate && frame.dt > 0)
      for (let i = 0; i < 4; i++) a[24 + i] = Math.max(-4000, Math.min(4000, (a[20 + i] - was[i]) / frame.dt));
  }
  if (simulate && frame.dt > 0) drift.boxBefore = on ? [a[20], a[21], a[22], a[23]] : null;
  if (!a.every(Number.isFinite) || a[0] < 0 || !(a[14] > 0)) throw Error('Invalid GPU particle controls');
  return a;
}
function particleReferenceStep(state, control) {
  const buffer = ArrayBuffer.isView(state)
    ? state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength)
    : state.slice(0);
  const f = new Float32Array(buffer),
    u = new Uint32Array(buffer),
    a = control;
  if (
    a.length !== 28 ||
    !Array.from(a).every(Number.isFinite) ||
    a[6] > buffer.byteLength / GPU_PARTICLE_STATE_BYTES ||
    a[6] < 0 ||
    !Number.isInteger(a[6])
  )
    throw Error('Invalid particle oracle input');
  const blend = { D: a[12], t: a[13], F: a[14], J: a[15], L: a[16] },
    dt = a[0];
  for (let n = 0; n < a[6]; n++) {
    const i = n * 20;
    f[i] *= a[4];
    f[i + 1] *= a[5];
    if (!u[i + 18]) f[i] -= a[2] * (0.8 + 0.25 * f[i + 11]);
    if (a[3] <= 0.5) continue;
    if (u[i + 18]) {
      f[i + 15] -= dt;
      if (f[i + 15] <= 0) {
        const random = { value: u[i + 19] },
          rw = a[10] - a[8],
          rh = a[11] - a[9];
        if (a[17] > a[13] + 0.0001) {
          f[i] = a[8] + particleRandom(random) * 1.1 * rw;
          f[i + 1] = a[9] + particleRandom(random) * rh;
        } else if (particleRandom(random) < 0.7) {
          f[i] = a[8] + (0.05 + particleRandom(random) * 1.2) * rw;
          f[i + 1] = a[9] - f[i + 12] * 0.8 - 4;
        } else {
          f[i] = a[10] + f[i + 12] * 0.8 + 4;
          f[i + 1] = a[9] + (-0.05 + particleRandom(random) * 0.85) * rh;
        }
        const xf = Math.max(0, Math.min(1, (f[i] - a[8]) / Math.max(0.000001, rw))),
          kind = u[i + 17] ? 'petal' : 'leaf';
        if (particleRandom(random) < particleWeight(kind, xf, { ...blend, t: a[17] })) {
          u[i + 18] = 0;
          f[i + 14] = 0;
          f[i + 15] = 0;
        } else f[i + 15] = 0.25 + particleRandom(random) * 0.65;
        u[i + 19] = random.value;
      }
    } else {
      f[i + 14] += dt;
      f[i + 8] += f[i + 9] * dt;
      f[i + 3] += f[i + 7] * dt;
      const c = Math.cos(f[i + 8]);
      f[i] += (f[i + 4] * a[1] + c * f[i + 10] * f[i + 9]) * dt;
      f[i + 1] += f[i + 5] * (0.85 + 0.3 * Math.sin(f[i + 8] * 0.5 + 1)) * dt;
      f[i + 2] += f[i + 6] * dt + c * (u[i + 17] ? 0.6 : 0.35) * dt;
      const here = Math.max(0, Math.min(1, (f[i] - a[8]) / Math.max(0.000001, a[10] - a[8])));
      if (
        Math.max(
          particleWeight(u[i + 17] ? 'petal' : 'leaf', here, blend),
          particleWeight(u[i + 17] ? 'petal' : 'leaf', here, { ...blend, t: a[17] }),
        ) < 0.5
      )
        f[i + 15] += dt;
      else f[i + 15] = Math.max(0, f[i + 15] - 2 * dt);
      if (f[i] < a[8] - f[i + 12] * 1.4 || f[i + 1] > a[11] + f[i + 12] * 1.4 || f[i + 15] >= 1.3) {
        u[i + 18] = 1;
        f[i + 15] = 0;
      }
    }
  }
  return buffer;
}
const GPU_PARTICLE_TYPES = `
struct Particle { pose: vec4f, velocity: vec4f, sway: vec4f, style: vec4f, info: vec4u }
`;
const GPU_PARTICLE_MOTION =
  GPU_PARTICLE_TYPES +
  `
struct Control { time: vec4f, scaleCount: vec4f, region: vec4f, blend: vec4f, misc: vec4f, box: vec4f, boxSpeed: vec4f }
@group(0) @binding(0) var<storage,read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> control: Control;
@group(0) @binding(2) var<storage,read_write> contacts: array<vec4f>;
struct Sprite { box: vec4f, tex: vec4f, size: vec4f }
@group(0) @binding(3) var<storage,read> sprites: array<Sprite>;
fn outline(p: Particle) -> vec4f {
  let s = sprites[(p.info.x / 12u) * 12u + p.info.x % 4u]; let leaf = p.info.y == 0u; let k = p.style.x / s.size.x;
  let sx = k * select(0.35 + 0.65 * abs(cos(p.pose.w * 0.7 + 1.1)), 1.0, leaf); let sy = k * (0.22 + 0.78 * abs(cos(p.pose.w)));
  let c = (s.box.xy + 0.5 * s.box.zw) * vec2f(sx, sy); let co = cos(p.pose.z); let si = sin(p.pose.z);
  return vec4f(co * c.x - si * c.y, si * c.x + co * c.y, 0.46 * s.box.z * sx, 0.46 * s.box.w * sy);
}
fn reachOf(o: vec4f, turn: f32, n: vec2f) -> f32 {
  let u = vec2f(cos(turn), sin(turn)); return length(vec2f(o.z * dot(n, u), o.w * dot(n, vec2f(-u.y, u.x))));
}
fn hash1(n: u32) -> f32 { var x = n * 747796405u + 2891336453u; x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u; return f32((x >> 22u) ^ x) / 4294967296.0; }
fn hash2(c: vec2i) -> f32 { return hash1((u32(c.x) * 1597334677u) ^ (u32(c.y) * 3812015801u)); }
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2i(1, 0)), u.x), mix(hash2(i + vec2i(0, 1)), hash2(i + vec2i(1, 1)), u.x), u.y);
}
fn random(p: ptr<function,Particle>) -> f32 {
  (*p).info.w = (*p).info.w + 0x6d2b79f5u;
  var t = (*p).info.w;
  t = (t ^ (t >> 15u)) * (t | 1u);
  t = t ^ (t + (t ^ (t >> 7u)) * (t | 61u));
  return f32((t ^ (t >> 14u)) >> 8u) / 16777216.0;
}
fn place(p: ptr<function,Particle>) {
  let r = control.region; let width = r.z - r.x; let height = r.w - r.y;
  if (control.misc.y > control.blend.y + 0.0001) {
    (*p).pose.x = r.x + random(p) * 1.1 * width; (*p).pose.y = r.y + random(p) * height;
  } else if (random(p) < 0.7) {
    (*p).pose.x = r.x + (0.05 + random(p) * 1.2) * width;
    (*p).pose.y = r.y - (*p).style.x * 0.8 - 4.0;
  } else {
    (*p).pose.x = r.z + (*p).style.x * 0.8 + 4.0;
    (*p).pose.y = r.y + (-0.05 + random(p) * 0.85) * height;
  }
}
fn weight(kind: u32, x: f32, t: f32) -> f32 {
  let b = control.blend; let L = control.misc.x;
  let e = 1.0 + 0.5 * b.z + 0.5 * b.w + L - t * (1.0 + b.z + b.w + 2.0 * L);
  let q = clamp((x - (e - b.z * 0.5)) / b.z, 0.0, 1.0); let m = q * q * (3.0 - 2.0 * q);
  let zh = select(1.0 - m, m, b.x > 0.5);
  return select(1.0 - zh, zh, kind == 0u);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(control.scaleCount.z)) { return; }
  var p = particles[id.x]; var k = contacts[id.x]; let dt = control.time.x; let r = control.region;
  let b = control.box; let v = control.boxSpeed; let boxOn = control.misc.z > 0.5; let corner = control.misc.z; let unit = control.misc.w; let fast = 90.0 * unit;
  p.pose.x = p.pose.x * control.scaleCount.x; p.pose.y = p.pose.y * control.scaleCount.y;
  if (p.info.z == 0u) { p.pose.x = p.pose.x - control.time.z * (0.8 + 0.25 * p.sway.w); }
  if (control.time.w > 0.5) {
    if (p.info.z == 1u) {
      p.style.w = p.style.w - dt;
      if (p.style.w <= 0.0) {
        place(&p);
        let xf = clamp((p.pose.x - r.x) / max(0.000001, r.z - r.x), 0.0, 1.0);
        if (random(&p) < weight(p.info.y, xf, control.misc.y)) { p.info.z = 0u; p.style.z = 0.0; p.style.w = 0.0; k = vec4f(0.0); }
        else { p.style.w = 0.25 + random(&p) * 0.65; }
      }
    } else if (p.info.z == 2u) {
      let h = f32(p.info.w & 1023u) / 1023.0; let pi = 3.14159265;
      k.z = 1.0; p.style.z = p.style.z + dt; p.style.w = 0.0;
      let lying = outline(p);
      if (boxOn) { p.pose.x = p.pose.x + 0.5 * (v.x + v.z) * dt; p.pose.y = b.y - reachOf(lying, p.pose.z, vec2f(0.0, 1.0)) - lying.y - p.style.x * 0.05 * h; }
      let flat = round(p.pose.z / pi) * pi + (h - 0.5) * 0.5; p.pose.z = p.pose.z + (flat - p.pose.z) * min(1.0, dt * 7.0);
      let lean = floor(p.pose.w / pi) * pi + 1.2; p.pose.w = p.pose.w + (lean - p.pose.w) * min(1.0, dt * 7.0);
      if (!boxOn || p.pose.x + lying.x < b.x + corner * 0.6 || p.pose.x + lying.x > b.z - corner * 0.6 || v.y > 2.0 * fast) {
        p.info.z = 0u; p.style.w = -1.5; k = vec4f(0.0, 0.0, 0.0, select(0.3, 0.0, boxOn && v.y > 2.0 * fast));
      } else if (v.y < -fast) {
        let side = select(-1.0, 1.0, p.pose.x > 0.5 * (b.x + b.z));
        p.info.z = 0u; p.style.w = -1.5; k = vec4f(side * -v.y * 0.4 * (0.3 + random(&p)), v.y * 1.25 - 40.0 * unit * (0.5 + random(&p)), 0.0, 0.12);
      }
    } else {
      let leaf = p.info.y == 0u; let clock = control.scaleCount.w; let tall = max(1.0, r.w - r.y);
      let ha = hash1(id.x * 3u + 1u); let hb = hash1(id.x * 3u + 2u); let hc = hash1(id.x * 3u + 3u);
      var mode = 2u;
      if (leaf) { if (ha < 0.5) { mode = 0u; } else if (ha < 0.78) { mode = 1u; } } else { if (ha < 0.3) { mode = 0u; } else if (ha < 0.5) { mode = 1u; } }
      let q = vec2f(p.pose.x / tall * 1.3 + clock * 0.14, p.pose.y / tall * 1.3 - clock * 0.03);
      let g = vnoise(q); let gust = control.time.y * (0.7 + 0.8 * g * g); let lift = smoothstep(0.7, 1.0, g);
      let turb = vec2f(vnoise(q * 1.7 + vec2f(17.0, 0.0)) - 0.5, vnoise(q * 1.7 + vec2f(0.0, 41.0)) - 0.5) * 2.0;
      let answer = select(1.25, 0.8, leaf) * (0.7 + 0.6 * hb);
      p.style.z = p.style.z + dt;
      let rate = p.sway.y * 1.6 * (0.85 + 0.3 * vnoise(vec2f(p.style.z * 0.25, hc * 50.0)));
      p.sway.x = p.sway.x + rate * dt; let c = cos(p.sway.x);
      var go = vec2f(0.0); var spin = 0.0;
      if (mode == 0u) {
        go = vec2f(p.velocity.x * gust * answer + p.sway.z * 0.9 * rate * c, p.velocity.y * (0.7 + 0.5 * c * c) - lift * p.velocity.y * 0.3 * answer);
        spin = p.velocity.z * 0.3 + 0.4 * c * rate;
      } else if (mode == 1u) {
        let turn = 0.7 * (2.0 * vnoise(vec2f(p.style.z * 0.16 + hc * 30.0, hb * 10.0)) - 1.0);
        let pace = length(p.velocity.xy) * 1.25; let course = atan2(p.velocity.y, p.velocity.x * gust * answer) + turn;
        go = vec2f(pace * cos(course) * (0.8 + 0.4 * g), pace * sin(course) * (1.0 - 0.3 * lift * answer));
        spin = p.velocity.z * 0.5 + 0.2 * c * rate;
      } else {
        let way = select(-1.0, 1.0, p.velocity.z >= 0.0);
        spin = (0.8 + 0.9 * hc) * way * (0.85 + 0.3 * g);
        go = vec2f(p.velocity.x * gust * answer + way * 0.3 * p.velocity.y + 0.15 * p.velocity.y * cos(2.0 * p.pose.z),
                   p.velocity.y * (0.9 + 0.2 * sin(2.0 * p.pose.z)) - lift * p.velocity.y * 0.4 * answer);
      }
      p.pose.x = p.pose.x + (go.x + turb.x * 10.0 * unit * answer) * dt; p.pose.y = p.pose.y + (go.y + turb.y * 6.0 * unit * answer) * dt;
      p.pose.z = p.pose.z + spin * dt; p.pose.w = p.pose.w + p.velocity.w * select(1.0, 1.2, mode == 2u) * dt;
      p.pose.x = p.pose.x + k.x * dt; p.pose.y = p.pose.y + k.y * dt; p.pose.z = p.pose.z + k.x * 0.01 * dt;
      let drag = exp(-2.6 * dt); k.x = k.x * drag; k.y = k.y * drag; k.w = max(0.0, k.w - dt);
      if (boxOn) {
        let o = outline(p); let at = p.pose.xy + o.xy; let most = max(o.z, o.w);
        if (at.x + most > b.x && at.x - most < b.z && at.y + most > b.y && at.y - most < b.w) {
          let middle = 0.5 * (b.xy + b.zw); let half = 0.5 * (b.zw - b.xy); let off = at - middle;
          let way = vec2f(select(-1.0, 1.0, off.x >= 0.0), select(-1.0, 1.0, off.y >= 0.0));
          let q = abs(off) - (half - vec2f(corner));
          let away = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - corner;
          var n = vec2f(0.0, way.y);
          if (q.x > 0.0 && q.y > 0.0) { n = normalize(q) * way; } else if (q.x > q.y) { n = vec2f(way.x, 0.0); }
          let over = reachOf(o, p.pose.z, n) - away;
          if (over > 0.0) {
            let push = max(n.x, 0.0) * v.z - max(-n.x, 0.0) * v.x + max(n.y, 0.0) * v.w - max(-n.y, 0.0) * v.y;
            let reach = 260.0 * unit * dt + max(push, 0.0) * dt;
            if (push > fast) {
              p.pose.x = p.pose.x + n.x * over; p.pose.y = p.pose.y + n.y * over;
              k = vec4f(k.x + n.x * push * 1.25 + (random(&p) - 0.5) * push * 0.5, k.y + n.y * push * 1.25 - 30.0 * unit * (0.5 + random(&p)), k.z, 0.12);
            } else if (n.y < -0.9 && k.w <= 0.0 && over <= reach + 3.0 * unit) { p.info.z = 2u; k = vec4f(0.0, 0.0, 1.0, 0.0); }
            else { let amount = min(over, reach); p.pose.x = p.pose.x + n.x * amount; p.pose.y = p.pose.y + n.y * amount; }
          }
        }
      }
      let here = clamp((p.pose.x - r.x) / max(0.000001, r.z - r.x), 0.0, 1.0);
      if (k.z < 0.5 && max(weight(p.info.y, here, control.blend.y), weight(p.info.y, here, control.misc.y)) < 0.5) { p.style.w = p.style.w + dt; } else if (p.style.w > 0.0) { p.style.w = max(0.0, p.style.w - 2.0 * dt); }
      if (p.info.z == 0u && (p.pose.x < r.x - p.style.x * 1.4 || p.pose.y > r.w + p.style.x * 1.4 || p.style.w >= 1.3)) { p.info.z = 1u; p.style.w = 0.0; }
    }
  }
  particles[id.x] = p; contacts[id.x] = k;
}
`;
const GPU_PARTICLE_VERTEX =
  GPU_PARTICLE_TYPES +
  `
struct View { value: vec4f, fade: vec4f }
struct Sprite { box: vec4f, tex: vec4f, size: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var spriteSampler: sampler;
@group(0) @binding(2) var spriteAtlas: texture_2d<f32>;
@group(0) @binding(3) var<storage,read> particles: array<Particle>;
@group(0) @binding(4) var<storage,read> sprites: array<Sprite>;
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) alpha: f32, @location(2) @interpolate(flat) rect: vec4f }
@vertex fn vertexMain(@builtin(vertex_index) i: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  var out: VertexOut; let p = particles[instance];
  if (p.info.z == 1u) { out.position = vec4f(2,2,0,1); out.uv = vec2f(0); out.alpha = 0.0; return out; }
  let sprite = sprites[p.info.x];
  let corners = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
  let corner = corners[i]; let local = sprite.box.xy + corner * sprite.box.zw;
  let leaf = p.info.y == 0u; let k = p.style.x / sprite.size.x;
  let f1 = cos(p.pose.w); let f2 = cos(p.pose.w * 0.7 + 1.1);
  let sx = k * select(0.35 + 0.65 * abs(f2), 1.0, leaf); let sy = k * (0.22 + 0.78 * abs(f1));
  let c = cos(p.pose.z); let sn = sin(p.pose.z);
  let position = vec2f(c * sx * local.x - sn * sy * local.y, sn * sx * local.x + c * sy * local.y) + p.pose.xy + view.value.zw;
  out.position = vec4f(position.x / view.value.x * 2.0 - 1.0, 1.0 - position.y / view.value.y * 2.0, 0, 1);
  out.uv = sprite.tex.xy + corner * sprite.tex.zw; out.rect = sprite.tex;
  out.alpha = p.style.y * view.fade.x * min(1.0, p.style.z * 1.2) * (1.0 - smoothstep(0.5, 1.3, p.style.w)) * select(0.75 + 0.25 * abs(f1), 0.8 + 0.2 * abs(f1), leaf);
  return out;
}
@fragment fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let dx = dpdx(in.uv); let dy = dpdy(in.uv); let texels = vec2f(textureDimensions(spriteAtlas));
  let lo = in.rect.xy; let hi = in.rect.xy + in.rect.zw;
  if (max(length(dx * texels), length(dy * texels)) <= 1.0) { return textureSampleLevel(spriteAtlas, spriteSampler, in.uv, 0.0) * in.alpha; }
  var sum = vec4f(0);
  for (var j = 0; j < 4; j++) { for (var i = 0; i < 4; i++) {
    let o = (vec2f(f32(i), f32(j)) + 0.5) * 0.25 - 0.5;
    sum += textureSampleLevel(spriteAtlas, spriteSampler, clamp(in.uv + dx * o.x + dy * o.y, lo, hi), 0.0);
  } }
  return sum * (in.alpha / 16.0);
}
`;
async function createGPUParticles(device, canvasFormat, options = {}) {
  const creationValidation = operation =>
    options.constructionScope?.active ? operation() : particleValidationScope(device, operation);
  const batch = async jobs => {
    const settled = await Promise.allSettled(jobs),
      failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return settled.map(result => result.value);
  };
  return creationValidation(async () => {
    const U = GPUBufferUsage,
      T = GPUTextureUsage,
      S = GPUShaderStage;
    const controlStride =
      Math.ceil(GPU_PARTICLE_CONTROL_BYTES / (device.limits.minUniformBufferOffsetAlignment || 256)) *
      (device.limits.minUniformBufferOffsetAlignment || 256);
    const blend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const metadata = {
      backend: 'webgpu-instanced',
      motion: 'compute',
      motionBackend: 'webgpu-compute',
      transformBackend: 'webgpu-vertex',
      rng: 'per-particle-u32-mulberry32-high24',
      initialRNG: 'unchanged-Drift.seed; hash-state-without-extra-random-calls',
      respawnRNGMatchesV7: false,
      perFrameReadback: false,
      stateStride: GPU_PARTICLE_STATE_BYTES,
      controlBytes: GPU_PARTICLE_CONTROL_BYTES,
      atlasSource: null,
      atlasWidth: 0,
      atlasHeight: 0,
      atlasBytes: 0,
      bufferBytes: 0,
      byteCount: 0,
      bakePeakBytes: 0,
      instances: 0,
      instancesIncludeDormant: true,
      simulationSteps: 0,
      stateUploadBytes: 0,
      controlUploadBytes: 0,
      viewUploadBytes: 0,
      fallbackResets: 0,
      warnings: [],
    };
    let atlas = null,
      atlasView = null,
      sprites = null,
      spriteBuffer = null,
      disposed = false;
    const slots = new Map();
    async function checkedModule(label, code) {
      const m = device.createShaderModule({ label, code });
      const info = await m.getCompilationInfo();
      const errors = info.messages.filter(x => x.type === 'error');
      if (errors.length)
        throw Error(label + ': ' + errors.map(x => `${x.lineNum}:${x.linePos} ${x.message}`).join('\n'));
      metadata.warnings.push(...info.messages.filter(x => x.type === 'warning').map(x => label + ': ' + x.message));
      return m;
    }
    const renderLayout = device.createBindGroupLayout({
      label: 'particle vertex state',
      entries: [
        { binding: 0, visibility: S.VERTEX, buffer: { type: 'uniform', minBindingSize: 32 } },
        { binding: 1, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
        {
          binding: 3,
          visibility: S.VERTEX,
          buffer: { type: 'read-only-storage', minBindingSize: GPU_PARTICLE_STATE_BYTES },
        },
        { binding: 4, visibility: S.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 48 } },
      ],
    });
    const motionLayout = device.createBindGroupLayout({
      label: 'particle compute state',
      entries: [
        { binding: 0, visibility: S.COMPUTE, buffer: { type: 'storage', minBindingSize: GPU_PARTICLE_STATE_BYTES } },
        {
          binding: 1,
          visibility: S.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: GPU_PARTICLE_CONTROL_BYTES },
        },
        { binding: 2, visibility: S.COMPUTE, buffer: { type: 'storage', minBindingSize: 16 } },
        { binding: 3, visibility: S.COMPUTE, buffer: { type: 'read-only-storage', minBindingSize: 48 } },
      ],
    });
    const [module, motionModule] = await batch([
      checkedModule('particle vertex transforms', GPU_PARTICLE_VERTEX),
      checkedModule('particle motion + respawn', GPU_PARTICLE_MOTION),
    ]);
    const [pipeline, motionPipeline] = await batch([
      device.createRenderPipelineAsync({
        label: 'particle vertex transforms',
        layout: device.createPipelineLayout({ bindGroupLayouts: [renderLayout] }),
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: canvasFormat, blend }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createComputePipelineAsync({
        label: 'particle motion + respawn',
        layout: device.createPipelineLayout({ bindGroupLayouts: [motionLayout] }),
        compute: { module: motionModule, entryPoint: 'main' },
      }),
    ]);
    const sampler = device.createSampler({
      label: 'particle atlas sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    function recount() {
      metadata.bufferBytes =
        (spriteBuffer ? 24 * 48 : 0) +
        [...slots.values()].reduce(
          (n, s) => n + s.capacity * (GPU_PARTICLE_STATE_BYTES + 16) + 32 + s.controlCapacity * controlStride,
          0,
        );
      metadata.byteCount = metadata.atlasBytes + metadata.bufferBytes;
    }
    function packed(input) {
      const items = [],
        result = { leaf: [[], [], []], petal: [[], [], []] };
      let x = 2,
        y = 2,
        row = 0,
        usedWidth = 0;
      const width = Math.min(1024, device.limits.maxTextureDimension2D);
      for (const kind of ['leaf', 'petal'])
        for (let b = 0; b < 3; b++)
          for (let v = 0; v < 4; v++) {
            const source = input[kind][b][v],
              w = source.c.width,
              h = source.c.height;
            if (w + 4 > width) throw Error('Particle sprite exceeds texture limit');
            if (x + w + 2 > width) {
              x = 2;
              y += row + 4;
              row = 0;
            }
            const item = { ...source, x, y, w, h, kind, b, v };
            items.push(item);
            result[kind][b][v] = item;
            x += w + 4;
            row = Math.max(row, h);
            usedWidth = Math.max(usedWidth, x);
          }
      const h = y + row + 2;
      if (h > device.limits.maxTextureDimension2D) throw Error('Particle atlas exceeds texture limit');
      return { items, sprites: result, width: Math.max(1, usedWidth), height: h };
    }
    function install(texture, pack, source) {
      if (atlas) atlas.destroy();
      atlas = texture;
      atlasView = atlas.createView();
      sprites = pack.sprites;
      if (spriteBuffer) spriteBuffer.destroy();
      const data = new Float32Array(24 * 12);
      for (const p of pack.items) {
        const i = ((p.kind === 'leaf' ? 0 : 12) + p.b * 4 + p.v) * 12;
        data.set(
          [
            -p.ax,
            -p.ay,
            p.w,
            p.h,
            p.x / pack.width,
            p.y / pack.height,
            p.w / pack.width,
            p.h / pack.height,
            p.len,
            0,
            0,
            0,
          ],
          i,
        );
      }
      spriteBuffer = device.createBuffer({
        label: 'particle sprite geometry',
        size: data.byteLength,
        usage: U.STORAGE,
        mappedAtCreation: true,
      });
      new Float32Array(spriteBuffer.getMappedRange()).set(data);
      spriteBuffer.unmap();
      metadata.atlasSource = source;
      metadata.atlasWidth = pack.width;
      metadata.atlasHeight = pack.height;
      metadata.atlasBytes = pack.width * pack.height * 4;
      for (const s of slots.values()) {
        s.bindGroup = null;
        s.motionGroup = null;
      }
      recount();
      return sprites;
    }
    function destroySlot(s) {
      s.buffer.destroy();
      s.contacts.destroy();
      s.uniform.destroy();
      s.controls.destroy();
    }
    function getSlot(drift, key = drift, reset = false) {
      if (!drift || !Array.isArray(drift.ps)) throw Error('GPU particles need a Drift');
      let s = slots.get(key);
      const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, drift.ps.length))));
      const changed = !s || s.drift !== drift || s.count !== drift.ps.length || s.list !== drift.ps;
      if (!s || s.capacity < capacity || s.drift !== drift) {
        if (s) destroySlot(s);
        s = {
          drift,
          capacity,
          count: 0,
          list: null,
          seeds: [],
          pending: [],
          controlPool: [],
          controlData: new Float32Array((4 * controlStride) / 4),
          viewData: new Float32Array(8),
          controlCapacity: 4,
          width: drift.w,
          height: drift.h,
          buffer: device.createBuffer({
            label: 'particle GPU state',
            size: capacity * GPU_PARTICLE_STATE_BYTES,
            usage: U.STORAGE | U.COPY_DST | (options.debug ? U.COPY_SRC : 0),
          }),
          contacts: device.createBuffer({
            label: 'particle contact state',
            size: capacity * 16,
            usage: U.STORAGE | U.COPY_DST,
          }),
          uniform: device.createBuffer({ label: 'particle viewport + fade', size: 32, usage: U.UNIFORM | U.COPY_DST }),
          controls: device.createBuffer({
            label: 'particle motion controls',
            size: 4 * controlStride,
            usage: U.UNIFORM | U.COPY_DST,
          }),
          bindGroup: null,
          motionGroup: null,
        };
        slots.set(key, s);
        recount();
      }
      if (changed || reset) {
        const state = particleInitialState(drift.ps, true);
        if (state.byteLength) {
          device.queue.writeBuffer(s.buffer, 0, state);
          device.queue.writeBuffer(s.contacts, 0, new Float32Array(s.capacity * 4));
        }
        metadata.stateUploadBytes += state.byteLength;
        s.count = drift.ps.length;
        s.list = drift.ps;
        s.seeds = drift.ps.map(p => ({ ...p }));
        s.pending.length = 0;
        s.width = drift.w;
        s.height = drift.h;
        s.steps = 0;
        s.last = null;
      }
      return s;
    }
    function dimensions(s) {
      const sx = s.width > 0 ? s.drift.w / s.width : 1,
        sy = s.height > 0 ? s.drift.h / s.height : 1;
      s.width = s.drift.w;
      s.height = s.drift.h;
      return [sx, sy];
    }
    function queueControl(s, frame, sx, sy, simulate) {
      const i = s.pending.length;
      if (!s.controlPool[i]) s.controlPool[i] = new Float32Array(28);
      const controls = particleControl(s.drift, frame, sx, sy, simulate, s.controlPool[i]);
      s.pending.push(controls);
      return controls;
    }
    function step(drift, frame = {}) {
      if (disposed) return false;
      const s = getSlot(drift, frame.key || drift),
        [sx, sy] = dimensions(s);
      const controls = queueControl(s, frame, sx, sy, true);
      if (!s.last) s.last = { blend: {} };
      const b = s.last.blend;
      b.D = controls[12];
      b.t = controls[13];
      b.F = controls[14];
      b.J = controls[15];
      b.L = controls[16];
      return true;
    }
    function encode(encoder, drifts = []) {
      if (disposed) return 0;
      for (const item of drifts) {
        const drift = item.drift || item,
          s = getSlot(drift, item.key || drift),
          [sx, sy] = dimensions(s);
        if (sx !== 1 || sy !== 1) queueControl(s, s.last || {}, sx, sy, false);
      }
      let count = 0,
        pass = null;
      for (const s of slots.values()) {
        if (!s.pending.length) continue;
        if (!s.count) {
          s.pending.length = 0;
          continue;
        }
        if (s.pending.length > s.controlCapacity) {
          s.controls.destroy();
          s.controlCapacity = 2 ** Math.ceil(Math.log2(s.pending.length));
          s.controls = device.createBuffer({
            label: 'particle motion controls',
            size: s.controlCapacity * controlStride,
            usage: U.UNIFORM | U.COPY_DST,
          });
          s.controlData = new Float32Array((s.controlCapacity * controlStride) / 4);
          s.motionGroup = null;
          recount();
        }
        const length = ((s.pending.length - 1) * controlStride + GPU_PARTICLE_CONTROL_BYTES) / 4;
        for (let i = 0; i < s.pending.length; i++) s.controlData.set(s.pending[i], (i * controlStride) / 4);
        device.queue.writeBuffer(s.controls, 0, s.controlData, 0, length);
        metadata.controlUploadBytes += length * 4;
        if (!s.motionGroup)
          s.motionGroup = device.createBindGroup({
            layout: motionLayout,
            entries: [
              { binding: 0, resource: { buffer: s.buffer } },
              { binding: 1, resource: { buffer: s.controls, size: GPU_PARTICLE_CONTROL_BYTES } },
              { binding: 2, resource: { buffer: s.contacts } },
              { binding: 3, resource: { buffer: spriteBuffer } },
            ],
          });
        if (!pass) {
          pass = encoder.beginComputePass({ label: 'particle motion + lifecycle' });
          pass.setPipeline(motionPipeline);
        }
        for (let i = 0; i < s.pending.length; i++) {
          pass.setBindGroup(0, s.motionGroup, [i * controlStride]);
          pass.dispatchWorkgroups(Math.ceil(s.count / 64));
          if (s.pending[i][3]) {
            s.steps++;
            metadata.simulationSteps++;
          }
          count++;
        }
        s.pending.length = 0;
      }
      if (pass) pass.end();
      return count;
    }
    function draw(pass, drift, fade, viewportW, viewportH, drawOptions = {}) {
      if (disposed || !atlas || fade <= 0.003 || !(viewportW > 0 && viewportH > 0)) return 0;
      const s = getSlot(drift, drawOptions.key || drift);
      metadata.instances = s.count;
      if (!s.count) return 0;
      const view = s.viewData;
      view[0] = viewportW;
      view[1] = viewportH;
      view[2] = drawOptions.offsetX || 0;
      view[3] = drawOptions.offsetY || 0;
      view[4] = fade;
      device.queue.writeBuffer(s.uniform, 0, view);
      metadata.viewUploadBytes += 32;
      if (!s.bindGroup)
        s.bindGroup = device.createBindGroup({
          layout: renderLayout,
          entries: [
            { binding: 0, resource: { buffer: s.uniform } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: atlasView },
            { binding: 3, resource: { buffer: s.buffer } },
            { binding: 4, resource: { buffer: spriteBuffer } },
          ],
        });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, s.bindGroup);
      pass.draw(6, s.count);
      return s.count;
    }
    function restoreCPU() {
      let count = 0;
      for (const s of slots.values()) {
        const drift = s.drift,
          r = drift.o.region ? drift.o.region() : { x0: 0, x1: drift.w, y0: 0, y1: drift.h },
          blend = s.last?.blend || { D: 0, t: 0, F: 0.65, J: 0.5, L: 0.61 };
        const initial = new Uint32Array(particleInitialState(s.seeds));
        let active = false,
          best = null,
          bestWeight = 0;
        for (let i = 0; i < drift.ps.length; i++) {
          const p = drift.ps[i],
            source = s.seeds[i],
            random = { value: (initial[i * 20 + 19] ^ Math.imul(s.steps, 0x9e3779b9)) >>> 0 };
          Object.assign(p, source);
          p.x = r.x0 + particleRandom(random) * (r.x1 - r.x0) * 1.1;
          p.y = r.y0 + particleRandom(random) * (r.y1 - r.y0);
          const xf = Math.max(0, Math.min(1, (p.x - r.x0) / Math.max(0.000001, r.x1 - r.x0)));
          const weight = particleWeight(p.kind, xf, blend);
          p.dormant = particleRandom(random) > weight;
          p.retry = particleRandom(random) * 1.5;
          p.life = 10;
          count++;
          active ||= !p.dormant;
          if (weight > bestWeight) {
            best = p;
            bestWeight = weight;
          }
        }
        if (!active && best) best.dormant = false;
        s.pending.length = 0;
      }
      metadata.fallbackResets++;
      metadata.fallbackState = 'deterministic-reseed-current-region; trajectory-discontinuous';
      return count;
    }
    function reset(drift, resetOptions = {}) {
      if (disposed) return;
      getSlot(drift, resetOptions.key || drift, true);
    }
    function debugState(drift, key = drift) {
      if (!options.debug) throw Error('Particle state inspection requires debug:true');
      if (disposed) throw Error('Particle renderer was disposed');
      const s = getSlot(drift, key);
      return { buffer: s.buffer, count: s.count, stride: GPU_PARTICLE_STATE_BYTES };
    }
    function debugSnapshot() {
      return {
        metadata: { ...metadata },
        slots: [...slots.entries()].map(([key, s]) => ({
          key: typeof key === 'string' ? key : 'drift',
          count: s.count,
          capacity: s.capacity,
          width: s.width,
          height: s.height,
          pendingSteps: s.pending.length,
          steps: s.steps,
          ...(options.debug ? { stateBuffer: s.buffer } : {}),
        })),
      };
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      atlas?.destroy();
      spriteBuffer?.destroy();
      atlas = null;
      spriteBuffer = null;
      for (const s of slots.values()) destroySlot(s);
      slots.clear();
      metadata.atlasBytes = 0;
      recount();
    }
    return {
      step,
      encode,
      draw,
      reset,
      restoreCPU,
      debugState,
      debugSnapshot,
      dispose,
      metadata,
      async prepareGPU(helpers) {
        return creationValidation(() =>
          prepareParticleAtlasGPU(device, helpers, { checkedModule, packed, install, blend, metadata, batch }),
        );
      },
    };
  });
}

async function particleValidationScope(device, operation) {
  device.pushErrorScope('validation');
  let result, failure;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  const validation = await device.popErrorScope();
  if (failure) throw failure;
  if (validation) throw Error('WebGPU particle validation: ' + validation.message);
  return result;
}

function recordParticlePaths() {
  let matrix = [1, 0, 0, 1, 0, 0],
    stack = [],
    path = [],
    current = null;
  const calls = [];
  function point(x, y) {
    return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  }
  function append(p) {
    if (!current) {
      current = [];
      path.push(current);
    }
    current.push(p);
  }
  function colour(css) {
    const match = String(css).match(/^rgba?\(([^)]+)\)$/);
    if (!match) throw Error('Unsupported particle colour: ' + css);
    const c = match[1].split(',').map(Number);
    return [c[0] / 255, c[1] / 255, c[2] / 255, c.length > 3 ? c[3] : 1];
  }
  function paint(style) {
    if (typeof style === 'string') {
      const c = colour(style);
      return { start: 0, end: 1, stops: [0, 0.5, 1], colours: [c, c, c] };
    }
    const stops = style.stops;
    if (stops.length === 2)
      stops.splice(1, 0, [(stops[0][0] + stops[1][0]) * 0.5, stops[0][1].map((v, i) => (v + stops[1][1][i]) * 0.5)]);
    if (stops.length !== 3 || style.y0 !== style.y1)
      throw Error('Particle recorder supports three-stop horizontal gradients');
    return { start: style.x0, end: style.x1, stops: stops.map(s => s[0]), colours: stops.map(s => s[1]) };
  }
  function positive(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - p[1] * q[0];
    }
    return a < 0 ? poly.reverse() : poly;
  }
  const ctx = {
    fillStyle: 'rgba(0,0,0,1)',
    strokeStyle: 'rgba(0,0,0,1)',
    lineWidth: 1,
    beginPath() {
      path = [];
      current = null;
    },
    moveTo(x, y) {
      current = [point(x, y)];
      path.push(current);
    },
    lineTo(x, y) {
      append(point(x, y));
    },
    closePath() {
      if (!current || !current.length) return;
      current.closed = true;
      if (current[0][0] !== current.at(-1)[0] || current[0][1] !== current.at(-1)[1]) current.push(current[0].slice());
    },
    quadraticCurveTo(cx, cy, x, y) {
      const p = current.at(-1),
        c = point(cx, cy),
        q = point(x, y);
      const n = Math.max(
        4,
        Math.ceil((Math.hypot(c[0] - p[0], c[1] - p[1]) + Math.hypot(q[0] - c[0], q[1] - c[1])) / 0.4),
      );
      for (let i = 1; i <= n; i++) {
        const t = i / n,
          u = 1 - t;
        append([u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]]);
      }
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      const p = current.at(-1),
        a = point(c1x, c1y),
        b = point(c2x, c2y),
        q = point(x, y);
      const n = Math.max(
        6,
        Math.ceil(
          (Math.hypot(a[0] - p[0], a[1] - p[1]) +
            Math.hypot(b[0] - a[0], b[1] - a[1]) +
            Math.hypot(q[0] - b[0], q[1] - b[1])) /
            0.4,
        ),
      );
      for (let i = 1; i <= n; i++) {
        const t = i / n,
          u = 1 - t;
        append([
          u ** 3 * p[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t ** 3 * q[0],
          u ** 3 * p[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t ** 3 * q[1],
        ]);
      }
    },
    save() {
      stack.push(matrix.slice());
    },
    restore() {
      matrix = stack.pop();
    },
    translate(x, y) {
      matrix[4] += matrix[0] * x + matrix[2] * y;
      matrix[5] += matrix[1] * x + matrix[3] * y;
    },
    scale(x, y) {
      matrix[0] *= x;
      matrix[1] *= x;
      matrix[2] *= y;
      matrix[3] *= y;
    },
    createLinearGradient(x0, y0, x1, y1) {
      return {
        x0,
        y0,
        x1,
        y1,
        stops: [],
        addColorStop(t, css) {
          this.stops.push([t, colour(css)]);
        },
      };
    },
    fill() {
      calls.push({ polygons: path.map(p => p.map(v => v.slice())), paint: paint(this.fillStyle) });
    },
    stroke() {
      const polygons = [],
        r = this.lineWidth * 0.5;
      for (const raw of path) {
        const p = raw.filter((q, i) => !i || q[0] !== raw[i - 1][0] || q[1] !== raw[i - 1][1]);
        const closed = !!raw.closed;
        if (closed) p.pop();
        const segments = closed ? p.length : p.length - 1,
          normals = [];
        for (let i = 0; i < segments; i++) {
          const a = p[i],
            b = p[(i + 1) % p.length],
            l = Math.hypot(b[0] - a[0], b[1] - a[1]),
            n = [(-(b[1] - a[1]) / l) * r, ((b[0] - a[0]) / l) * r];
          normals.push(n);
          polygons.push(
            positive([
              [a[0] + n[0], a[1] + n[1]],
              [a[0] - n[0], a[1] - n[1]],
              [b[0] - n[0], b[1] - n[1]],
              [b[0] + n[0], b[1] + n[1]],
            ]),
          );
        }
        for (let i = closed ? 0 : 1; i < (closed ? p.length : p.length - 1); i++) {
          const a = normals[(i + normals.length - 1) % normals.length],
            b = normals[i],
            q = p[i],
            den = r * r + a[0] * b[0] + a[1] * b[1];
          for (const sign of [-1, 1]) {
            const outer0 = [q[0] + a[0] * sign, q[1] + a[1] * sign],
              outer1 = [q[0] + b[0] * sign, q[1] + b[1] * sign];
            let m = den > 1e-8 ? [((a[0] + b[0]) * r * r) / den, ((a[1] + b[1]) * r * r) / den] : [0, 0];
            if (Math.hypot(...m) > r * 10) m = [0, 0];
            polygons.push(positive([outer0, [q[0] + m[0] * sign, q[1] + m[1] * sign], outer1, q.slice()]));
          }
        }
      }
      calls.push({ polygons, paint: paint(this.strokeStyle) });
    },
  };
  return { ctx, calls };
}

function brushLeafParticle(ctx, x, y, len, wid, bend, side) {
  const N = 28,
    up = [],
    lo = [],
    mid = [],
    ink = a => 'rgba(21,31,25,' + a.toFixed(3) + ')';
  for (let i = 0; i <= N; i++) {
    const s = i / N,
      cx = s * len,
      cy = bend * len * s * s,
      dy = 2 * bend * len * s,
      dl = Math.hypot(len, dy),
      nx = -dy / dl,
      ny = len / dl;
    const h = wid * (s < 0.2 ? Math.pow(s / 0.2, 0.45) : Math.pow((1 - s) / 0.8, 1.25));
    up.push([x + cx + nx * h * 1.06, y + cy + ny * h * 1.06]);
    lo.push([x + cx - nx * h * 0.94, y + cy - ny * h * 0.94]);
    mid.push([x + cx, y + cy]);
  }
  const shape = (a, b) => {
    ctx.beginPath();
    a.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    for (let i = N; i >= 0; i--) ctx.lineTo(b[i][0], b[i][1]);
    ctx.closePath();
  };
  const wash = (a0, a1, a2) => {
    const g = ctx.createLinearGradient(x, y, x + len, y);
    g.addColorStop(0, ink(a0));
    g.addColorStop(0.45, ink(a1));
    g.addColorStop(1, ink(a2));
    return g;
  };
  shape(up, lo);
  ctx.fillStyle = wash(0.62, 0.54, 0.44);
  ctx.fill();
  shape(side > 0 ? up : mid, side > 0 ? mid : lo);
  ctx.fillStyle = wash(0.1, 0.08, 0.04);
  ctx.fill();
  shape(up, lo);
  ctx.strokeStyle = wash(0.24, 0.14, 0);
  ctx.lineWidth = 2.2;
  ctx.stroke();
}

async function prepareParticleAtlasGPU(device, helpers, internal) {
  const { rng, rr, inkLeaf, petalPath } = helpers;
  if (![rng, rr, inkLeaf, petalPath].every(x => typeof x === 'function'))
    throw Error('GPU particle atlas needs rng, rr, inkLeaf and petalPath');
  const { checkedModule, packed, install, blend, metadata } = internal;
  const U = GPUBufferUsage,
    T = GPUTextureUsage;
  const input = { leaf: [[], [], []], petal: [[], [], []] };
  for (let v = 0; v < 4; v++) {
    const random = rng(700 + v * 13),
      L = 150,
      Wd = L * rr(random, 0.075, 0.095),
      bend = rr(random, -0.07, 0.07),
      asym = rr(random, -0.2, 0.2);
    for (let b = 0; b < 3; b++) {
      const blur = [0, 5, 11][b],
        pad = 6 + blur * 2.6,
        width = Math.round(L + pad * 2),
        height = Math.round(Wd * 2 + 18 + pad * 2),
        recorder = recordParticlePaths();
      brushLeafParticle(recorder.ctx, pad, height / 2, L, Wd, bend, asym < 0 ? -1 : 1);
      input.leaf[b][v] = {
        c: { width, height },
        len: L,
        ax: pad + L * 0.5,
        ay: height / 2,
        calls: recorder.calls,
        blur,
      };
    }
    const S = 2,
      R = 28 * S;
    for (let b = 0; b < 3; b++) {
      const blur = [0, 3.5, 8][b] * S,
        pad = 5 * S + blur * 2.6,
        width = Math.round(R + pad * 2),
        height = Math.round(R * 1.1 + pad * 2),
        recorder = recordParticlePaths(),
        x = recorder.ctx,
        oy = height / 2;
      x.save();
      x.translate(pad, oy);
      x.scale(1, rr(random, 0.86, 1.08));
      x.beginPath();
      petalPath(x, R);
      x.restore();
      const gradient = x.createLinearGradient(pad, oy, pad + R, oy);
      gradient.addColorStop(0, 'rgba(221,131,156,0.660)');
      gradient.addColorStop(0.4, 'rgba(241,186,201,0.580)');
      gradient.addColorStop(1, 'rgba(251,229,234,0.800)');
      x.fillStyle = gradient;
      x.fill();
      input.petal[b][v] = { c: { width, height }, len: R, ax: pad + R * 0.5, ay: oy, calls: recorder.calls, blur };
    }
  }
  const pack = packed(input),
    resources = [],
    own = r => (resources.push(r), r);
  const shader = await checkedModule(
    'particle atlas paths',
    `
struct Paint { view: vec4f, colour0: vec4f, colour1: vec4f, colour2: vec4f, stops: vec4f }
@group(0) @binding(0) var<uniform> paint: Paint;
struct Out { @builtin(position) position: vec4f, @location(0) pixel: vec2f }
@vertex fn vertexMain(@location(0) p: vec2f) -> Out { var out: Out; out.position = vec4f(p.x / paint.view.x * 2.0 - 1.0, 1.0 - p.y / paint.view.y * 2.0, 0, 1); out.pixel = p; return out; }
@fragment fn fragmentMain(in: Out) -> @location(0) vec4f {
  let t = clamp((in.pixel.x - paint.view.z) / max(0.0001, paint.view.w - paint.view.z), 0.0, 1.0);
  var c: vec4f;
  if (t <= paint.stops.y) { c = mix(paint.colour0, paint.colour1, clamp((t - paint.stops.x) / max(0.0001, paint.stops.y - paint.stops.x), 0.0, 1.0)); }
  else { c = mix(paint.colour1, paint.colour2, clamp((t - paint.stops.y) / max(0.0001, paint.stops.z - paint.stops.y), 0.0, 1.0)); }
  return vec4f(c.rgb * c.a, c.a);
}`,
  );
  const vertex = {
    module: shader,
    entryPoint: 'vertexMain',
    buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
  };
  const base = {
    layout: 'auto',
    vertex,
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    multisample: { count: 4 },
  };
  const [stencilPipeline, fillPipeline] = await internal.batch([
    device.createRenderPipelineAsync({
      ...base,
      label: 'particle path winding',
      fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm', writeMask: 0 }] },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
        stencilFront: { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'increment-wrap' },
        stencilBack: { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'decrement-wrap' },
        stencilReadMask: 255,
        stencilWriteMask: 255,
      },
    }),
    device.createRenderPipelineAsync({
      ...base,
      label: 'particle path colour',
      fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm', blend }] },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'always',
        stencilFront: { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'zero' },
        stencilBack: { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'zero' },
        stencilReadMask: 255,
        stencilWriteMask: 255,
      },
    }),
  ]);
  async function blurPipeline(format) {
    const module = await checkedModule(
      'particle box blur ' + format,
      `
struct Params { origins: vec4u, extentAxis: vec4u, kernel: vec4u }
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var imageOutput: texture_storage_2d<${format},write>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.extentAxis.xy)) { return; }
  let r = i32(params.kernel.x); var sum = vec4f(0); let axis = vec2i(params.extentAxis.zw);
  for (var d = -r; d <= r; d = d + 1) { let p = clamp(vec2i(id.xy) + axis * d, vec2i(0), vec2i(params.extentAxis.xy) - vec2i(1)); sum = sum + textureLoad(source, vec2i(params.origins.xy) + p, 0); }
  textureStore(imageOutput, vec2i(params.origins.zw + id.xy), sum / f32(r * 2 + 1));
}`,
    );
    return device.createComputePipelineAsync({
      label: 'particle three-box blur ' + format,
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }
  const [blur16, blur8] = await internal.batch([blurPipeline('rgba16float'), blurPipeline('rgba8unorm')]);
  let output;
  try {
    const size = [pack.width, pack.height],
      baseAtlas = own(
        device.createTexture({
          label: 'particle atlas unblurred',
          size,
          format: 'rgba8unorm',
          usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING | T.COPY_SRC,
        }),
      );
    const msaa = own(
      device.createTexture({
        label: 'particle atlas 4x AA',
        size,
        format: 'rgba8unorm',
        sampleCount: 4,
        usage: T.RENDER_ATTACHMENT,
      }),
    );
    const stencil = own(
      device.createTexture({
        label: 'particle atlas winding stencil',
        size,
        format: 'depth24plus-stencil8',
        sampleCount: 4,
        usage: T.RENDER_ATTACHMENT,
      }),
    );
    output = device.createTexture({
      label: 'particle atlas GPU baked',
      size,
      format: 'rgba8unorm',
      usage: T.TEXTURE_BINDING | T.STORAGE_BINDING | T.COPY_DST | T.COPY_SRC,
    });
    const maxW = Math.max(...pack.items.map(s => s.w)),
      maxH = Math.max(...pack.items.map(s => s.h));
    const temporary = [0, 1].map(i =>
      own(
        device.createTexture({
          label: 'particle blur float ' + i,
          size: [maxW, maxH],
          format: 'rgba16float',
          usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
        }),
      ),
    );
    metadata.bakePeakBytes = pack.width * pack.height * (4 + 4 + 16 + 16) + maxW * maxH * 16;
    const encoder = device.createCommandEncoder({ label: 'GPU particle atlas bake' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: msaa.createView(),
          resolveTarget: baseAtlas.createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: [0, 0, 0, 0],
        },
      ],
      depthStencilAttachment: {
        view: stencil.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
        stencilClearValue: 0,
      },
    });
    pass.setStencilReference(0);
    for (const s of pack.items) {
      pass.setScissorRect(s.x, s.y, s.w, s.h);
      for (const call of s.calls) {
        const vertices = [];
        for (const polygon of call.polygons)
          for (let j = 1; j < polygon.length - 1; j++)
            for (const p of [polygon[0], polygon[j], polygon[j + 1]]) vertices.push(p[0] + s.x, p[1] + s.y);
        if (!vertices.length) continue;
        const shapeCount = vertices.length / 2;
        vertices.push(s.x, s.y, s.x + s.w, s.y, s.x, s.y + s.h, s.x, s.y + s.h, s.x + s.w, s.y, s.x + s.w, s.y + s.h);
        const vb = own(
          device.createBuffer({
            label: 'particle bake vertices',
            size: vertices.length * 4,
            usage: U.VERTEX | U.COPY_DST,
          }),
        );
        device.queue.writeBuffer(vb, 0, new Float32Array(vertices));
        const p = call.paint,
          data = new Float32Array([
            pack.width,
            pack.height,
            p.start + s.x,
            p.end + s.x,
            ...p.colours[0],
            ...p.colours[1],
            ...p.colours[2],
            ...p.stops,
            0,
          ]);
        const ub = own(device.createBuffer({ label: 'particle bake paint', size: 80, usage: U.UNIFORM | U.COPY_DST }));
        device.queue.writeBuffer(ub, 0, data);
        const bindStencil = device.createBindGroup({
          layout: stencilPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: ub } }],
        });
        const bindFill = device.createBindGroup({
          layout: fillPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: ub } }],
        });
        pass.setVertexBuffer(0, vb);
        pass.setPipeline(stencilPipeline);
        pass.setBindGroup(0, bindStencil);
        pass.draw(shapeCount);
        pass.setPipeline(fillPipeline);
        pass.setBindGroup(0, bindFill);
        pass.draw(6, 1, shapeCount);
      }
    }
    pass.end();
    function radii(sigma) {
      const ideal = Math.sqrt(4 * sigma * sigma + 1);
      let low = Math.floor(ideal);
      if (low % 2 === 0) low--;
      const high = low + 2,
        m = Math.round((12 * sigma * sigma - 3 * low * low - 12 * low - 9) / (-4 * low - 4));
      return [0, 1, 2].map(i => Math.max(0, ((i < m ? low : high) - 1) >> 1));
    }
    for (const s of pack.items) {
      if (!s.blur) {
        encoder.copyTextureToTexture(
          { texture: baseAtlas, origin: [s.x, s.y] },
          { texture: output, origin: [s.x, s.y] },
          [s.w, s.h],
        );
        continue;
      }
      const radius = radii(s.blur);
      for (let i = 0; i < 6; i++) {
        const first = i === 0,
          last = i === 5,
          source = first ? baseAtlas : temporary[(i - 1) % 2],
          target = last ? output : temporary[i % 2],
          pipeline = last ? blur8 : blur16;
        const params = new Uint32Array([
          first ? s.x : 0,
          first ? s.y : 0,
          last ? s.x : 0,
          last ? s.y : 0,
          s.w,
          s.h,
          i % 2 === 0 ? 1 : 0,
          i % 2 === 1 ? 1 : 0,
          radius[i >> 1],
          0,
          0,
          0,
        ]);
        const ub = own(device.createBuffer({ label: 'particle blur params', size: 48, usage: U.UNIFORM | U.COPY_DST }));
        device.queue.writeBuffer(ub, 0, params);
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source.createView() },
            { binding: 1, resource: target.createView() },
            { binding: 2, resource: { buffer: ub } },
          ],
        });
        const compute = encoder.beginComputePass({ label: 'particle blur ' + i });
        compute.setPipeline(pipeline);
        compute.setBindGroup(0, group);
        compute.dispatchWorkgroups(Math.ceil(s.w / 8), Math.ceil(s.h / 8));
        compute.end();
      }
    }
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    for (const s of pack.items) delete s.calls;
    const result = install(output, pack, 'gpu-paths-4x-aa-three-box-blur');
    output = null;
    return result;
  } finally {
    for (const resource of resources) resource.destroy();
    if (output) output.destroy();
  }
}
