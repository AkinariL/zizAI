(() => {
  const proto = globalThis.GPUTexture && GPUTexture.prototype,
    key = Symbol.for('zz.defaultView');
  if (!proto || proto.createView.zzCached) return;
  const createView = proto.createView;
  proto.createView = function (descriptor) {
    if (descriptor !== undefined) return GPU_HOLD.keep(createView.call(this, descriptor));
    return this[key] || (this[key] = createView.call(this));
  };
  proto.createView.zzCached = true;
})();
const GPU_HOLD = (() => {
  const LIMIT = 24000,
    MIN_COUNT = 2000,
    MIN_GAP = 4000,
    QUIET = 100,
    STILL = 0.002;
  const held = [],
    stats = { enabled: false, held: 0, peak: 0, releases: 0, limit: 0, idle: 0, log: [] };
  let on = false,
    watching = false,
    quietSince = 0,
    lastRelease = 0,
    lastFrame = 0,
    lastPosition = NaN;
  const keep = (proto, name) => {
    const original = proto && proto[name];
    if (typeof original !== 'function' || original.zzHeld) return;
    const wrapped = function (descriptor) {
      const made = original.call(this, descriptor);
      if (on) held.push(made);
      return made;
    };
    wrapped.zzHeld = true;
    proto[name] = wrapped;
  };
  if (globalThis.GPUDevice && globalThis.GPUCommandEncoder && globalThis.GPUCanvasContext) {
    keep(GPUDevice.prototype, 'createCommandEncoder');
    keep(GPUDevice.prototype, 'createBindGroup');
    keep(GPUCommandEncoder.prototype, 'beginRenderPass');
    keep(GPUCommandEncoder.prototype, 'beginComputePass');
    keep(GPUCommandEncoder.prototype, 'finish');
    keep(GPUCanvasContext.prototype, 'getCurrentTexture');
  }
  const release = (now, reason) => {
    const count = held.length;
    held.length = 0;
    lastRelease = now;
    stats.releases++;
    if (reason !== 'still') stats[reason]++;
    if (stats.log.length >= 12) stats.log.shift();
    stats.log.push([Math.round(performance.timeOrigin + now), count, reason]);
    setTimeout(() => {
      try {
        new ArrayBuffer(80 << 20);
      } catch (error) {}
    }, 0);
  };
  return {
    stats,
    keep(object) {
      if (on) held.push(object);
      return object;
    },
    frame(now, position) {
      if (!watching) {
        watching = true;
        const flag = typeof param === 'function' ? param('gpuhold') : null;
        on = stats.enabled = flag !== '0';
        if (on)
          setInterval(() => {
            const t = performance.now();
            if (held.length && t - lastFrame > 500) release(t, 'idle');
          }, 1000);
      }
      if (!on) return;
      const still = Math.abs(position - lastPosition) * 1000 <= STILL * (now - lastFrame);
      lastFrame = now;
      lastPosition = position;
      if (!still) quietSince = 0;
      else if (!quietSince) quietSince = now;
      const count = (stats.held = held.length);
      if (count > stats.peak) stats.peak = count;
      if (count >= LIMIT) release(now, 'limit');
      else if (count >= MIN_COUNT && quietSince && now - quietSince >= QUIET && now - lastRelease >= MIN_GAP)
        release(now, 'still');
    },
  };
})();
const GPU_UPLOAD = { samples: 0, slow: 0, worker: false, mode: 'mesh' };
const GPU_DIAG = {
  upload: GPU_UPLOAD,
  requested: true,
  state: 'initializing',
  adapter: '',
  error: '',
  timings: {},
  samples: [],
  bytes: {},
  stage: 2,
};
function gpuSourceTileScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0.5 && scale <= 1 ? scale : 1;
}
function createGPUTileSubmissionGate(queue, onError, limit = 2, submitEncoder = null) {
  const stats = { limit, pending: 0, peak: 0, submitted: 0, emptySkipped: 0, blockedFrames: 0 };
  let stopped = false;
  return {
    stats,
    get ready() {
      return !stopped && stats.pending < stats.limit;
    },
    setLimit(next) {
      if (!Number.isSafeInteger(next) || next < 1) throw Error('Invalid tile submission limit');
      stats.limit = next;
    },
    submit(encoder, hasCommands) {
      if (!hasCommands) {
        stats.emptySkipped++;
        return false;
      }
      if (stopped || stats.pending >= stats.limit) throw Error('Tile submission exceeds bounded queue');
      if (submitEncoder) submitEncoder(encoder);
      else queue.submit([encoder.finish()]);
      stats.pending++;
      stats.submitted++;
      stats.peak = Math.max(stats.peak, stats.pending);
      Promise.resolve(queue.onSubmittedWorkDone()).then(
        () => {
          stats.pending--;
        },
        error => {
          stats.pending--;
          if (!stopped) onError(error);
        },
      );
      return true;
    },
    stop() {
      stopped = true;
    },
  };
}
function createGPUTileBacklogPolicy() {
  const levels = [
    { submissionLimit: 2, planningLimit: 2, rounds: 1, cpuMs: 0.65, frameCPUms: 0.65 },
    { submissionLimit: 4, planningLimit: 3, rounds: 2, cpuMs: 1.2, frameCPUms: 2.4 },
    { submissionLimit: 6, planningLimit: 4, rounds: 3, cpuMs: 1.5, frameCPUms: 4.5 },
    { submissionLimit: 8, planningLimit: 6, rounds: 4, cpuMs: 2, frameCPUms: 6 },
  ];
  const metadata = {
    level: 0,
    ...levels[0],
    visibleMissing: 0,
    wantedMissing: 0,
    visibleAgeMs: 0,
    raised: 0,
    lowered: 0,
    peakLevel: 0,
    peakVisibleMissing: 0,
    batches: 0,
    roundsRun: 0,
    peakPlayPending: 0,
  };
  let visibleSince = null,
    quietSince = null;
  function setLevel(level) {
    if (level === metadata.level) return;
    if (level > metadata.level) metadata.raised++;
    else metadata.lowered++;
    metadata.level = level;
    metadata.peakLevel = Math.max(metadata.peakLevel, level);
    Object.assign(metadata, levels[level]);
  }
  return {
    metadata,
    reset() {
      visibleSince = quietSince = null;
      metadata.visibleAgeMs = 0;
      setLevel(0);
    },
    update(at, visibleMissing, wantedMissing) {
      metadata.visibleMissing = visibleMissing;
      metadata.wantedMissing = wantedMissing;
      metadata.peakVisibleMissing = Math.max(metadata.peakVisibleMissing, visibleMissing);
      if (visibleMissing > 0) {
        if (visibleSince === null) visibleSince = at;
        quietSince = null;
        const age = at - visibleSince;
        metadata.visibleAgeMs = age;
        setLevel(
          Math.max(metadata.level, age >= 750 || visibleMissing >= 4 ? 3 : age >= 200 || visibleMissing >= 2 ? 2 : 1),
        );
      } else {
        visibleSince = null;
        metadata.visibleAgeMs = 0;
        if (wantedMissing >= 2) {
          quietSince = null;
          setLevel(Math.max(metadata.level, 1));
        } else if (wantedMissing > 0) {
          quietSince = null;
        } else if (quietSince === null) quietSince = at;
        else if (at - quietSince >= 400) {
          setLevel(Math.max(0, metadata.level - 1));
          quietSince = at;
        }
      }
      return metadata;
    },
  };
}
const GPU_SAMPLERS = ['uZ0', 'uZ1', 'uZ2', 'uZ3', 'uJ0', 'uJ1', 'uJ2', 'uJ3', 'uMtn', 'uPN'];
const GPU_FIELDS = [
  'uAsp',
  'uDpr',
  'uTime',
  'uT',
  'uD',
  'uVeil',
  'uSway',
  'uSc',
  'uOf',
  'uY0',
  'uY1',
  'uN1',
  'uN3',
  'uLag',
  'uMS',
  'uMO',
  'uMY',
  'uMouse',
  'uMark',
  'uRead',
  'uMsk',
  'uMistZ',
  'uMistJ',
  'uWashZ',
  'uWashJ',
  'uSkyZ0',
  'uSkyZ1',
  'uSkyZ2',
  'uSkyJ0',
  'uSkyJ1',
  'uSkyJ2',
  'uMtZA',
  'uMtZB',
  'uMtJA',
  'uMtJB',
  'uSize',
];
const GPU_HEADER = `struct Uniforms { ${GPU_FIELDS.map(k => k + ': vec4f,').join('\n')} };
@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var linearClamp: sampler;
@group(0) @binding(2) var linearRepeat: sampler;
${GPU_SAMPLERS.map((k, i) => '@group(0) @binding(' + (i + 3) + ') var ' + k + ': texture_2d<f32>;').join('\n')}
struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vert(@builtin(vertex_index) i:u32) -> VertexOut {
  let p = array<vec2f,3>(vec2f(0.,0.),vec2f(2.,0.),vec2f(0.,2.));
  var o:VertexOut; o.uv=p[i]; o.pos=vec4f(p[i]*vec2f(2.,-2.)+vec2f(-1.,1.),0.,1.); return o;
}
fn ramp(a:f32,b:f32,x:f32)->f32 { let q=clamp((x-a)/(b-a),0.,1.); return q*q*(3.-2.*q); }
fn tap(s:texture_2d<f32>,u:f32,t:f32)->vec4f { if(t<0.||t>1.){return vec4f(0.);} return textureSampleLevel(s,linearClamp,vec2f(u,1.-t),0.); }
fn noise(p:vec2f)->vec4f { return textureSampleLevel(uPN,linearRepeat,p,0.); }
fn pointerShift()->vec2f { return vec2f(U.uMouse.x/max(U.uAsp.x,1.),-U.uMouse.y*min(U.uAsp.x,1.)*.7); }
fn band(y:f32,c:f32,h:f32)->f32 { let d=(y-c)/h; return exp(-d*d); }
fn wn(v:vec2f,o1:f32,o3:f32,yo:f32)->f32 {
 let xa=v.x*U.uAsp.x; let yt=1.-v.y;
 return noise(vec2f(xa*.5+o1,yt*.5+yo)).g*.62+noise(vec2f(xa*1.5+o3,yt*1.5+yo)).b*.38;
}
fn mask(x:f32,n:f32,lag:f32)->f32 {
 let F=U.uMsk.x; let J=U.uMsk.y; let L=U.uMsk.z;
 let e=1.+.5*F+.5*J+L-U.uT.x*(1.+F+J+2.*L)+lag;
 return ramp(e-.5*F,e+.5*F,x+(n-.5)*J);
}
fn xfade(a:vec4f,b:vec4f,j:f32)->vec4f {
 let wb=mix(j,ramp(.3,1.,j),U.uMsk.w); let wa=mix(1.-j,ramp(.3,1.,1.-j),U.uMsk.w); return a*wa+b*wb;
}
fn grove(a:texture_2d<f32>,b:texture_2d<f32>,u:f32,t:f32,j:f32,dip:bool)->vec4f {
 if(j<.002){return tap(a,u,t);} if(j>.998){return tap(b,u,t);}
 if(dip){return xfade(tap(a,u,t),tap(b,u,t),j);} return mix(tap(a,u,t),tap(b,u,t),j);
}
`;
const GPU_PAPER_FUNCTIONS = `
fn paperSky(x:f32,yt:f32,j0:f32,mx:f32)->vec3f {
 var sz=mix(U.uSkyZ0.rgb,U.uSkyZ1.rgb,ramp(0.,.58,yt));sz=mix(sz,U.uSkyZ2.rgb,ramp(.66,1.,yt));
 var sj=mix(U.uSkyJ0.rgb,U.uSkyJ1.rgb,ramp(0.,.58,yt));sj=mix(sj,U.uSkyJ2.rgb,ramp(.66,1.,yt));
 var col=mix(sz,sj,j0);let tm=(yt-U.uMY.x)/(U.uMY.y-U.uMY.x);
 if(tm>0.&&tm<1.){
  let a=textureSampleLevel(uMtn,linearClamp,vec2f(fract((x+mx*.001)*U.uMS.x+U.uMO.x),1.-tm),0.).r*.4;
  let b=textureSampleLevel(uMtn,linearClamp,vec2f(fract((x+mx*.002)*U.uMS.x+U.uMO.y),1.-tm),0.).g*.4;
  col=mix(col,mix(U.uMtZA.rgb,U.uMtJA.rgb,j0),a);col=mix(col,mix(U.uMtZB.rgb,U.uMtJB.rgb,j0),b);
 }return col;
}
fn paperFinish(colIn:vec3f,v:vec2f,mist:vec3f,grain:f32)->vec3f {
 let c=(v-.5)*vec2f(U.uAsp.x,1.);let cc=c*vec2f(.85,1.55);
 var col=mix(colIn,mist,exp(-dot(cc,cc)*3.)*.2);col=mix(col,mist,U.uVeil.x*.7);
 col*=.935+.13*grain;col*=mix(.9,1.,ramp(1.35,.45,length(c*vec2f(.8,1.))));return col;
}
`;
const GPU_TEXT_PAPER = (
  `struct PaperUniforms { ${GPU_FIELDS.map(k => k + ': vec4f,').join('\n')} };
@group(1) @binding(0) var<uniform> PaperU: PaperUniforms;
@group(1) @binding(1) var linearClamp:sampler;
@group(1) @binding(2) var linearRepeat:sampler;
@group(1) @binding(3) var uMtn:texture_2d<f32>;
@group(1) @binding(4) var uPN:texture_2d<f32>;
` +
  GPU_HEADER.slice(GPU_HEADER.indexOf('fn ramp(')) +
  GPU_PAPER_FUNCTIONS +
  `
fn textPaperAt(cssPosition:vec2f,viewportCss:vec2f,paperValue:f32)->vec3f {
 let q=cssPosition/viewportCss;let x=q.x;let yt=q.y;let v=vec2f(x,1.-yt);let xa=x*U.uAsp.x;let dr=U.uTime.x*.006;
 var j0=U.uD.x;var j1=j0;var j2=j0;var mz=0.;
 if(U.uT.x>.0005){
  let m0=mask(x,wn(v,U.uN1.x,U.uN3.x,0.),U.uLag.x);
  let m1=mask(x,wn(v,U.uN1.y,U.uN3.y,.31),U.uLag.y);
  let m2=mask(x,wn(v,U.uN1.z,U.uN3.z,.63),U.uLag.z);
  j0=mix(m0,1.-m0,U.uD.x);j1=mix(m1,1.-m1,U.uD.x);j2=mix(m2,1.-m2,U.uD.x);mz=m1;
 }
 var col=paperSky(x,yt,j0,0.);
 let mist0=mix(U.uMistZ.rgb,U.uMistJ.rgb,j0);let mist1=mix(U.uMistZ.rgb,U.uMistJ.rgb,j1);let mist2=mix(U.uMistZ.rgb,U.uMistJ.rgb,j2);
 col=mix(col,mist0,band(yt,.6,.1)*(.3+.42*noise(vec2f(xa*.5+U.uN1.x+dr,yt*1.7+.2)).g));
 col=mix(col,mist0,band(yt,.668,.05)*(.22+.38*noise(vec2f(xa*.5+U.uN1.x+dr*1.3,yt*2.2+.5)).g));
 col=mix(col,mist1,band(yt,.85,.065)*(.3+.42*noise(vec2f(xa*.5+U.uN1.y+dr*1.6,yt*2.4+.8)).g));
 let rn=noise(vec2f(xa*.35+dr*4.,yt*.9+.45)).g;
 let fog=1.-ramp(0.,1.,max(max(U.uRead.x-yt,0.)/.1,max(yt-U.uRead.y,0.)/.16)+(rn-.5)*.5);
 col=mix(col,mist2,ramp(.86,1.02,yt)*(.18+.3*noise(vec2f(xa*.5+U.uN1.z+dr*2.,yt*2.+.1)).g));col=mix(col,mist2,fog*.22);
 if(U.uT.x>.0005){let wIn=mix(U.uWashJ.rgb,U.uWashZ.rgb,U.uD.x);let zone=4.*mz*(1.-mz);col=mix(col,mix(mist1,wIn,.75),zone*.42);col=mix(col,wIn,ramp(0.,.35,mz)*(1.-ramp(.55,1.,mz))*.18);}
 return paperFinish(col,v,mist1,paperValue);
}`
).replace(/\bU\b/g, 'PaperU');
const GPU_BACKGROUND =
  GPU_HEADER +
  GPU_PAPER_FUNCTIONS +
  `
@fragment fn frag(o:VertexOut)->@location(0) vec4f {
 let v=vec2f(o.uv.x,1.-o.uv.y); let yt=o.uv.y;
 let x=v.x; let xa=x*U.uAsp.x; let mx=U.uMouse.x; let dr=U.uTime.x*.006;
 let par=pointerShift();
 var j0=U.uD.x; var j1=j0; var j2=j0; var j3=j0; var mz=0.;
 if(U.uT.x>.0005){
  let m0=mask(x,wn(v,U.uN1.x,U.uN3.x,0.),U.uLag.x);
  let m1=mask(x,wn(v,U.uN1.y,U.uN3.y,.31),U.uLag.y);
  let m2=mask(x,wn(v,U.uN1.z,U.uN3.z,.63),U.uLag.z);
  let m3=mask(x,wn(v,U.uN1.w,U.uN3.w,.87),U.uLag.w);
  j0=mix(m0,1.-m0,U.uD.x);j1=mix(m1,1.-m1,U.uD.x);j2=mix(m2,1.-m2,U.uD.x);j3=mix(m3,1.-m3,U.uD.x);mz=m1;
 }
 var col=paperSky(x,yt,j0,mx);
 let mist0=mix(U.uMistZ.rgb,U.uMistJ.rgb,j0); let mist1=mix(U.uMistZ.rgb,U.uMistJ.rgb,j1); let mist2=mix(U.uMistZ.rgb,U.uMistJ.rgb,j2);
 col=mix(col,mist0,band(yt,.6,.1)*(.3+.42*noise(vec2f(xa*.5+U.uN1.x+dr,yt*1.7+.2)).g));
 let t0=(yt+par.y*.004-U.uY0.x)/(U.uY1.x-U.uY0.x); let u0=fract((x+par.x*.004)*U.uSc.x+U.uOf.x);
 let c0=grove(uZ0,uJ0,u0,t0,j0,false); col=col*(1.-c0.a)+c0.rgb;
 col=mix(col,mist0,band(yt,.668,.05)*(.22+.38*noise(vec2f(xa*.5+U.uN1.x+dr*1.3,yt*2.2+.5)).g));
 let t1=(yt+par.y*.009-U.uY0.y)/(U.uY1.y-U.uY0.y); let u1=fract((x+par.x*.009)*U.uSc.y+U.uOf.y);
 let c1=grove(uZ1,uJ1,u1,t1,j1,false); col=col*(1.-c1.a)+c1.rgb;
 col=mix(col,mist1,band(yt,.85,.065)*(.3+.42*noise(vec2f(xa*.5+U.uN1.y+dr*1.6,yt*2.4+.8)).g));
 let rn=noise(vec2f(xa*.35+dr*4.,yt*.9+.45)).g;
 let fog=1.-ramp(0.,1.,max(max(U.uRead.x-yt,0.)/.1,max(yt-U.uRead.y,0.)/.16)+(rn-.5)*.5);
 let hs=pow(clamp((1.04-yt)/.72,0.,1.),1.5);
 let sw=(sin(U.uTime.x*.53+yt*2.1)*.65+sin(U.uTime.x*.97+1.3+yt*3.7)*.35)*U.uSway.x*hs*mix(1.,.4,j2);
 let t2=(yt+par.y*.017-U.uY0.z)/(U.uY1.z-U.uY0.z);let u2=fract((x+sw+par.x*.017)*U.uSc.z+U.uOf.z);
 let c2=grove(uZ2,uJ2,u2,t2,j2,true);col=col*(1.-c2.a)+c2.rgb;
 col=mix(col,mist2,ramp(.86,1.02,yt)*(.18+.3*noise(vec2f(xa*.5+U.uN1.z+dr*2.,yt*2.+.1)).g));
 col=mix(col,mist2,fog*.22);
 let hs3=ramp(1.02,.2,yt);
 let sw3=(sin(U.uTime.x*.47+yt*1.9+x*2.1)*.6+sin(U.uTime.x*.89+2.1+yt*3.1)*.4)*U.uSway.x*1.5*hs3*mix(1.,.55,j3);
 let t3=(yt+par.y*.032-U.uY0.w)/(U.uY1.w-U.uY0.w);let u3=fract((x+sw3+par.x*.032)*U.uSc.w+U.uOf.w);
 let c3=grove(uZ3,uJ3,u3,t3,j3,true); let keep=1.-fog*.8;
 col=col*(1.-c3.a*keep)+c3.rgb*keep;
 if(U.uT.x>.0005){
  let wIn=mix(U.uWashJ.rgb,U.uWashZ.rgb,U.uD.x);let zone=4.*mz*(1.-mz);
  col=mix(col,mix(mist1,wIn,.75),zone*.42);
  col=mix(col,wIn,ramp(0.,.35,mz)*(1.-ramp(.55,1.,mz))*.18);
 }
 let pap=noise(vec2f(o.pos.x,U.uSize.y-o.pos.y)/(512.*U.uDpr.x)).r;
 col=paperFinish(col,v,mist1,pap);
 return vec4f(col,1.);
}`;
const GPU_LAYER_FILTER = `
struct LayerFilter { size:vec4f, band:vec4f, enabled:vec4f };
@group(0) @binding(14) var<uniform> LayerAA:LayerFilter;
fn layerSpan(scale:f32,y0:f32,y1:f32)->vec2f {
 return vec2f(abs(scale)/LayerAA.size.x,(LayerAA.band.y-LayerAA.band.x)/(abs(y1-y0)*LayerAA.size.y));
}
fn layerTap(s:texture_2d<f32>,u:f32,t:f32,span:vec2f)->vec4f {
 if(LayerAA.enabled.x<.5||all(LayerAA.size.xy>=LayerAA.size.zw)){return tap(s,u,t);}
 let footprint=max(span*vec2f(textureDimensions(s)),vec2f(1.));
 let lod=min(log2(min(footprint.x,footprint.y)),f32(textureNumLevels(s)-1u));
 let grid=vec2u(clamp(ceil(footprint/exp2(lod)),vec2f(1.),vec2f(8.)));
 var colour=vec4f(0.);
 for(var iy=0u;iy<grid.y;iy++){
  for(var ix=0u;ix<grid.x;ix++){
   let d=(vec2f(f32(ix)+.5,f32(iy)+.5)/vec2f(grid)-.5)*span;
   let q=vec2f(fract(u+d.x),t+d.y);
   colour+=textureSampleLevel(s,linearClamp,vec2f(q.x,1.-q.y),lod)*step(0.,q.y)*step(q.y,1.);
  }
 }
 return colour/f32(grid.x*grid.y);
}
fn layerGrove(a:texture_2d<f32>,b:texture_2d<f32>,u:f32,t:f32,j:f32,span:vec2f)->vec4f {
 if(j<.002){return layerTap(a,u,t,span);}if(j>.998){return layerTap(b,u,t,span);}
 return mix(layerTap(a,u,t,span),layerTap(b,u,t,span),j);
}
`;
function gpuForestLayerShader(li) {
  const component = li === 0 ? 'x' : 'y',
    mouse = li === 0 ? '.004' : '.009',
    offset = li === 0 ? '0.' : '.31';
  return (
    GPU_HEADER +
    GPU_LAYER_FILTER +
    `
@fragment fn frag(o:VertexOut)->@location(0) vec4f {
 let yt=mix(LayerAA.band.x,LayerAA.band.y,o.uv.y);let v=vec2f(o.uv.x,1.-yt);let x=o.uv.x;
 var j=U.uD.x;
 if(U.uT.x>.0005){let m=mask(x,wn(v,U.uN1.${component},U.uN3.${component},${offset}),U.uLag.${component});j=mix(m,1.-m,U.uD.x);}
 let par=pointerShift();
 let t=(yt+par.y*${mouse}-U.uY0.${component})/(U.uY1.${component}-U.uY0.${component});
 let u=fract((x+par.x*${mouse})*U.uSc.${component}+U.uOf.${component});
 return layerGrove(uZ${li},uJ${li},u,t,j,layerSpan(U.uSc.${component},U.uY0.${component},U.uY1.${component}));
}`
  );
}
const GPU_BACKGROUND_FAR = gpuForestLayerShader(0);
const GPU_BACKGROUND_MID = gpuForestLayerShader(1);
const GPU_DEPTH_SAMPLE = `
@group(0) @binding(13) var uFar:texture_2d<f32>;
@group(0) @binding(14) var uMid:texture_2d<f32>;
struct NearDepth { farBand:vec4f, midBand:vec4f, farRect:vec4f, midRect:vec4f };
@group(0) @binding(15) var<uniform> Depth:NearDepth;
fn depthRegion(s:texture_2d<f32>,x:f32,y:f32,rect:vec4f)->vec4f {
 let inset=vec2f(.5)/vec2f(textureDimensions(s));
 let uv=clamp(rect.xy+vec2f(x,y)*rect.zw,rect.xy+inset,rect.xy+rect.zw-inset);
 return textureSampleLevel(s,linearClamp,uv,0.)*step(0.,y)*step(y,1.);
}
fn depthFar(u:f32,t:f32,j:f32,x:f32,yt:f32)->vec4f {
 if(Depth.farBand.z<.5){return grove(uZ0,uJ0,u,t,j,false);}
 let y=(yt-Depth.farBand.x)/(Depth.farBand.y-Depth.farBand.x);
 return depthRegion(uFar,x,y,Depth.farRect);
}
fn depthMid(u:f32,t:f32,j:f32,x:f32,yt:f32)->vec4f {
 if(Depth.midBand.z<.5){return grove(uZ1,uJ1,u,t,j,false);}
 let y=(yt-Depth.midBand.x)/(Depth.midBand.y-Depth.midBand.x);
 return depthRegion(uMid,x,y,Depth.midRect);
}
`;
const GPU_BACKGROUND_NEAR = (
  GPU_HEADER +
  GPU_DEPTH_SAMPLE +
  GPU_PAPER_FUNCTIONS +
  GPU_BACKGROUND.slice(GPU_BACKGROUND.indexOf('@fragment fn frag('))
)
  .replace('let c0=grove(uZ0,uJ0,u0,t0,j0,false);', 'let c0=depthFar(u0,t0,j0,x,yt);')
  .replace('let c1=grove(uZ1,uJ1,u1,t1,j1,false);', 'let c1=depthMid(u1,t1,j1,x,yt);');
function gpuBackgroundResolution(baseWidth, baseHeight, options = {}) {
  const ratio = (value, fallback, allowZero) => {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && ((allowZero && n === 0) || (n >= 0.25 && n <= 1)) ? n : fallback;
  };
  const farScale = ratio(options.farScale, 1, true),
    midScale = farScale ? ratio(options.midScale, 1, false) : 1,
    nearScale = 1;
  const nearRequest = options.nearScale,
    nearRequestNormalized =
      nearRequest !== null && nearRequest !== undefined && nearRequest !== '' && Number(nearRequest) !== 1;
  const nearWidth = Math.max(1, Math.round(baseWidth)),
    nearHeight = Math.max(1, Math.round(baseHeight));
  const band = (y0, y1) => {
    const start = Math.max(0, Math.min(nearHeight - 1, Math.floor(nearHeight * y0))),
      end = Math.max(start + 1, Math.min(nearHeight, Math.ceil(nearHeight * y1)));
    return {
      coverage: {
        worldY0: start / nearHeight,
        worldY1: end / nearHeight,
        worldSpan: (end - start) / nearHeight,
        sourceY0: y0,
        sourceY1: y1,
      },
      baseBounds: { x: 0, y: start, width: nearWidth, height: end - start, endY: end },
    };
  };
  const farBand = band(options.farY0 ?? 0.33, options.farY1 ?? 0.76),
    midBand = band(options.midY0 ?? 0.25, options.midY1 ?? 0.97);
  const fxaaRequested = options.antialias === 'fxaa';
  const farAllocated = farScale > 0 && (farScale < 1 || fxaaRequested),
    midAllocated = farScale > 0 && (midScale < 1 || fxaaRequested),
    split = farAllocated || midAllocated;
  return {
    mode: split ? 'split' : 'full',
    allocationOptimization: split
      ? fxaaRequested
        ? 'fxaa-depth-atlas'
        : 'reduced-depth-bands'
      : farScale === 0
        ? 'legacy-far-zero'
        : 'unit-ratios-mono',
    farScale,
    midScale,
    nearScale,
    nearRequestNormalized,
    farAllocated,
    midAllocated,
    farBand,
    midBand,
    farWidth: farAllocated ? Math.max(1, Math.round(nearWidth * farScale)) : 0,
    farHeight: farAllocated ? Math.max(1, Math.round(farBand.baseBounds.height * farScale)) : 0,
    midWidth: midAllocated ? Math.max(1, Math.round(nearWidth * midScale)) : 0,
    midHeight: midAllocated ? Math.max(1, Math.round(midBand.baseBounds.height * midScale)) : 0,
    nearWidth,
    nearHeight,
  };
}
function gpuLayerFilterStats(
  out,
  texture,
  scale,
  y0,
  y1,
  targetWidth,
  targetHeight,
  baseWidth,
  baseHeight,
  enabled,
  worldSpan = 1,
) {
  const x = Math.max(1, (Math.abs(scale) * texture.width) / targetWidth),
    y = Math.max(1, (worldSpan * texture.height) / (Math.abs(y1 - y0) * targetHeight));
  const active = enabled && (targetWidth < baseWidth || targetHeight < baseHeight),
    levels = texture.mipLevelCount || 1;
  const lod = active ? Math.min(Math.log2(Math.min(x, y)), levels - 1) : 0;
  const gx = active ? Math.min(8, Math.ceil(x / 2 ** lod)) : 1,
    gy = active ? Math.min(8, Math.ceil(y / 2 ** lod)) : 1;
  out.active = active;
  out.sourceMipLevels = levels;
  out.sourceTexelsX = x;
  out.sourceTexelsY = y;
  out.lod = lod;
  out.estimatedGridX = gx;
  out.estimatedGridY = gy;
  out.estimatedTapsPerTexture = gx * gy;
  out.worldBlendMaximumTaps = gx * gy * 2;
}
function gpuBackgroundTimings(t, start, hasFar, hasMid, uiActive, hasFXAA = false, combinedDepth = false) {
  const near = 4 - start,
    scene = 6 - start,
    last = (uiActive ? 9 : 7) - start;
  return {
    backgroundFar: hasFar ? Number(t[1] - t[0]) / 1e6 : 0,
    backgroundMid: hasMid && !combinedDepth ? Number(t[3 - start] - t[2 - start]) / 1e6 : 0,
    backgroundDepthCombined: combinedDepth,
    backgroundNear: Number(t[near + 1] - t[near]) / 1e6,
    background: Number(t[near + 1] - t[0]) / 1e6,
    scene: Number(t[scene + 1] - t[scene]) / 1e6,
    backgroundFXAA: hasFXAA ? Number(t[11 - start] - t[10 - start]) / 1e6 : 0,
    ui: uiActive ? Number(t[last] - t[scene + 1]) / 1e6 : 0,
    final: Number(t[last] - t[scene]) / 1e6,
    total: Number(t[last] - t[0]) / 1e6,
  };
}
function gpuDepthAtlasPlan(resolution, maxDimension, maxWorkgroups = 65535) {
  const gutter = 1,
    regions = [];
  for (const depth of ['far', 'mid'])
    if (resolution[depth + 'Allocated'])
      regions.push({
        depth,
        layer: depth === 'far' ? 0 : 1,
        width: resolution[depth + 'Width'],
        height: resolution[depth + 'Height'],
      });
  if (!regions.length)
    return { fits: true, width: 0, height: 0, gutter, regions, workgroups: [0, 0, 0], reason: 'no-input-regions' };
  const widths = regions.map(r => r.width + gutter * 2),
    heights = regions.map(r => r.height + gutter * 2);
  const candidates = [
    { axis: 'vertical', width: Math.max(...widths), height: heights.reduce((a, b) => a + b, 0) },
    { axis: 'horizontal', width: widths.reduce((a, b) => a + b, 0), height: Math.max(...heights) },
  ];
  const pack = candidates
    .filter(p => p.width <= maxDimension && p.height <= maxDimension)
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  const workgroups = [
    Math.ceil(Math.max(...regions.map(r => r.width)) / 8),
    Math.ceil(Math.max(...regions.map(r => r.height)) / 8),
    regions.length,
  ];
  if (!pack || workgroups.some(n => n > maxWorkgroups))
    return {
      fits: false,
      width: 0,
      height: 0,
      gutter,
      regions,
      workgroups,
      reason: !pack ? 'regions-exceed-atlas-dimension-limit' : 'regions-exceed-compute-dispatch-limit',
    };
  let cursor = 0;
  for (const r of regions) {
    r.x = (pack.axis === 'horizontal' ? cursor : 0) + gutter;
    r.y = (pack.axis === 'vertical' ? cursor : 0) + gutter;
    cursor += (pack.axis === 'horizontal' ? r.width : r.height) + gutter * 2;
  }
  return {
    fits: true,
    width: pack.width,
    height: pack.height,
    gutter,
    regions,
    farRegion: regions.find(r => r.depth === 'far') || null,
    midRegion: regions.find(r => r.depth === 'mid') || null,
    workgroups,
    packing: pack.axis,
    reason: null,
  };
}
const GPU_DEPTH_FXAA = `
struct FXAARegions { size:vec4u, rects:array<vec4u,2> };
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var destination:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(2) var<uniform> Regions:FXAARegions;
@group(0) @binding(3) var linearClamp:sampler;
fn edgeSignal(c:vec4f)->f32 {
 return dot(c.rgb+vec3f(1.-c.a),vec3f(.299,.587,.114))+.125*(1.-c.a);
}
fn regionSample(p:vec2f,r:vec4u)->vec4f {
 let q=clamp(p,vec2f(r.xy)+vec2f(.5),vec2f(r.xy+r.zw)-vec2f(.5));
 return textureSampleLevel(source,linearClamp,q/vec2f(Regions.size.yz),0.);
}
@compute @workgroup_size(8,8,1) fn fxaa(@builtin(global_invocation_id) gid:vec3u) {
 if(gid.z>=Regions.size.x){return;}
 let r=Regions.rects[gid.z];if(any(gid.xy>=r.zw)){return;}
 let pixel=r.xy+gid.xy;let p=vec2f(pixel)+vec2f(.5);
 let centre=textureLoad(source,vec2i(pixel),0);
 let nw=regionSample(p+vec2f(-1.,-1.),r);let ne=regionSample(p+vec2f(1.,-1.),r);
 let sw=regionSample(p+vec2f(-1.,1.),r);let se=regionSample(p+vec2f(1.,1.),r);
 let lc=edgeSignal(centre);let lnw=edgeSignal(nw);let lne=edgeSignal(ne);let lsw=edgeSignal(sw);let lse=edgeSignal(se);
 let low=min(lc,min(min(lnw,lne),min(lsw,lse)));let high=max(lc,max(max(lnw,lne),max(lsw,lse)));
 let alpha=max(centre.a,max(max(nw.a,ne.a),max(sw.a,se.a)));
 let threshold=max(1./255.,max(1.125-low,alpha)*.125);
 var colour=centre;
 if(high-low>=threshold){
  var direction=vec2f(-((lnw+lne)-(lsw+lse)),(lnw+lsw)-(lne+lse));
  let reduce=max((high-low)*.125,1./255.);
  direction=clamp(direction/(min(abs(direction.x),abs(direction.y))+reduce),vec2f(-4.),vec2f(4.));
  let a=.5*(regionSample(p+direction*(1./3.-.5),r)+regionSample(p+direction*(2./3.-.5),r));
  let b=a*.5+.25*(regionSample(p-direction*.5,r)+regionSample(p+direction*.5,r));
  let lb=edgeSignal(b);colour=select(b,a,lb<low||lb>high);
 }
 textureStore(destination,vec2i(pixel),colour);
}
`;
const GPU_PRESENT = `
@group(0) @binding(0) var s:sampler;
@group(0) @binding(1) var t:texture_2d<f32>;
struct V { @builtin(position) pos:vec4f,@location(0) uv:vec2f };
@vertex fn vert(@builtin(vertex_index) i:u32)->V {let p=array<vec2f,3>(vec2f(0.,0.),vec2f(2.,0.),vec2f(0.,2.));var o:V;o.uv=p[i];o.pos=vec4f(p[i]*vec2f(2.,-2.)+vec2f(-1.,1.),0.,1.);return o;}
@fragment fn frag(o:V)->@location(0) vec4f {return textureSampleLevel(t,s,o.uv,0.);}`;
async function gpuShader(device, label, code) {
  const m = device.createShaderModule({ label, code });
  const info = await m.getCompilationInfo();
  const errors = info.messages.filter(x => x.type === 'error');
  if (errors.length)
    throw new Error(label + ': ' + errors.map(x => x.lineNum + ':' + x.linePos + ' ' + x.message).join('\n'));
  return m;
}
async function gpuCompositorBatch(promises) {
  const results = await Promise.allSettled(promises),
    failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}
async function createWebGPU(canvas, failed) {
  return createWebGPUAttempt(canvas, failed, { expired: false, cancel: null });
}
async function createWebGPUAttempt(canvas, failed, attempt) {
  if (!navigator.gpu) {
    GPU_DIAG.state = 'failed';
    GPU_DIAG.error = 'Worker WebGPU unavailable';
    return null;
  }
  let device,
    context,
    disposed = false,
    initializationScope = false;
  attempt.cancel = () => {
    disposed = true;
    context?.unconfigure();
    device?.destroy();
  };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    if (attempt.expired) return null;
    if (!adapter) throw new Error('No low-power WebGPU adapter');
    const info = adapter.info || {};
    GPU_DIAG.adapter = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ');
    const timestamp = adapter.features.has('timestamp-query');
    device = await adapter.requestDevice({ requiredFeatures: timestamp ? ['timestamp-query'] : [] });
    if (attempt.expired) {
      device.destroy();
      return null;
    }
    let broken = false;
    const fail = e => {
      if (broken || disposed) return;
      broken = true;
      GPU_DIAG.error = String(e.message || e);
      GPU_DIAG.state = 'failed';
      failed(e);
    };
    device.addEventListener('uncapturederror', e => {
      e.preventDefault();
      fail(e.error);
    });
    device.lost.then(info => {
      if (!disposed) fail(new Error('device.lost: ' + info.reason + ' ' + info.message));
    });
    device.pushErrorScope('validation');
    initializationScope = true;
    const format = navigator.gpu.getPreferredCanvasFormat();
    const [background, farShader, midShader, nearShader, present, fxaaShader] = await gpuCompositorBatch([
      gpuShader(device, 'background (WGSL)', GPU_BACKGROUND),
      gpuShader(device, 'Far forest (WGSL)', GPU_BACKGROUND_FAR),
      gpuShader(device, 'Mid forest (WGSL)', GPU_BACKGROUND_MID),
      gpuShader(device, 'Base-resolution near scenery (WGSL)', GPU_BACKGROUND_NEAR),
      gpuShader(device, 'Background upscale', GPU_PRESENT),
      gpuShader(device, 'Depth atlas FXAA (WGSL)', GPU_DEPTH_FXAA),
    ]);
    const backgroundEntries = [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ...GPU_SAMPLERS.map((_, i) => ({
        binding: i + 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      })),
    ];
    const backgroundLayout = device.createBindGroupLayout({
      label: 'background static resources',
      entries: backgroundEntries,
    });
    const layerLayout = device.createBindGroupLayout({
      label: 'forest footprint resources',
      entries: [
        ...backgroundEntries,
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const nearLayout = device.createBindGroupLayout({
      label: 'near plus far and mid ink',
      entries: [
        ...backgroundEntries,
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 15, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const fxaaLayout = device.createBindGroupLayout({
      label: 'depth atlas FXAA resources',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm' },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    });
    const makeBackgroundPipeline = (module, label, layout) =>
      device.createRenderPipelineAsync({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vert' },
        fragment: { module, entryPoint: 'frag', targets: [{ format: 'rgba8unorm' }] },
      });
    const [pipeline, farPipeline, midPipeline, nearPipeline, finalPipeline, fxaaPipeline] = await gpuCompositorBatch([
      makeBackgroundPipeline(background, 'background', backgroundLayout),
      makeBackgroundPipeline(farShader, 'far forest', layerLayout),
      makeBackgroundPipeline(midShader, 'mid forest', layerLayout),
      makeBackgroundPipeline(nearShader, 'near scenery', nearLayout),
      device.createRenderPipelineAsync({
        label: 'present',
        layout: 'auto',
        vertex: { module: present, entryPoint: 'vert' },
        fragment: { module: present, entryPoint: 'frag', targets: [{ format }] },
      }),
      device.createComputePipelineAsync({
        label: 'depth atlas FXAA',
        layout: device.createPipelineLayout({ bindGroupLayouts: [fxaaLayout] }),
        compute: { module: fxaaShader, entryPoint: 'fxaa' },
      }),
    ]);
    const initError = await device.popErrorScope();
    initializationScope = false;
    if (initError) throw initError;
    if (attempt.expired) {
      device.destroy();
      return null;
    }
    context = canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU canvas context unavailable');
    GPU_DIAG.canvasContext = 'webgpu';
    context.configure({
      device,
      format,
      alphaMode: 'opaque',
      colorSpace: 'srgb',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (canvas.style) canvas.style.visibility = 'hidden';
    const uniform = device.createBuffer({
      size: GPU_FIELDS.length * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const values = new Float32Array(GPU_FIELDS.length * 4);
    const offsets = Object.fromEntries(GPU_FIELDS.map((k, i) => [k, i * 4]));
    const set = (k, ...v) => values.set(v, offsets[k]);
    const put1 = (k, a) => {
        values[offsets[k]] = a;
      },
      put2 = (k, a, b) => {
        const o = offsets[k];
        values[o] = a;
        values[o + 1] = b;
      },
      putAll = (k, a) => {
        const o = offsets[k];
        for (let i = 0; i < a.length; i++) values[o + i] = a[i];
      };
    for (const [k, c] of Object.entries({
      uMistZ: MIST_ZH,
      uMistJ: MIST_JA,
      uWashZ: WASH_ZH,
      uWashJ: WASH_JA,
      uSkyZ0: SKY.zh[0],
      uSkyZ1: SKY.zh[1],
      uSkyZ2: SKY.zh[2],
      uSkyJ0: SKY.ja[0],
      uSkyJ1: SKY.ja[1],
      uSkyJ2: SKY.ja[2],
      uMtZA: MTN_TINT.zh[0],
      uMtZB: MTN_TINT.zh[1],
      uMtJA: MTN_TINT.ja[0],
      uMtJB: MTN_TINT.ja[1],
    }))
      set(k, ...c3(c));
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', mipmapFilter: 'linear' });
    const repeat = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    const paperLayout = device.createBindGroupLayout({
      label: 'text paper uniforms and static textures',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const farFilterUniform = device.createBuffer({
      label: 'far forest footprint',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const midFilterUniform = device.createBuffer({
      label: 'mid forest footprint',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const nearDepthUniform = device.createBuffer({
      label: 'near forest target bands and valid rects',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fxaaRegionUniform = device.createBuffer({
      label: 'depth atlas FXAA region table',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const filterValues = new Float32Array(12),
      nearDepthValues = new Float32Array(16),
      fxaaRegionValues = new Uint32Array(12);
    let tex = [],
      texViews = [],
      binding = null,
      farBinding = null,
      midBinding = null,
      nearBinding = null,
      paperBinding = null,
      intermediate = null,
      intermediateView = null,
      farTarget = null,
      farView = null,
      midTarget = null,
      midView = null,
      presentBinding = null,
      particles = null,
      textRenderer = null,
      textFrame = null,
      uiRenderer = null,
      uiFrame = null,
      first = true,
      validated = false,
      draining = null;
    let fxaaInputTarget = null,
      fxaaInputView = null,
      fxaaOutputTarget = null,
      fxaaOutputView = null,
      fxaaBinding = null,
      fxaaPlan = null;
    const glyphPreparation = createGlyphPreparationService({
      fonts: self.fonts,
      nativePrewarm: true,
      validation: param('glyphvalidate') === 'all' ? 'all' : 'sample',
    });
    GPU_DIAG.glyphPreparation = glyphPreparation.metadata;
    let glyphManifestPromise = null,
      startupRenderersTask = null;
    const glyphManifest = () =>
      glyphManifestPromise ||
      (glyphManifestPromise = GPU_STARTUP.fontManifest().then(manifest => glyphPreparation.setFontManifest(manifest)));
    let width = 1,
      height = 1,
      baseWidth = 1,
      baseHeight = 1,
      farWidth = 0,
      farHeight = 0,
      midWidth = 0,
      midHeight = 0,
      frameN = 0,
      frameScope = false,
      presented = false;
    let presentationGeneration = 0;
    const frameDiagnostics = workerFrames;
    frameDiagnostics?.setGPUStatus({
      supported: timestamp,
      enabled: timestamp,
      reliable: timestamp,
      reason: timestamp ? 'native timestamp-query; scene passes only' : 'timestamp-query unavailable',
    });
    let resolutionOptions = {
        farScale: param('farres'),
        midScale: param('midres'),
        nearScale: param('nearres'),
        antialias: param('layeraa') ?? 'off',
        antialiasRaw: param('layeraa'),
      },
      resolution = gpuBackgroundResolution(1, 1, resolutionOptions);
    const sourceTileQuery = { tilefar: param('tilefar'), tilemid: param('tilemid'), tileaa: param('tileaa') },
      sourceTileScales = {
        farScale: gpuSourceTileScale(sourceTileQuery.tilefar),
        midScale: gpuSourceTileScale(sourceTileQuery.tilemid),
        nearScale: 1,
        closeScale: 1,
      };
    const sourceTileAntialias = sourceTileQuery.tileaa !== 'off';
    const sourceMeshEnabled = true,
      sourceRasterScaling = sourceMeshEnabled && (sourceTileScales.farScale < 1 || sourceTileScales.midScale < 1);
    let ringPhysical = [];
    const texture = (w, h, label) =>
      device.createTexture({
        label,
        size: [w, h],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
    const atlasTexture = (w, h, label, storage) =>
      device.createTexture({
        label,
        size: [w, h],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST |
          (storage ? GPUTextureUsage.STORAGE_BINDING : GPUTextureUsage.RENDER_ATTACHMENT),
      });
    const replaceTex = (i, t) => {
      tex[i]?.destroy();
      tex[i] = t;
      texViews[i] = t.createView();
      binding = null;
      farBinding = null;
      midBinding = null;
      nearBinding = null;
      if (i >= 8) paperBinding = null;
    };
    const entries = () => [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: repeat },
      ...texViews.map((view, i) => ({ binding: i + 3, resource: view })),
    ];
    const paperBindGroup = () =>
      paperBinding ||
      (paperBinding = device.createBindGroup({
        label: 'text paper',
        layout: paperLayout,
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: repeat },
          { binding: 3, resource: texViews[8] },
          { binding: 4, resource: texViews[9] },
        ],
      }));
    const timings = timestamp
      ? Array.from({ length: 3 }, () => ({
          busy: false,
          q: device.createQuerySet({ type: 'timestamp', count: 12 }),
          resolve: device.createBuffer({ size: 96, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          read: device.createBuffer({ size: 96, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        }))
      : [];
    let particleSets = null;
    const uiBoxDraw = { offsetX: 0, offsetY: 0, key: 'ui-box' },
      uiEncodeOptions = {
        sceneTexture: null,
        textureAsView: false,
        drawBoxParticles: (pass, o) => {
          if (particles) {
            uiBoxDraw.offsetX = o.offsetX;
            uiBoxDraw.offsetY = o.offsetY;
            particles.draw(pass, boxDrift, o.fade, o.W, o.H, uiBoxDraw);
          }
        },
      };
    const stamp = (q, a, b) =>
      q ? { timestampWrites: { querySet: q.q, beginningOfPassWriteIndex: a, endOfPassWriteIndex: b } } : {};
    const tileTimings = timestamp
      ? Array.from({ length: 3 }, () => ({
          busy: false,
          q: device.createQuerySet({ type: 'timestamp', count: 2 }),
          resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          read: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        }))
      : [];
    const updateBytes = () => {
      GPU_DIAG.bytes = {
        rings: tex.slice(0, 8).reduce((n, t) => n + (t ? t.width * t.height * 4 : 0), 0),
        noise: tex[9] ? tex[9].width * tex[9].height * 4 : 0,
        mountains: tex[8] ? tex[8].width * tex[8].height * 4 : 0,
        background: intermediate ? width * height * 4 : 0,
        backgroundFar: farTarget ? farWidth * farHeight * 4 : 0,
        backgroundMid: midTarget ? midWidth * midHeight * 4 : 0,
        backgroundFXAAInput: fxaaInputTarget ? fxaaInputTarget.width * fxaaInputTarget.height * 4 : 0,
        backgroundFXAAOutput: fxaaOutputTarget ? fxaaOutputTarget.width * fxaaOutputTarget.height * 4 : 0,
        backgroundFilterUniforms: 96,
        backgroundDepthUniform: 64,
        backgroundFXAARegions: 48,
        backgroundUniform: uniform.size,
        presentation: canvas.width * canvas.height * 4,
        presentationBuffers: 0,
        particles: particles?.metadata.byteCount || 0,
        text: textRenderer?.metadata.byteCount || 0,
        ui: uiRenderer?.metadata.byteCount || 0,
        tileUploadScratch: 0,
        tileRaster: tileRenderer?.metadata.byteCount || 0,
        tileTimingReadback: tileTimings.length * 32,
        sceneTimingReadback: timings.length * 192,
      };
      GPU_DIAG.resourcePeak = Math.max(
        GPU_DIAG.resourcePeak || 0,
        Object.values(GPU_DIAG.bytes).reduce((a, b) => a + b, 0),
      );
    };
    const meshQueue = [];
    let tileRenderer = null,
      activeMesh = null,
      lastAccountedTileBytes = -1;
    let sharing = false,
      sharedEncoder = null;
    const afterShared = [];
    const flushShared = () => {
      const encoder = sharedEncoder;
      if (!encoder) return;
      sharedEncoder = null;
      device.queue.submit([encoder.finish()]);
      for (let i = 0; i < afterShared.length; i++) afterShared[i]();
      afterShared.length = 0;
    };
    const submitEncoder = encoder => {
      if (encoder === sharedEncoder) flushShared();
      else device.queue.submit([encoder.finish()]);
    };
    const afterSubmit = (encoder, action) => {
      if (encoder === sharedEncoder) afterShared.push(action);
      else action();
    };
    let textureAsView = false;
    {
      device.pushErrorScope('validation');
      let accepted = false;
      try {
        const probe = device.createTexture({
            size: [1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          }),
          encoder = device.createCommandEncoder();
        encoder.beginRenderPass({ colorAttachments: [{ view: probe, loadOp: 'clear', storeOp: 'discard' }] }).end();
        device.queue.submit([encoder.finish()]);
        device.createBindGroup({
          layout: device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }],
          }),
          entries: [{ binding: 0, resource: probe }],
        });
        probe.destroy();
        accepted = true;
      } catch (error) {}
      const problem = await device.popErrorScope().catch(() => true);
      textureAsView = accepted && !problem;
    }
    GPU_DIAG.textureAsView = textureAsView;
    const tileGate = createGPUTileSubmissionGate(device.queue, fail, 2, submitEncoder);
    GPU_DIAG.tileSubmission = tileGate.stats;
    const tileBacklog = createGPUTileBacklogPolicy();
    GPU_DIAG.tileBacklog = tileBacklog.metadata;
    let tileOpeningMode = false,
      tilePrewarmMode = false,
      frameCadenceMs = null,
      sceneGPUms = 0;
    const tileOpeningStats = {
      enabled: false,
      limit: 16,
      batches: 0,
      rounds: 0,
      submitted: 0,
      stalls: 0,
      timestamped: 0,
      untimestamped: 0,
    };
    GPU_DIAG.tileOpening = tileOpeningStats;
    const liveMesh = t =>
      t.job.era === renderWorld.era && world.rings[t.job.sc]?.[t.job.li]?.want[t.job.slot] === t.job.k;
    function pruneMeshQueue() {
      for (let i = meshQueue.length - 1; i >= 0; i--)
        if (!liveMesh(meshQueue[i])) {
          releaseTileDelivery(meshQueue[i].mesh);
          meshQueue.splice(i, 1);
          GPU_DIAG.staleMeshDropped = (GPU_DIAG.staleMeshDropped || 0) + 1;
        }
    }
    function clearUploads() {
      const reset =
        GPU_DIAG.tileQueueReset || (GPU_DIAG.tileQueueReset = { count: 0, droppedQueued: 0, cancelledActive: 0 });
      reset.count++;
      reset.droppedQueued += meshQueue.length;
      reset.cancelledActive += activeMesh ? 1 : 0;
      tileRenderer?.cancel();
      for (const t of meshQueue) releaseTileDelivery(t.mesh);
      releaseTileDelivery(activeMesh?.mesh);
      meshQueue.length = 0;
      activeMesh = null;
      tileBacklog.reset();
      if (!tileOpeningMode) tileGate.setLimit(2);
    }
    function updateTileBacklog(at) {
      let visibleMissing = 0,
        wantedMissing = 0;
      const cam = springs.cam.x,
        dom = st.page.D ? 'ja' : 'zh',
        transition = st.page.t > 0.0005;
      for (let li = 0; li < 4; li++) {
        const g = world.geo[li];
        if (!g) continue;
        const left = cam * LAYERS[li].pan * world.H,
          k0 = Math.floor((left * g.ts) / g.T),
          k1 = Math.ceil(((left + world.W) * g.ts) / g.T) - 1;
        for (const sc of ['zh', 'ja']) {
          const ring = world.rings[sc]?.[li];
          if (!ring) continue;
          for (let slot = 0; slot < ring.want.length; slot++)
            if (Number.isFinite(ring.want[slot]) && ring.has[slot] !== ring.want[slot]) wantedMissing++;
          if (sc === dom || transition)
            for (let k = k0; k <= k1; k++) {
              const slot = ((k % g.n) + g.n) % g.n;
              if (ring.has[slot] !== k) visibleMissing++;
            }
        }
      }
      const settings = tileBacklog.update(at, visibleMissing, wantedMissing);
      tileGate.setLimit(settings.submissionLimit);
      return settings;
    }
    const api = {
      kind: 'webgpu',
      maxTex: device.limits.maxTextureDimension2D,
      device,
      format,
      setFrameCadence(ms) {
        if (Number.isFinite(ms) && ms >= 4 && ms <= 34) frameCadenceMs = ms;
      },
      setTilePrewarmMode(enabled) {
        tilePrewarmMode = enabled === true;
      },
      tilePreprocessLimits: {
        maxTextureDimension2D: device.limits.maxTextureDimension2D,
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        maxBufferSize: device.limits.maxBufferSize,
      },
      get valid() {
        return validated;
      },
      get presented() {
        return presented;
      },
      get lost() {
        return broken;
      },
      statics(pn) {
        replaceTex(9, texture(pn.width, pn.height, 'paper and noise'));
        if (pn.data)
          device.queue.writeTexture({ texture: tex[9] }, pn.data, { bytesPerRow: pn.width * 4 }, [pn.width, pn.height]);
        else device.queue.copyExternalImageToTexture({ source: pn }, { texture: tex[9] }, [pn.width, pn.height]);
      },
      alloc(geo) {
        clearUploads();
        const plans = geo.map((g, li) => {
          const scale = sourceMeshEnabled
            ? li === 0
              ? sourceTileScales.farScale
              : li === 1
                ? sourceTileScales.midScale
                : 1
            : 1;
          const plan = gpuTileRasterPlan(g.T, g.Ht, g.pad, scale),
            ringWidth = g.n * plan.outputWidth;
          if (
            !Number.isSafeInteger(g.n) ||
            g.n < 1 ||
            !Number.isSafeInteger(ringWidth) ||
            ringWidth > device.limits.maxTextureDimension2D ||
            plan.outputHeight > device.limits.maxTextureDimension2D
          )
            throw Error('Physical tile ring exceeds texture dimension limit');
          return { ...plan, ringWidth, slots: g.n };
        });
        ringPhysical = plans;
        for (const sc of ['zh', 'ja'])
          geo.forEach((g, li) => {
            const p = plans[li];
            replaceTex(unitOf(sc, li), texture(p.ringWidth, p.outputHeight, sc + ' layer ' + li));
          });
        const layers = geo.map((g, li) => {
          const p = plans[li],
            logicalBytes = 2 * g.R * g.Ht * 4,
            physicalBytes = 2 * p.ringWidth * p.outputHeight * 4;
          return {
            li,
            requestedScale: li === 0 ? sourceTileScales.farScale : li === 1 ? sourceTileScales.midScale : 1,
            effectiveScale: p.scale,
            logical: { width: g.T, height: g.Ht, pad: g.pad, ringWidth: g.R, slots: g.n, layerScale: LAYERS[li].res },
            physical: {
              width: p.outputWidth,
              height: p.outputHeight,
              stageWidth: p.stageWidth,
              stageHeight: p.stageHeight,
              padX: p.padX,
              padY: p.padY,
              ringWidth: p.ringWidth,
              sx: p.sx,
              sy: p.sy,
              viewport: p.viewport,
            },
            allocation: { rings: 2, logicalBytes, physicalBytes, savedBytes: logicalBytes - physicalBytes },
          };
        });
        const logicalRingBytes = layers.reduce((n, l) => n + l.allocation.logicalBytes, 0),
          physicalRingBytes = layers.reduce((n, l) => n + l.allocation.physicalBytes, 0);
        GPU_DIAG.sourceTileResolution = {
          schema: 1,
          policy: 'source-root-raster-scale-v1',
          query: { ...sourceTileQuery },
          requested: { ...sourceTileScales },
          effective: { farScale: plans[0]?.scale ?? 1, midScale: plans[1]?.scale ?? 1, nearScale: 1, closeScale: 1 },
          meshOnly: true,
          meshEnabled: sourceMeshEnabled,
          rasterScaling: sourceRasterScaling,
          rasterAA: sourceMeshEnabled ? (sourceTileAntialias ? 'msaa' : 'off') : 'canvas',
          msaaSampleCount: sourceMeshEnabled ? (sourceTileAntialias ? 4 : 1) : null,
          currentAA: sourceMeshEnabled ? (sourceTileAntialias ? 'msaa' : 'off') : 'canvas',
          nearForced1: true,
          closeForced1: true,
          worldGeometry: 'logical-original',
          groupAtlasResolution: 'original',
          scope: ['root-stage', 'root-blur', 'output', 'ring'],
          layers,
          logicalRingBytes,
          physicalRingBytes,
          savedRingBytes: logicalRingBytes - physicalRingBytes,
        };
        updateBytes();
      },
      get queue() {
        return device.queue;
      },
      get meshPending() {
        return meshQueue.length + (activeMesh ? 1 : 0);
      },
      reprioritizeTiles(priorityOfJob) {
        if (activeMesh) activeMesh.job.pri = priorityOfJob(activeMesh.job);
        for (const tile of meshQueue) tile.job.pri = priorityOfJob(tile.job);
      },
      get tilePlanningLimit() {
        return SITE_DEBUG && HASH.includes('debug') && GPU_DIAG.tileBacklogProbeDisabled
          ? 2
          : tileBacklog.metadata.planningLimit;
      },
      get uploading() {
        return this.meshPending;
      },
      get uploadUrgent() {
        return activeMesh?.job.pri === 0 || meshQueue.some(t => t.job.pri === 0);
      },
      debugTileSnapshot() {
        const identity = t => {
          if (!t) return null;
          const j = t.job,
            r = world.rings?.[j.sc]?.[j.li];
          return {
            era: j.era,
            id: j.id,
            sc: j.sc,
            li: j.li,
            k: j.k,
            slot: j.slot,
            pri: j.pri,
            live: liveMesh(t),
            wanted: r?.want[j.slot] ?? null,
            has: r?.has[j.slot] ?? null,
          };
        };
        const j = tileRenderer?.active;
        const rings = [];
        let missingWanted = 0;
        for (const sc of ['zh', 'ja'])
          for (let li = 0; li < 4; li++) {
            const r = world.rings?.[sc]?.[li];
            if (!r) continue;
            const wanted = Array.from(r.want),
              has = Array.from(r.has);
            let missing = 0;
            for (let slot = 0; slot < wanted.length; slot++)
              if (Number.isFinite(wanted[slot]) && wanted[slot] !== has[slot]) missing++;
            missingWanted += missing;
            rings.push({ sc, li, wanted, has, missingWanted: missing });
          }
        const active = identity(activeMesh),
          queued = meshQueue.map(identity),
          activeOrphan = !!active && !active.live,
          queuedOrphans = queued.filter(t => !t.live).length;
        const rendererTerminal = !!j && ['done', 'failed', 'cancelled'].includes(j.phase),
          rendererOwnerRequired = !!j && !rendererTerminal;
        const rendererOrphan = rendererOwnerRequired && !activeMesh,
          rendererIdentityMismatch =
            rendererOwnerRequired &&
            !!activeMesh &&
            j.settings?.jobId !== undefined &&
            j.settings.jobId !== activeMesh.job.id;
        return {
          active,
          queued,
          rings,
          missingWanted,
          opening: { ...tileOpeningStats },
          submission: { ...tileGate.stats },
          orphans: {
            active: activeOrphan,
            queued: queuedOrphans,
            renderer: rendererOrphan,
            rendererIdentityMismatch,
            count: Number(activeOrphan) + queuedOrphans + Number(rendererOrphan) + Number(rendererIdentityMismatch),
          },
          renderer: j
            ? {
                id: j.id,
                jobId: j.settings?.jobId ?? null,
                phase: j.phase,
                terminal: rendererTerminal,
                ownerRequired: rendererOwnerRequired,
                iterations: j.iterations || 0,
                uploadIndex: j.uploadIndex || 0,
                stageIndex: j.stageIndex || 0,
                postIndex: j.postIndex || 0,
                computeIndex: j.computeIndex || 0,
                stageCount: j.stages?.length || 0,
              }
            : null,
        };
      },
      setTileOpeningMode(enabled) {
        tileOpeningMode = enabled === true;
        tileOpeningStats.enabled = tileOpeningMode;
        tileBacklog.reset();
        tileGate.setLimit(tileOpeningMode ? 16 : 2);
        return tileOpeningStats;
      },
      async prepareTiles(settings = {}) {
        const made = await createGPUTileRenderer(device, {
          format: 'rgba8unorm',
          gpuPreparation: true,
          reuseResources: true,
          antialias: sourceTileAntialias,
          rasterScaling: sourceRasterScaling,
          computeMaxGroups: 2048,
          computeMaxVertices: 131072,
          coarseClockBudget: param('tilecpuclock') !== '0',
          stampField: settings.stampField,
          onError: fail,
        });
        if (broken || disposed) {
          made.dispose();
          throw new Error('Tile preparation was cancelled');
        }
        tileRenderer = made;
        GPU_DIAG.tiles = made.metadata;
        updateBytes();
      },
      queueMesh(job, mesh, ms) {
        if (broken || disposed) {
          releaseTileDelivery(mesh);
          return;
        }
        pruneMeshQueue();
        if (!liveMesh({ job })) {
          releaseTileDelivery(mesh);
          GPU_DIAG.staleMeshDropped = (GPU_DIAG.staleMeshDropped || 0) + 1;
          return;
        }
        meshQueue.push({ job, mesh, ms, cpu: 0, frames: 0, slices: 0, lastRenderFrame: null });
        GPU_DIAG.meshQueuePeak = Math.max(GPU_DIAG.meshQueuePeak || 0, meshQueue.length + (activeMesh ? 1 : 0));
      },
      renderMesh() {
        if (!tileOpeningMode) {
          const at = performance.now(),
            settings = updateTileBacklog(at);
          const override = SITE_DEBUG && HASH.includes('debug') ? GPU_DIAG.tileCPUProbeBudgetMs : undefined;
          const disabled = SITE_DEBUG && HASH.includes('debug') && GPU_DIAG.tileBacklogProbeDisabled;
          const cpuMs = Number.isFinite(override)
            ? Math.max(0.25, Math.min(2, override))
            : disabled
              ? 0.65
              : settings.cpuMs;
          const rounds = disabled ? 1 : settings.rounds;
          const catchUp = settings.visibleMissing > 0 || (tilePrewarmMode && settings.wantedMissing > 0);
          const frameCPUms = Math.min(
            rounds === 1 ? cpuMs : settings.frameCPUms,
            frameCadenceMs && !catchUp ? Math.max(0.65, frameCadenceMs * 0.2) : Infinity,
          );
          const frameDeadline = at + frameCPUms;
          const gpuCeiling = catchUp ? (settings.level === 3 ? 12 : settings.level === 2 ? 8 : 5) : 3;
          const gpuFloor = catchUp ? (settings.level === 3 ? 6 : settings.level === 2 ? 4 : 2) : 0.4;
          const frameGPUms = frameCadenceMs
            ? Math.max(gpuFloor, Math.min(gpuCeiling, frameCadenceMs - sceneGPUms - 1.5))
            : gpuCeiling;
          const frameUploadBytes = catchUp ? 3145728 : 786432;
          let gpuRemaining = frameGPUms,
            uploadRemaining = frameUploadBytes,
            gpuEstimated = 0,
            uploadedBytes = 0;
          Object.assign(tileBacklog.metadata, { catchUp, frameGPUms, frameUploadBytes, frameCadenceMs, sceneGPUms });
          if (rounds === 1 && GPU_DIAG.tileBacklogProbeDisabled) tileGate.setLimit(2);
          tileBacklog.metadata.batches++;
          for (let round = 0; round < rounds; round++) {
            if (
              broken ||
              disposed ||
              !(activeMesh || meshQueue.length) ||
              performance.now() >= frameDeadline ||
              gpuRemaining <= 0
            )
              break;
            const progress = this.renderMeshSlice({
              cpuMs,
              frameDeadline,
              gpuMs: gpuRemaining,
              maxUploadBytes: uploadRemaining,
            });
            tileBacklog.metadata.roundsRun++;
            gpuEstimated += progress?.estimatedGPUms || 0;
            uploadedBytes += progress?.uploadedBytes || 0;
            gpuRemaining = frameGPUms - gpuEstimated;
            uploadRemaining = Math.max(0, frameUploadBytes - uploadedBytes);
            tileBacklog.metadata.peakPlayPending = Math.max(
              tileBacklog.metadata.peakPlayPending,
              tileGate.stats.pending,
            );
            if (!progress?.advanced) break;
          }
          Object.assign(tileBacklog.metadata, {
            lastFrameEstimatedGPUms: gpuEstimated,
            lastFrameUploadBytes: uploadedBytes,
            lastFrameCPUAllowanceMs: frameCPUms,
          });
          return;
        }
        tileOpeningStats.batches++;
        for (let round = 0; round < 16; round++) {
          if (broken || disposed || !tileOpeningMode || !(activeMesh || meshQueue.length)) break;
          const progress = this.renderMeshSlice();
          tileOpeningStats.rounds++;
          if (progress?.submitted) tileOpeningStats.submitted++;
          if (!progress?.advanced) {
            tileOpeningStats.stalls++;
            break;
          }
        }
      },
      renderMeshSlice(playBudget) {
        if (!tileRenderer) return;
        if (!tileGate.ready) {
          tileGate.stats.blockedFrames++;
          return;
        }
        const t0 = performance.now();
        pruneMeshQueue();
        const pruneEnd = performance.now();
        let startCPUms = 0,
          started = false;
        if (!activeMesh && meshQueue.length) {
          let best = 0;
          for (let i = 1; i < meshQueue.length; i++) if (meshQueue[i].job.pri < meshQueue[best].job.pri) best = i;
          activeMesh = meshQueue.splice(best, 1)[0];
          const { job, mesh } = activeMesh,
            g = world.geo[job.li],
            physical = ringPhysical[job.li];
          if (job.era !== renderWorld.era || world.rings[job.sc][job.li].want[job.slot] !== job.k) {
            releaseTileDelivery(mesh);
            activeMesh = null;
            dispatch();
            return;
          }
          if (!physical) throw Error('GPU tile has no physical ring allocation plan');
          const startAt = performance.now();
          tileRenderer.start(mesh, {
            width: g.T,
            height: g.Ht,
            pad: g.pad,
            sigma: LAYERS[job.li].blur * (world.H / 900) * g.ts,
            rasterScale: physical.scale,
            era: job.era,
            jobId: job.id,
          });
          startCPUms = performance.now() - startAt;
          started = true;
        }
        const t = activeMesh;
        if (!t) return;
        const { job } = t,
          g = world.geo[job.li],
          ring = world.rings[job.sc][job.li];
        if (job.era !== renderWorld.era || ring.want[job.slot] !== job.k) {
          tileRenderer.cancel();
          releaseTileDelivery(t.mesh);
          activeMesh = null;
          dispatch();
          return;
        }
        const encoderAt = performance.now(),
          encoder = sharedEncoder || device.createCommandEncoder({ label: 'budgeted tile slice' }),
          encoderCPUms = performance.now() - encoderAt;
        const timing = tileTimings.find(q => !q.busy);
        const stepAt = performance.now(),
          cpuBudget = playBudget?.cpuMs ?? 0.65,
          previousPhase = tileRenderer.active?.phase;
        const frameDeadline = tileOpeningMode
          ? Infinity
          : Math.min(t0 + cpuBudget, playBudget?.frameDeadline ?? Infinity);
        const result = tileRenderer.step(encoder, {
          maxUploadBytes: playBudget?.maxUploadBytes ?? 786432,
          maxCPUms: cpuBudget,
          maxRenderCPUms: cpuBudget * 0.85,
          frameDeadline,
          maxGPUms: playBudget?.gpuMs ?? 3,
          opening: tileOpeningMode,
          ...stamp(timing, 0, 1),
        });
        const stepCPUms = performance.now() - stepAt,
          commitAt = performance.now();
        result.opening = tileOpeningMode;
        if (tileOpeningMode && result.encoded) {
          if (timing) tileOpeningStats.timestamped++;
          else tileOpeningStats.untimestamped++;
        }
        if (timing && result.encoded) {
          timing.busy = true;
          encoder.resolveQuerySet(timing.q, 0, 2, timing.resolve, 0);
          encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
        }
        if (result.done) {
          const p = ringPhysical[job.li],
            target = tex[unitOf(job.sc, job.li)];
          if (
            !p ||
            result.width !== p.outputWidth ||
            result.height !== p.outputHeight ||
            result.texture?.width !== p.outputWidth ||
            result.texture?.height !== p.outputHeight
          )
            throw Error('GPU tile output dimensions do not match the physical ring allocation plan');
          if (
            !target ||
            target.width !== p.ringWidth ||
            target.height !== p.outputHeight ||
            !Number.isSafeInteger(job.slot) ||
            job.slot < 0 ||
            job.slot >= p.slots ||
            (job.slot + 1) * p.outputWidth > target.width
          )
            throw Error('GPU tile destination does not match its physical ring slot');
          encoder.copyTextureToTexture(
            { texture: result.texture },
            { texture: target, origin: [job.slot * p.outputWidth, 0] },
            [p.outputWidth, p.outputHeight],
          );
        }
        const commitCPUms = performance.now() - commitAt,
          submitAt = performance.now();
        const submitted = tileGate.submit(encoder, result.encoded || result.done);
        if (result.done && !submitted) throw Error('Completed GPU tile requires a submitted ring copy');
        if (submitted) tileRenderer.submitted();
        const submitCPUms = performance.now() - submitAt;
        if (timing && result.encoded)
          timing.read
            .mapAsync(GPUMapMode.READ)
            .then(() => {
              const ns = new BigUint64Array(timing.read.getMappedRange()),
                gpuMs = Number(ns[1] - ns[0]) / 1e6;
              timing.read.unmap();
              timing.busy = false;
              if (broken || disposed) return;
              tileRenderer.feedback({
                id: result.id,
                work: result.work,
                gpuMs,
                pass: result.gpuPassLabel,
                compute: !!result.computePasses,
                gpuWorkKind: result.gpuWorkKind,
                computedVertices: result.computedVertices,
                openingBudget: result.openingBudget,
              });
              const samples = GPU_DIAG.meshTimings || (GPU_DIAG.meshTimings = []);
              samples.push({
                t: performance.now(),
                gpuMs,
                frameStart: t0,
                sc: job.sc,
                li: job.li,
                k: job.k,
                opening: result.opening,
                openingBudget: !!result.openingBudget,
                budgetMode: result.budgetMode,
                work: result.work,
                id: result.id,
                phase: result.phase,
                compute: !!result.computePasses,
                gpuWorkKind: result.gpuWorkKind,
                computedVertices: result.computedVertices,
              });
              if (samples.length > 600) samples.shift();
            })
            .catch(e => {
              timing.busy = false;
              if (!disposed) fail(e);
            });
        const accountingAt = performance.now();
        if (lastAccountedTileBytes !== tileRenderer.metadata.byteCount) {
          lastAccountedTileBytes = tileRenderer.metadata.byteCount;
          updateBytes();
        }
        const accountingCPUms = performance.now() - accountingAt,
          finalizeAt = performance.now();
        t.slices++;
        if (t.lastRenderFrame !== frameN) {
          t.lastRenderFrame = frameN;
          t.frames++;
        }
        const slices = GPU_DIAG.meshSlices || (GPU_DIAG.meshSlices = []);
        const slice = {
          t: performance.now(),
          frame: frameN,
          frameStart: t0,
          id: result.id,
          sc: job.sc,
          li: job.li,
          k: job.k,
          phase: result.phase,
          submitted,
          uploadWrites: result.uploadWrites || 0,
          maxSingleUploadBytes: result.maxSingleUploadBytes || 0,
          maxSingleUploadCPUms: result.maxSingleUploadCPUms || 0,
          uploadCPUms: result.uploadCPUms || 0,
          cpuBreakdown: {
            prune: pruneEnd - t0,
            start: startCPUms,
            encoder: encoderCPUms,
            step: stepCPUms,
            commit: commitCPUms,
            submit: submitCPUms,
            accounting: accountingCPUms,
            finalize: 0,
            renderer: result.cpuBreakdown || null,
          },
          ms: 0,
          bytes: result.uploads || 0,
          draws: result.draws || 0,
          done: !!result.done,
          opening: tileOpeningMode,
          timestamped: !!(timing && result.encoded),
        };
        slices.push(slice);
        if (slices.length > 600) slices.shift();
        let completedJob = null,
          worldStat = null;
        if (result.done && submitted) {
          ring.has[job.slot] = job.k;
          DIAG.tiles++;
          if (world.stats) {
            worldStat = [
              job.sc,
              job.li,
              Math.round(t.ms),
              0,
              Math.round(job.t0),
              Math.round(performance.now()),
              t.frames,
            ];
            world.stats.push(worldStat);
          }
          const completed = GPU_DIAG.tileJobs || (GPU_DIAG.tileJobs = []);
          completedJob = {
            id: result.id,
            era: job.era,
            sc: job.sc,
            li: job.li,
            k: job.k,
            slot: job.slot,
            workerMs: t.ms,
            workerTimings: t.mesh.workerTimings || null,
            frameCPUms: 0,
            frames: t.frames,
            slices: t.slices,
            finished: performance.now(),
            ...tileRenderer.metadata.lastJob,
            productionJobId: job.id,
          };
          completed.push(completedJob);
          if (completed.length > 256) completed.shift();
          tileRenderer.retireCPUViews?.();
          releaseTileDelivery(t.mesh);
          activeMesh = null;
          dispatch();
        }
        const finalizedAt = performance.now(),
          cost = finalizedAt - t0;
        slice.cpuBreakdown.finalize = finalizedAt - finalizeAt;
        slice.ms = cost;
        t.cpu += cost;
        DIAG.up += cost;
        if (cost > DIAG.upMax) DIAG.upMax = cost;
        if (completedJob) completedJob.frameCPUms = t.cpu;
        if (worldStat) worldStat[3] = +t.cpu.toFixed(2);
        return {
          submitted,
          uploadedBytes: result.uploadedBytes || 0,
          estimatedGPUms: result.estimatedGPUms || 0,
          advanced:
            started || submitted || !!result.uploads || !!result.allocationOperations || previousPhase !== result.phase,
        };
      },
      uploadTiles() {
        if (!tileOpeningMode && !activeMesh && !meshQueue.length) updateTileBacklog(performance.now());
        if (activeMesh || meshQueue.length) {
          this.renderMesh();
          return;
        }
      },
      mountains(m) {
        const px = new Uint8ClampedArray(m.Pw * m.Ph * 4);
        for (let y = 0; y < m.Ph; y++)
          for (let x = 0; x < m.Pw; x++) {
            const p = y * m.Pw + x,
              i = ((m.Ph - 1 - y) * m.Pw + x) * 4;
            px[i] = Math.min(255, m.dA[p] * 255);
            px[i + 1] = Math.min(255, m.dB[p] * 255);
            px[i + 3] = 255;
          }
        replaceTex(8, texture(m.Pw, m.Ph, 'mountains'));
        device.queue.writeTexture({ texture: tex[8] }, px, { bytesPerRow: m.Pw * 4 }, [m.Pw, m.Ph]);
        updateBytes();
      },
      setBackgroundResolution(options) {
        resolutionOptions = {
          farScale: options?.farScale,
          midScale: options?.midScale,
          nearScale: options?.nearScale,
          antialias: options?.antialias ?? 'off',
          antialiasRaw: options?.antialias,
        };
        this.resize(baseWidth, baseHeight);
        return GPU_DIAG.backgroundResolution;
      },
      resize(w, h) {
        const targetOptions = {
          ...resolutionOptions,
          farY0: LAYERS[0].y0,
          farY1: LAYERS[0].y1,
          midY0: LAYERS[1].y0,
          midY1: LAYERS[1].y1,
        };
        let next = gpuBackgroundResolution(w, h, targetOptions);
        const fxaaRequested = resolutionOptions.antialias === 'fxaa',
          planned = fxaaRequested
            ? gpuDepthAtlasPlan(
                next,
                device.limits.maxTextureDimension2D,
                device.limits.maxComputeWorkgroupsPerDimension,
              )
            : null;
        const fxaaEnabled = !!(planned?.fits && planned.regions.length);
        if (planned && !planned.fits)
          next = gpuBackgroundResolution(w, h, { ...targetOptions, antialias: 'footprint' });
        fxaaPlan = fxaaEnabled ? planned : null;
        const scale = Math.min(
            devicePixelRatio || 1,
            device.limits.maxTextureDimension2D / innerWidth,
            device.limits.maxTextureDimension2D / innerHeight,
          ),
          cw = Math.round(innerWidth * scale),
          ch = Math.round(innerHeight * scale);
        baseWidth = w;
        baseHeight = h;
        resolution = next;
        const aaMode = fxaaEnabled
          ? 'fxaa'
          : resolutionOptions.antialias === 'footprint' || (planned && !planned.fits)
            ? 'footprint'
            : 'off';
        const farRect = fxaaPlan?.regions.find(r => r.depth === 'far'),
          midRect = fxaaPlan?.regions.find(r => r.depth === 'mid');
        GPU_DIAG.backgroundResolution = {
          schema: 4,
          mode: next.mode,
          policy: 'three-depth-base-near-bands-fxaa-v4',
          allocationOptimization: next.allocationOptimization,
          viewport: { width: innerWidth, height: innerHeight },
          requested: {
            farres: resolutionOptions.farScale == null ? next.farScale : Number(resolutionOptions.farScale),
            midres: resolutionOptions.midScale == null ? next.midScale : Number(resolutionOptions.midScale),
            nearres: resolutionOptions.nearScale == null ? 1 : Number(resolutionOptions.nearScale),
            layeraa: resolutionOptions.antialias ?? 'off',
          },
          raw: {
            farres: resolutionOptions.farScale,
            midres: resolutionOptions.midScale,
            nearres: resolutionOptions.nearScale,
            layeraa: resolutionOptions.antialiasRaw ?? null,
          },
          effective: { farScale: next.farScale, midScale: next.midScale, nearScale: 1, presentationScale: scale },
          base: { width: w, height: h },
          nearRequestNormalized: next.nearRequestNormalized,
          nearPolicy: 'Original base target dimensions are mandatory; non-1 nearres requests are normalized to 1.',
          midDisabledBecauseMono: next.farScale === 0,
          far: {
            allocated: next.farAllocated,
            allocationKind: fxaaEnabled ? 'atlas-region' : next.farAllocated ? 'texture' : 'direct-sample',
            width: next.farWidth,
            height: next.farHeight,
            bytes: fxaaEnabled ? 0 : next.farWidth * next.farHeight * 4,
            regionBytes: next.farWidth * next.farHeight * 4,
            validRect: farRect || null,
            format: 'rgba8unorm',
            layers: [0],
            ...next.farBand,
            contents: 'premultiplied forest ink within base-aligned layer band',
          },
          mid: {
            allocated: next.midAllocated,
            allocationKind: fxaaEnabled ? 'atlas-region' : next.midAllocated ? 'texture' : 'direct-sample',
            width: next.midWidth,
            height: next.midHeight,
            bytes: fxaaEnabled ? 0 : next.midWidth * next.midHeight * 4,
            regionBytes: next.midWidth * next.midHeight * 4,
            validRect: midRect || null,
            format: 'rgba8unorm',
            layers: [1],
            ...next.midBand,
            contents: 'premultiplied forest ink within base-aligned layer band',
          },
          near: {
            width: next.nearWidth,
            height: next.nearHeight,
            bytes: next.nearWidth * next.nearHeight * 4,
            format: 'rgba8unorm',
            layers: [2, 3],
            directForestLayers: [...(!next.farAllocated ? [0] : []), ...(!next.midAllocated ? [1] : [])],
            contents:
              'sky, mountains, full-resolution forest ink, all original inter-layer fog, paper grain, transition wash and finishing',
          },
          filter: {
            mode: next.mode === 'full' ? 'original-single-pass' : aaMode,
            currentAA: next.mode === 'full' ? 'off' : aaMode,
            method:
              aaMode === 'footprint'
                ? 'analytic source-ring pixel footprint over the allocated world band; existing mip LOD plus bounded premultiplied multi-tap integration'
                : 'original source-ring linear sampling; no additional antialiasing',
            maxTapsPerAxis: 8,
            maxTapsPerTexture: 64,
            sourceMipLevels: 1,
            horizontalBoundary: 'periodic sample offsets',
            verticalBoundary: 'transparent sample mask',
            postprocess: 'none',
            far: { active: false },
            mid: { active: false },
          },
          fxaa: {
            requested: fxaaRequested,
            enabled: fxaaEnabled,
            state: fxaaEnabled
              ? 'active'
              : planned && !planned.fits
                ? 'fallback'
                : fxaaRequested
                  ? 'skipped'
                  : 'disabled',
            reason: fxaaEnabled ? null : planned?.reason || 'not-requested',
            fallback: planned && !planned.fits ? (next.mode === 'full' ? 'original-single-pass' : 'footprint') : null,
            atlas: {
              width: fxaaPlan?.width || 0,
              height: fxaaPlan?.height || 0,
              gutter: planned?.gutter || 1,
              packing: fxaaPlan?.packing || null,
              inputBytes: fxaaEnabled ? planned.width * planned.height * 4 : 0,
              outputBytes: fxaaEnabled ? planned.width * planned.height * 4 : 0,
              regions: fxaaPlan?.regions || [],
            },
            compute: {
              passCount: fxaaEnabled ? 1 : 0,
              workgroupSize: [8, 8, 1],
              workgroups: fxaaPlan?.workgroups || [0, 0, 0],
              regionTableBytes: 48,
              maxTextureReads: 9,
            },
            edgeSignal: 'premultiplied ink over white paper plus 0.125 opacity term',
            minContrast: 1 / 255,
            relativeContrast: 0.125,
            maxSpanPixels: 4,
            regionBoundary: 'clamp each region at its pixel centres; transparent outside world band',
            partition: 'near samples the output atlas by each valid rect; no copyback',
          },
          presentation: { width: cw, height: ch, bytes: cw * ch * 4 },
          timestampScope:
            'backgroundFar, backgroundMid, backgroundFXAA and backgroundNear are individual pass durations; background spans the first depth pass through near, including FXAA and gaps; total spans background through scene/UI, excluding earlier particle compute and independent tile submissions',
        };
        if (fxaaEnabled) {
          GPU_DIAG.backgroundResolution.filter.method =
            'FXAA over premultiplied depth atlas; source rings use original single-tap sampling';
          GPU_DIAG.backgroundResolution.filter.postprocess = 'fxaa';
        }
        if (next.farAllocated) {
          filterValues.set([
            next.farWidth,
            next.farHeight,
            next.nearWidth,
            next.farBand.baseBounds.height,
            next.farBand.coverage.worldY0,
            next.farBand.coverage.worldY1,
            0,
            0,
            aaMode === 'footprint' ? 1 : 0,
            0,
            0,
            0,
          ]);
          device.queue.writeBuffer(farFilterUniform, 0, filterValues);
        }
        if (next.midAllocated) {
          filterValues.set([
            next.midWidth,
            next.midHeight,
            next.nearWidth,
            next.midBand.baseBounds.height,
            next.midBand.coverage.worldY0,
            next.midBand.coverage.worldY1,
            0,
            0,
            aaMode === 'footprint' ? 1 : 0,
            0,
            0,
            0,
          ]);
          device.queue.writeBuffer(midFilterUniform, 0, filterValues);
        }
        nearDepthValues.set([
          next.farBand.coverage.worldY0,
          next.farBand.coverage.worldY1,
          next.farAllocated ? 1 : 0,
          0,
          next.midBand.coverage.worldY0,
          next.midBand.coverage.worldY1,
          next.midAllocated ? 1 : 0,
          0,
          fxaaEnabled ? farRect.x / planned.width : 0,
          fxaaEnabled ? farRect.y / planned.height : 0,
          fxaaEnabled ? farRect.width / planned.width : 1,
          fxaaEnabled ? farRect.height / planned.height : 1,
          fxaaEnabled ? midRect.x / planned.width : 0,
          fxaaEnabled ? midRect.y / planned.height : 0,
          fxaaEnabled ? midRect.width / planned.width : 1,
          fxaaEnabled ? midRect.height / planned.height : 1,
        ]);
        device.queue.writeBuffer(nearDepthUniform, 0, nearDepthValues);
        if (fxaaEnabled) {
          fxaaRegionValues.fill(0);
          fxaaRegionValues.set([planned.regions.length, planned.width, planned.height, 0]);
          planned.regions.forEach((r, i) => fxaaRegionValues.set([r.x, r.y, r.width, r.height], 4 + i * 4));
          device.queue.writeBuffer(fxaaRegionUniform, 0, fxaaRegionValues);
        }
        if (
          intermediate &&
          width === next.nearWidth &&
          height === next.nearHeight &&
          farWidth === next.farWidth &&
          farHeight === next.farHeight &&
          midWidth === next.midWidth &&
          midHeight === next.midHeight &&
          !!fxaaInputTarget === fxaaEnabled &&
          (!fxaaEnabled || (fxaaInputTarget.width === planned.width && fxaaInputTarget.height === planned.height)) &&
          canvas.width === cw &&
          canvas.height === ch
        ) {
          GPU_DIAG.backgroundTargetReuses = (GPU_DIAG.backgroundTargetReuses || 0) + 1;
          return;
        }
        width = next.nearWidth;
        height = next.nearHeight;
        farWidth = next.farWidth;
        farHeight = next.farHeight;
        midWidth = next.midWidth;
        midHeight = next.midHeight;
        canvas.width = cw;
        canvas.height = ch;
        GPU_DIAG.backgroundTargetCreates = (GPU_DIAG.backgroundTargetCreates || 0) + 1;
        presentationGeneration++;
        first = true;
        validated = false;
        presented = false;
        intermediate?.destroy();
        farTarget?.destroy();
        midTarget?.destroy();
        farTarget = null;
        farView = null;
        midTarget = null;
        midView = null;
        nearBinding = null;
        fxaaInputTarget?.destroy();
        fxaaOutputTarget?.destroy();
        fxaaInputTarget = null;
        fxaaInputView = null;
        fxaaOutputTarget = null;
        fxaaOutputView = null;
        fxaaBinding = null;
        intermediate = texture(width, height, 'base-resolution near scenery');
        intermediateView = intermediate.createView();
        if (fxaaEnabled) {
          fxaaInputTarget = atlasTexture(planned.width, planned.height, 'depth FXAA input atlas', false);
          fxaaInputView = fxaaInputTarget.createView();
          fxaaOutputTarget = atlasTexture(planned.width, planned.height, 'depth FXAA output atlas', true);
          fxaaOutputView = fxaaOutputTarget.createView();
        } else {
          if (farWidth) {
            farTarget = texture(farWidth, farHeight, 'far forest ink band');
            farView = farTarget.createView();
          }
          if (midWidth) {
            midTarget = texture(midWidth, midHeight, 'mid forest ink band');
            midView = midTarget.createView();
          }
        }
        presentBinding = device.createBindGroup({
          layout: finalPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: intermediateView },
          ],
        });
        updateBytes();
      },
      prepareStartupRenderers() {
        if (startupRenderersTask) return startupRenderersTask;
        const constructionScope = { active: true },
          timing = {
            mode: 'parallel-common-validation',
            started: performance.now(),
            ended: null,
            wallMs: null,
            jobs: [],
          };
        GPU_DIAG.rendererPreparation = timing;
        startupRenderersTask = (async () => {
          device.pushErrorScope('validation');
          let settled, validation, scopeFailure;
          const task = (name, operation) => {
            const item = { name, start: performance.now(), end: null, status: 'running' };
            timing.jobs.push(item);
            return Promise.resolve()
              .then(operation)
              .then(
                value => {
                  item.end = performance.now();
                  item.status = 'completed';
                  return value;
                },
                error => {
                  item.end = performance.now();
                  item.status = 'failed';
                  throw error;
                },
              );
          };
          try {
            settled = await Promise.allSettled([
              task('particles', () => (particles ? null : api.prepareParticles(null, constructionScope))),
              task('text', () => textRenderer || api.prepareText(constructionScope)),
              task('ui', () => uiRenderer || api.prepareUI(constructionScope)),
            ]);
          } finally {
            try {
              validation = await device.popErrorScope();
            } catch (error) {
              scopeFailure = error;
            }
            constructionScope.active = false;
            timing.ended = performance.now();
            timing.wallMs = timing.ended - timing.started;
          }
          const rejected = settled.find(item => item.status === 'rejected');
          if (rejected) throw rejected.reason;
          if (scopeFailure) throw scopeFailure;
          if (validation) throw Error('WebGPU startup renderer validation: ' + validation.message);
          if (broken || disposed) throw Error('Startup renderer preparation was cancelled');
          return { text: textRenderer, ui: uiRenderer };
        })();
        startupRenderersTask.catch(() => {});
        return startupRenderersTask;
      },
      async prepareParticles(spr, constructionScope) {
        const made = await createGPUParticles(device, format, { motion: 'compute', constructionScope });
        try {
          await made.prepareGPU({ rng, rr, inkLeaf, petalPath });
          if (broken || disposed) throw Error('Particle preparation was cancelled');
          particles = made;
          GPU_DIAG.particles = made.metadata;
          updateBytes();
        } catch (e) {
          made.dispose();
          throw e;
        }
      },
      stepParticles(frame) {
        if (!particles || particles.metadata.motion !== 'compute') return false;
        const shape = transShape();
        particles.step(drift, {
          dt: frame.dt,
          gust: frame.gust,
          pan: frame.pan,
          rect: frame.rect,
          blend: { D: frame.page.D, t: frame.page.t, ...shape },
        });
        if (GPU_UI.enabled)
          particles.step(boxDrift, {
            dt: frame.dt,
            gust: 1,
            pan: 0,
            blend: { D: frame.box.D, t: frame.box.t, ...shape },
            key: 'ui-box',
          });
        return true;
      },
      restoreParticles() {
        particles?.restoreCPU();
      },
      async prepareText(constructionScope) {
        await glyphManifest();
        const created = await createGPUText(device, format, {
          paperWGSL: GPU_TEXT_PAPER,
          paperLayout,
          paperBindGroup,
          glyphPreparation,
          constructionScope,
        });
        if (broken || disposed) {
          created.dispose();
          throw new Error('Text preparation was cancelled');
        }
        textRenderer = created;
        GPU_DIAG.text = textRenderer.metadata;
        updateBytes();
        return textRenderer;
      },
      setTextFrame(frame) {
        textFrame = frame;
      },
      async prepareUI(constructionScope) {
        await glyphManifest();
        const created = await createGPUUI(device, format, {
          paperWGSL: GPU_TEXT_PAPER,
          paperLayout,
          paperBindGroup,
          paperValue: () => textFrame?.paperValue,
          rng,
          rr,
          samplePath,
          brush,
          periodicNoise,
          glyphPreparation,
          startup: GPU_STARTUP,
          constructionScope,
          afterSubmit: action => {
            if (sharedEncoder) afterShared.push(action);
            else action();
          },
        });
        if (broken || disposed) {
          created.dispose();
          throw new Error('UI preparation was cancelled');
        }
        uiRenderer = created;
        GPU_DIAG.ui = created.metadata;
        updateBytes();
        return created;
      },
      setUIFrame(frame) {
        if (frame && !uiFrame) {
          first = true;
          validated = false;
        }
        uiFrame = frame;
      },
      finish() {
        return device.queue.onSubmittedWorkDone();
      },
      beginFrame() {
        if (sharedEncoder) flushShared();
        sharing = true;
      },
      endFrame() {
        sharing = false;
        flushShared();
      },
      get frameRoom() {
        return !broken && !disposed;
      },
      debugPresentationSnapshot() {
        return { textureCount: 0, mode: 'direct' };
      },
      presentFrame() {
        return false;
      },
      render(s) {
        if (broken || disposed || !tex[8] || !tex[9]) return;
        this.presentFrame();
        let sceneSubmitted = false;
        try {
          const frameStart = performance.now();
          const check = first,
            checkGeneration = presentationGeneration;
          if (check) {
            first = false;
            frameScope = true;
            device.pushErrorScope('validation');
          }
          const fxaaActive = !!fxaaInputTarget,
            hasFar = !!farTarget || (fxaaActive && resolution.farAllocated),
            hasMid = !!midTarget || (fxaaActive && resolution.midAllocated),
            split = hasFar || hasMid;
          if (!binding) binding = device.createBindGroup({ layout: backgroundLayout, entries: entries() });
          if (hasFar && !farBinding)
            farBinding = device.createBindGroup({
              layout: layerLayout,
              entries: [...entries(), { binding: 14, resource: { buffer: farFilterUniform } }],
            });
          if (hasMid && !midBinding)
            midBinding = device.createBindGroup({
              layout: layerLayout,
              entries: [...entries(), { binding: 14, resource: { buffer: midFilterUniform } }],
            });
          if (split && !nearBinding)
            nearBinding = device.createBindGroup({
              layout: nearLayout,
              entries: [
                ...entries(),
                { binding: 13, resource: fxaaActive ? fxaaOutputView : farView || texViews[0] },
                { binding: 14, resource: fxaaActive ? fxaaOutputView : midView || texViews[1] },
                { binding: 15, resource: { buffer: nearDepthUniform } },
              ],
            });
          if (fxaaActive && !fxaaBinding)
            fxaaBinding = device.createBindGroup({
              layout: fxaaLayout,
              entries: [
                { binding: 0, resource: fxaaInputView },
                { binding: 1, resource: fxaaOutputView },
                { binding: 2, resource: { buffer: fxaaRegionUniform } },
                { binding: 3, resource: sampler },
              ],
            });
          const vw = s.view,
            ts = transShape();
          if (split) {
            const f = GPU_DIAG.backgroundResolution.filter,
              enabled = f.mode === 'footprint';
            if (hasFar)
              gpuLayerFilterStats(
                f.far,
                tex[0],
                vw.sc[0],
                LAYERS[0].y0,
                LAYERS[0].y1,
                farWidth,
                farHeight,
                width,
                resolution.farBand.baseBounds.height,
                enabled,
                resolution.farBand.coverage.worldSpan,
              );
            if (hasMid)
              gpuLayerFilterStats(
                f.mid,
                tex[1],
                vw.sc[1],
                LAYERS[1].y0,
                LAYERS[1].y1,
                midWidth,
                midHeight,
                width,
                resolution.midBand.baseBounds.height,
                enabled,
                resolution.midBand.coverage.worldSpan,
              );
          }
          put1('uAsp', world.W / world.H);
          put1('uDpr', s.dpr);
          put1('uTime', s.time);
          put1('uT', s.t);
          put1('uD', s.D);
          put1('uVeil', s.veil);
          put1('uSway', s.sway);
          putAll('uSc', vw.sc);
          putAll('uOf', vw.of);
          putAll('uN1', vw.n1);
          putAll('uN3', vw.n3);
          put2('uMS', vw.ms, vw.ms);
          putAll('uMO', vw.mo);
          put2('uMouse', s.mx, s.my);
          {
            const y0 = offsets.uY0,
              y1 = offsets.uY1,
              lag = offsets.uLag;
            for (let i = 0; i < LAYERS.length; i++) {
              const L = LAYERS[i];
              values[y0 + i] = L.y0;
              values[y1 + i] = L.y1;
              values[lag + i] = L.lag * TRANS.lag;
            }
          }
          put2('uMY', MTN.y0, MTN.y1);
          putAll('uMark', world.mark);
          putAll('uRead', world.read);
          {
            const o = offsets.uMsk;
            values[o] = ts.F;
            values[o + 1] = ts.J;
            values[o + 2] = ts.L;
            values[o + 3] = TRANS.dip;
          }
          put2('uSize', width, height);

          device.queue.writeBuffer(uniform, 0, values);
          const q = frameN++ % 12 === 0 ? timings.find(x => !x.busy) : null;
          if (q) q.busy = true;
          if (sharedEncoder) flushShared();
          const e =
            sharing && !check
              ? (sharedEncoder = device.createCommandEncoder({ label: 'frame' }))
              : device.createCommandEncoder({ label: 'scene frame' });
          if (particles) {
            if (!particleSets || particleSets[0][0].drift !== drift || particleSets[1][1].drift !== boxDrift)
              particleSets = [[{ drift }], [{ drift }, { drift: boxDrift, key: 'ui-box' }]];
            particles.encode(e, particleSets[GPU_UI.enabled ? 1 : 0]);
          }
          let p;
          const combinedDepth = fxaaActive && hasFar && hasMid;
          if (combinedDepth) {
            p = e.beginRenderPass({
              label: 'far + mid forest atlas',
              colorAttachments: [{ view: fxaaInputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
              ...stamp(q, 0, 1),
            });
            let r = fxaaPlan.farRegion;
            p.setViewport(r.x, r.y, r.width, r.height, 0, 1);
            p.setScissorRect(r.x, r.y, r.width, r.height);
            p.setPipeline(farPipeline);
            p.setBindGroup(0, farBinding);
            p.draw(3);
            r = fxaaPlan.midRegion;
            p.setViewport(r.x, r.y, r.width, r.height, 0, 1);
            p.setScissorRect(r.x, r.y, r.width, r.height);
            p.setPipeline(midPipeline);
            p.setBindGroup(0, midBinding);
            p.draw(3);
            p.end();
          } else {
            if (hasFar) {
              p = e.beginRenderPass({
                label: 'far forest',
                colorAttachments: [
                  {
                    view: fxaaActive ? fxaaInputView : farView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                  },
                ],
                ...stamp(q, 0, 1),
              });
              if (fxaaActive) {
                const r = fxaaPlan.farRegion;
                p.setViewport(r.x, r.y, r.width, r.height, 0, 1);
                p.setScissorRect(r.x, r.y, r.width, r.height);
              }
              p.setPipeline(farPipeline);
              p.setBindGroup(0, farBinding);
              p.draw(3);
              p.end();
            }
            if (hasMid) {
              p = e.beginRenderPass({
                label: 'mid forest',
                colorAttachments: [
                  {
                    view: fxaaActive ? fxaaInputView : midView,
                    loadOp: fxaaActive && hasFar ? 'load' : 'clear',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                  },
                ],
                ...stamp(q, 2, 3),
              });
              if (fxaaActive) {
                const r = fxaaPlan.midRegion;
                p.setViewport(r.x, r.y, r.width, r.height, 0, 1);
                p.setScissorRect(r.x, r.y, r.width, r.height);
              }
              p.setPipeline(midPipeline);
              p.setBindGroup(0, midBinding);
              p.draw(3);
              p.end();
            }
          }
          if (fxaaActive) {
            p = e.beginComputePass({ label: 'far + mid atlas FXAA', ...stamp(q, 10, 11) });
            p.setPipeline(fxaaPipeline);
            p.setBindGroup(0, fxaaBinding);
            p.dispatchWorkgroups(...fxaaPlan.workgroups);
            p.end();
          }
          p = e.beginRenderPass({
            label: split ? 'near scenery' : 'background',
            colorAttachments: [{ view: intermediateView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            ...stamp(q, 4, 5),
          });
          p.setPipeline(split ? nearPipeline : pipeline);
          p.setBindGroup(0, split ? nearBinding : binding);
          p.draw(3);
          p.end();
          const sceneTexture = context.getCurrentTexture(),
            sceneView = textureAsView ? sceneTexture : sceneTexture.createView();
          p = e.beginRenderPass({
            label: 'present + particles + line',
            colorAttachments: [{ view: sceneView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            ...stamp(q, 6, 7),
          });
          p.setPipeline(finalPipeline);
          p.setBindGroup(0, presentBinding);
          p.draw(3);
          if (particles) particles.draw(p, drift, LAB.drift ? 1 : 0, world.W, world.H);
          if (textRenderer && textFrame && GPU_LINE.enabled) textRenderer.draw(p, textFrame);
          p.end();
          const uiActive = !!(uiRenderer && uiFrame && GPU_UI.enabled);
          if (uiActive) {
            uiEncodeOptions.sceneTexture = sceneTexture;
            uiEncodeOptions.textureAsView = textureAsView;
            uiRenderer.encode(e, uiFrame, uiEncodeOptions);
            uiEncodeOptions.sceneTexture = null;
            p = e.beginRenderPass({
              label: 'UI overlay',
              colorAttachments: [{ view: sceneView, loadOp: 'load', storeOp: 'store' }],
              ...stamp(q, 8, 9),
            });
            uiRenderer.draw(p, uiFrame);
            p.end();
          }
          let frameBytesChanged = false;
          if (particles && GPU_DIAG.bytes.particles !== particles.metadata.byteCount) {
            GPU_DIAG.bytes.particles = particles.metadata.byteCount;
            frameBytesChanged = true;
          }
          if (textRenderer && GPU_DIAG.bytes.text !== textRenderer.metadata.byteCount) {
            GPU_DIAG.bytes.text = textRenderer.metadata.byteCount;
            frameBytesChanged = true;
          }
          if (uiRenderer && GPU_DIAG.bytes.ui !== uiRenderer.metadata.byteCount) {
            GPU_DIAG.bytes.ui = uiRenderer.metadata.byteCount;
            frameBytesChanged = true;
          }
          if (frameBytesChanged)
            GPU_DIAG.resourcePeak = Math.max(
              GPU_DIAG.resourcePeak || 0,
              Object.values(GPU_DIAG.bytes).reduce((a, b) => a + b, 0),
            );
          const queryStart = hasFar ? 0 : hasMid ? 2 : 4;
          if (q) {
            const count = (fxaaActive ? 12 : uiActive ? 10 : 8) - queryStart;
            e.resolveQuerySet(q.q, queryStart, count, q.resolve, 0);
            e.copyBufferToBuffer(q.resolve, 0, q.read, 0, count * 8);
          }
          if (e !== sharedEncoder) device.queue.submit([e.finish()]);
          sceneSubmitted = true;
          const gpuSegment = frameDiagnostics?.segment;
          frameDiagnostics?.markRenderSubmit(performance.now());
          if (textRenderer && textFrame && GPU_LINE.enabled) GPU_LINE.ack(textFrame);
          if (uiActive) GPU_UI.ack(uiFrame);
          if (q)
            afterSubmit(e, () => {
              q.read
                .mapAsync(GPUMapMode.READ)
                .then(() => {
                  const t = new BigUint64Array(q.read.getMappedRange());
                  GPU_DIAG.timings = gpuBackgroundTimings(
                    t,
                    queryStart,
                    hasFar,
                    hasMid,
                    uiActive,
                    fxaaActive,
                    combinedDepth,
                  );
                  sceneGPUms = sceneGPUms ? sceneGPUms * 0.8 + GPU_DIAG.timings.total * 0.2 : GPU_DIAG.timings.total;
                  frameDiagnostics?.recordGPUms(GPU_DIAG.timings.total, gpuSegment);
                  if (SITE_DEBUG) GPU_DIAG.samples.push({ ...GPU_DIAG.timings, frameStart, time: performance.now() });
                  if (GPU_DIAG.samples.length > 600) GPU_DIAG.samples.shift();
                  q.read.unmap();
                  q.busy = false;
                })
                .catch(e => {
                  q.busy = false;
                  if (!disposed) fail(e);
                });
            });
          if (check) {
            frameScope = false;
            Promise.all([device.popErrorScope(), device.queue.onSubmittedWorkDone()])
              .then(([err]) => {
                if (err) throw err;
                if (broken || disposed || checkGeneration !== presentationGeneration) return;
                validated = true;
                presented = true;
                if (presented && canvas.style) canvas.style.visibility = '';
                GPU_DIAG.state = tileRenderer
                  ? 'WebGPU / stage 2 tiles'
                  : GPU_UI.enabled
                    ? 'WebGPU / stage 4 UI'
                    : GPU_LINE.enabled
                      ? 'WebGPU / stage 3 text'
                      : 'WebGPU / stage 1';
              })
              .catch(fail);
          }
          return true;
        } finally {
          if (!sceneSubmitted) {
            sharedEncoder = null;
            afterShared.length = 0;
          }
        }
      },
      async ringPixels(sc, li) {
        const t = tex[unitOf(sc, li)],
          bpr = Math.ceil((t.width * 4) / 256) * 256,
          b = device.createBuffer({ size: bpr * t.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const e = device.createCommandEncoder();
          e.copyTextureToBuffer({ texture: t }, { buffer: b, bytesPerRow: bpr }, [t.width, t.height]);
          device.queue.submit([e.finish()]);
          await b.mapAsync(GPUMapMode.READ);
          const src = new Uint8Array(b.getMappedRange()),
            dst = new Uint8Array(t.width * t.height * 4);
          for (let y = 0; y < t.height; y++) dst.set(src.subarray(y * bpr, y * bpr + t.width * 4), y * t.width * 4);
          return dst;
        } finally {
          if (b.mapState === 'mapped') b.unmap();
          b.destroy();
        }
      },
      async ringHash(sc, li) {
        return hashBytes(await this.ringPixels(sc, li));
      },
      async debugTilePixels(sc, li, slot) {
        if (!SITE_DEBUG || !HASH.includes('debug')) throw Error('Tile readback requires #debug');
        const p = ringPhysical[li],
          t = tex[unitOf(sc, li)];
        if (!p || !t || !Number.isInteger(slot) || slot < 0 || slot >= p.slots) throw Error('Invalid debug tile slot');
        const width = p.outputWidth,
          height = p.outputHeight,
          bpr = Math.ceil((width * 4) / 256) * 256;
        const b = device.createBuffer({
          label: 'debug single tile readback',
          size: bpr * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const e = device.createCommandEncoder({ label: 'debug single tile copy' });
          e.copyTextureToBuffer({ texture: t, origin: [slot * width, 0] }, { buffer: b, bytesPerRow: bpr }, [
            width,
            height,
          ]);
          device.queue.submit([e.finish()]);
          await b.mapAsync(GPUMapMode.READ);
          const src = new Uint8Array(b.getMappedRange()),
            pixels = new Uint8Array(width * height * 4);
          for (let y = 0; y < height; y++) {
            const row = (height - 1 - y) * bpr;
            pixels.set(src.subarray(row, row + width * 4), y * width * 4);
          }
          return { width, height, pixels, format: 'rgba8unorm', alpha: 'premultiplied', rowOrder: 'top-to-bottom' };
        } finally {
          if (b.mapState === 'mapped') b.unmap();
          b.destroy();
        }
      },
      abandon() {
        broken = true;
        tileGate.stop();
        clearUploads();
        tileRenderer?.dispose();
        if (uiRenderer?.metadata.atlasHandoffEnabled) uiRenderer.dispose();
        glyphPreparation.dispose();
        GPU_DIAG.tileAbandoned = true;
        updateBytes();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        tileGate.stop();
        clearUploads();
        tileRenderer?.dispose();
        uiRenderer?.dispose();
        textRenderer?.dispose();
        glyphPreparation.dispose();
        particles?.dispose();
        for (const t of tex) t?.destroy();
        intermediate?.destroy();
        farTarget?.destroy();
        midTarget?.destroy();
        fxaaInputTarget?.destroy();
        fxaaOutputTarget?.destroy();
        uniform.destroy();
        farFilterUniform.destroy();
        midFilterUniform.destroy();
        nearDepthUniform.destroy();
        fxaaRegionUniform.destroy();
        for (const q of [...timings, ...tileTimings]) {
          q.q.destroy();
          q.resolve.destroy();
          q.read.destroy();
        }
        context.unconfigure();
        device.destroy();
      },
    };
    for (const name of [
      'statics',
      'alloc',
      'uploadTiles',
      'renderMesh',
      'mountains',
      'resize',
      'setBackgroundResolution',
      'setTileOpeningMode',
      'presentFrame',
      'render',
    ]) {
      const impl = api[name];
      api[name] = function (...args) {
        if (broken || disposed) return;
        try {
          return impl.apply(this, args);
        } catch (e) {
          if (frameScope) {
            frameScope = false;
            device.popErrorScope().catch(() => {});
          }
          fail(e);
        }
      };
    }
    GPU_DIAG.state = 'validating first frame';
    return api;
  } catch (e) {
    if (initializationScope) {
      try {
        await device.popErrorScope();
      } catch {}
      initializationScope = false;
    }
    if (!attempt.expired) {
      GPU_DIAG.error = String(e.message || e);
      GPU_DIAG.state = 'failed';
    }
    disposed = true;
    context?.unconfigure();
    device?.destroy();
    return null;
  }
}
