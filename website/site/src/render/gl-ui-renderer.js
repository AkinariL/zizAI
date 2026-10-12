async function createGLUI(gl, canvasFormat = 'rgba8', shared = {}) {
  if (!gl || typeof gl.drawArraysInstanced !== 'function') throw Error('GL UI requires a WebGL2 context');
  for (const name of ['rng', 'rr', 'samplePath', 'brush', 'periodicNoise'])
    if (typeof shared?.[name] !== 'function') throw Error('GL UI requires ' + name);
  const C = GLTextUICommon,
    clamp = C.clamp,
    finite = C.finite;
  const metadata = {
    backend: 'webgl2-ui',
    ready: false,
    preparing: false,
    generation: 0,
    prepareCount: 0,
    prepareCompleted: 0,
    glyphRasterizations: 0,
    glyphUploads: 0,
    glyphCount: 0,
    runCount: 0,
    atlasWidth: 0,
    atlasHeight: 0,
    atlasFormat: 'rgba8',
    filterFormat: 'rgba8',
    atlasBytes: 0,
    assetBytes: 0,
    groupBytes: 0,
    roiBytes: 0,
    bufferBytes: 0,
    instanceCPUBytes: 0,
    temporaryBytes: 0,
    byteCount: 0,
    peakBytes: 0,
    cpuGlyphBytes: 0,
    instances: 0,
    roiWidth: 0,
    roiHeight: 0,
    groupWidth: 0,
    groupHeight: 0,
    groupAllocations: 0,
    allocations: 0,
    warnings: [],
    floatFBO: false,
    atlasHandoffEnabled: typeof createUIAtlasHandoff === 'function' && shared.atlasHandoffEnabled !== false,
    filters: {
      backdropSigmaCss: 16,
      backdropTexelsPerCss: 0.5,
      backdropPaddingCss: 48,
      gaussianExtent: 3,
      slogan: 'clear / sigma 7 crossfade',
      shadow: 'analytic Gaussian rectangle',
      grain: 'seeded CPU texture from shared plans',
    },
  };
  const glyphClient = shared.glyphPreparation?.acquire('ui'),
    sealClient = shared.glyphPreparation?.acquire('seal');
  if (glyphClient) metadata.preparation = glyphClient.metadata;
  if (sealClient) metadata.sealPreparation = sealClient.metadata;
  const paperNames = [
    'uAsp',
    'uDpr',
    'uTime',
    'uT',
    'uD',
    'uVeil',
    'uN1',
    'uN3',
    'uLag',
    'uMsk',
    'uRead',
    'uMark',
    'uMS',
    'uMO',
    'uMY',
    'uMouse',
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
    'uMtn',
    'uPN',
  ];
  const paperLocations = Object.create(null),
    paperSource =
      typeof shared.paperGLSL === 'string' && shared.paperGLSL
        ? shared.paperGLSL
        : `vec3 textPaperAt(vec2 cssPosition,vec2 viewportCss,float paperValue){return vec3(.82);}`;
  const assets = { glyph: null, swash: null, seal: null, grain: null },
    slots = new Map();
  let disposed = false,
    installed = null,
    prepareQueue = Promise.resolve(),
    group = null,
    roi = null,
    encoded = null;
  let drawProgram = null,
    blurProgram = null,
    candidateProgram = null,
    samplerSlot = null;
  const uiVertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 aRect;layout(location=1) in vec4 aUV;layout(location=2) in vec4 aColour;
layout(location=3) in vec4 aColour2;layout(location=4) in vec4 aParams;layout(location=5) in vec4 aAux;layout(location=6) in vec4 aShape;
uniform vec4 uViewport;
out vec2 vPoint;out vec2 vUV;out vec4 vColour;out vec4 vColour2;out vec4 vParams;out vec4 vAux;out vec4 vShape;
void main(){const vec2 p[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));vec2 q=aRect.xy+p[gl_VertexID]*aRect.zw;
gl_Position=vec4((q.x-uViewport.z)/uViewport.x*2.0-1.0,1.0-(q.y-uViewport.w)/uViewport.y*2.0,0.0,1.0);
vPoint=q;vUV=aUV.xy+p[gl_VertexID]*aUV.zw;vColour=aColour;vColour2=aColour2;vParams=aParams;vAux=aAux;vShape=aShape;}`;
  const uiFragment = `#version 300 es
precision highp float;
${paperSource}
in vec2 vPoint;in vec2 vUV;in vec4 vColour;in vec4 vColour2;in vec4 vParams;in vec4 vAux;in vec4 vShape;
uniform vec4 uViewport;uniform float uPaperValue;
uniform sampler2D uGlyph;uniform sampler2D uSwash;uniform sampler2D uSeal;uniform sampler2D uGroup;
out vec4 outColor;
float uiDistance(vec2 p,vec4 b,float r){vec2 q=abs(p-b.xy-b.zw*.5)-(b.zw*.5-vec2(r));return length(max(q,vec2(0)))+min(max(q.x,q.y),0.0)-r;}
float uiErf(float v){float x=abs(v);float t=1.0/(1.0+.3275911*x);float q=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t;return sign(v)*(1.0-q*exp(-x*x));}
float uiCDF(float v){return .5+.5*uiErf(v*.7071067811865476);}
vec4 uiOver(vec4 f,vec4 b){return f+b*(1.0-f.a);}
void main(){int kind=int(floor(vParams.x+.5));float a=1.0;vec3 rgb=vColour.rgb;vec4 pixel=vec4(0);float aa=max(.0001,vAux.w);
vec2 uvPerCss=vec2(abs(dFdx(vUV.x))/max(.00001,abs(dFdx(vPoint.x))),abs(dFdy(vUV.y))/max(.00001,abs(dFdy(vPoint.y))));
if(kind==0){vec4 m=texture(uGlyph,vUV);a=mix(m.r,m.g,vParams.z);
 if(vParams.w>0.0&&m.g>.008){vec2 reach=vParams.w*uvPerCss;float far=0.0;float rim=m.r;
  for(int k=0;k<12;k++){float turn=float(k)*.5235988;vec2 dir=vec2(cos(turn),sin(turn))*reach;far=max(far,texture(uGlyph,vUV+dir).r);if((k&1)==0)rim=max(rim,.62*texture(uGlyph,vUV+dir*.45).r);}
  if(max(rim,far)>.002){for(int k=0;k<12;k++){float turn=float(k)*.5235988;vec2 dir=vec2(cos(turn),sin(turn))*reach;vec2 skew=vec2(dir.x*.9659258-dir.y*.2588190,dir.x*.2588190+dir.y*.9659258);rim=max(rim,texture(uGlyph,vUV+skew*.26).r);rim=max(rim,.62*texture(uGlyph,vUV+skew*.45).r);rim=max(rim,.36*texture(uGlyph,vUV+dir*.62).r);rim=max(rim,.15*texture(uGlyph,vUV+skew*.8).r);}}
  rim=max(rim,.03*far);float inkA=a*vColour.a*vParams.y;float rimA=rim*vColour2.x*vParams.y*(1.0-vParams.z);if(max(inkA,rimA)<.00001)discard;
  vec3 paper=mix(textPaperAt(vPoint-uViewport.zw,uViewport.xy,vColour2.z),vec3(1.0),vColour2.y);outColor=vec4(vColour.rgb*inkA+paper*rimA*(1.0-inkA),inkA+rimA*(1.0-inkA));return;
 }
}
else if(kind==3){a=texture(uSwash,vUV).a;}
else if(kind==4){pixel=texture(uSeal,vUV);outColor=pixel*vParams.y;return;}
else if(kind==5){float m=clamp(.5-uiDistance(vPoint,vShape,vParams.w)/aa,0.0,1.0);outColor=texture(uGroup,vUV)*(m*vParams.y);return;}
else if(kind==6){vec2 lo=(vPoint-vShape.xy)/vParams.z;vec2 hi=(vPoint-vShape.xy-vShape.zw)/vParams.z;a=max(0.0,(uiCDF(lo.x)-uiCDF(hi.x))*(uiCDF(lo.y)-uiCDF(hi.y)));if(vAux.z<0.0){float boxMask=clamp(.5-uiDistance(vPoint,vColour2,vParams.w)/aa,0.0,1.0);a*=1.0-boxMask;}}
else {float d=uiDistance(vPoint,vShape,min(vParams.w,min(vShape.z,vShape.w)*.5));a=clamp(.5-d/aa,0.0,1.0);if(vAux.z>0.0)a*=clamp(.5+(d+vAux.z)/aa,0.0,1.0);if(kind==2){float t=clamp((vPoint.x-vShape.x)/max(.0001,vShape.z),0.0,1.0);float mixv=clamp((t-vAux.x)/max(.0001,vAux.y-vAux.x),0.0,1.0);vec4 c=mix(vColour,vColour2,mixv);rgb=c.rgb;a*=c.a;}}
if(kind!=2)a*=vColour.a;a*=vParams.y;if(a<.00001)discard;outColor=vec4(rgb*a,a);}`;
  const blurFragment = `#version 300 es
precision highp float;in vec2 vUv;out vec4 outColor;uniform sampler2D uSource;uniform vec4 uRegion;uniform vec2 uScreenCss;uniform vec2 uAxis;uniform float uSigma;uniform float uMode;
void main(){if(uMode<.5){vec2 css=vec2(uRegion.x+vUv.x*uRegion.z,uRegion.y+(1.0-vUv.y)*uRegion.w);vec2 uv=vec2(css.x/uScreenCss.x,1.0-css.y/uScreenCss.y);outColor=texture(uSource,clamp(uv,vec2(0),vec2(1)));return;}
float sigma=uSigma;if(sigma<.08){outColor=texture(uSource,vUv);return;}int extent=min(96,int(ceil(3.0*sigma)));float inv=.5/(sigma*sigma);vec4 total=texture(uSource,vUv);float weight=1.0;
for(int j=1;j<=96;j+=2){if(j>extent)break;float first=exp(-float(j*j)*inv);float second=0.0;if(j+1<=extent)second=exp(-float((j+1)*(j+1))*inv);float w=first+second;float offset=float(j)+second/max(w,1e-20);total+=(texture(uSource,vUv+uAxis*offset)+texture(uSource,vUv-uAxis*offset))*w;weight+=2.0*w;}
outColor=total/weight;}`;
  const candidateFragment = `#version 300 es
precision highp float;in vec2 vUv;out vec4 outColor;uniform vec4 uExtent;uniform vec4 uScreen;uniform vec4 uRegion;uniform vec4 uGlass;uniform vec4 uOutside;uniform vec4 uInside;uniform vec4 uTint;uniform vec4 uEdge;uniform vec2 uRoiExtent;uniform sampler2D uRoi;uniform sampler2D uGrain;
vec4 over(vec4 f,vec4 b){return f+b*(1.0-f.a);}float distanceRound(vec2 p,vec2 size,float radius){vec2 q=abs(p-size*.5)-(size*.5-vec2(radius));return length(max(q,vec2(0)))+min(max(q.x,q.y),0.0)-radius;}
float coverage(vec2 p){return clamp(.5-distanceRound(p,uExtent.xy,uScreen.w)/max(.0001,uTint.w),0.0,1.0);}
void main(){vec2 local=vec2(vUv.x*uExtent.x,(1.0-vUv.y)*uExtent.y);vec4 pixel=vec4(0.0);
if(uTint.z>.5){vec2 css=uScreen.xy+(local-uExtent.xy*.5)*uScreen.z;vec2 uv=vec2((css.x-uRegion.x)/uRegion.z,1.0-(css.y-uRegion.y)/uRegion.w);pixel=texture(uRoi,clamp(uv,vec2(0),vec2(1)));float l=dot(pixel.rgb,vec3(.213,.715,.072));pixel=vec4(mix(vec3(l),pixel.rgb,1.16),pixel.a);}
pixel=over(vec4(uGlass.rgb*uGlass.a,uGlass.a),pixel);float edgeA=clamp(.5+(distanceRound(local,uExtent.xy,uScreen.w)+1.0)/max(.0001,uTint.w),0.0,1.0)*uEdge.a;pixel=over(vec4(uEdge.rgb*edgeA,edgeA),pixel);
float topA=(1.0-coverage(local-vec2(0,1)))*.75;pixel=over(vec4(vec3(topA),topA),pixel);
float t=clamp((local.x/max(.0001,uExtent.x)-uTint.x)/max(.0001,uTint.y-uTint.x),0.0,1.0);vec4 c=mix(uOutside,uInside,t);pixel=over(vec4(c.rgb*c.a*.84,c.a*.84),pixel);
vec3 grain=texture(uGrain,local/220.0).rgb;outColor=vec4(pixel.rgb*mix(vec3(1),grain,.55)+grain*.55*(1.0-pixel.a),.55+pixel.a*.45);}`;
  const initState = C.beginState(gl);
  try {
    drawProgram = C.program(gl, uiVertex, uiFragment, 'GL UI instances');
    blurProgram = C.fullScreenProgram(gl, blurFragment, 'GL UI backdrop filter');
    candidateProgram = C.fullScreenProgram(gl, candidateFragment, 'GL UI candidate background');
    for (const name of paperNames) paperLocations[name] = gl.getUniformLocation(drawProgram, name);
    samplerSlot = { vao: gl.createVertexArray(), buffer: null, capacity: 0 };
  } catch (error) {
    glyphClient?.release();
    sealClient?.release();
    for (const p of [drawProgram, blurProgram, candidateProgram]) if (p) gl.deleteProgram(p);
    throw error;
  } finally {
    C.endState(gl, initState);
  }
  const alive = () => {
    if (disposed) throw Error('GL UI renderer was disposed');
  };
  function recount() {
    metadata.atlasBytes = installed ? installed.size.w * installed.size.h * 4 : 0;
    metadata.assetBytes = C.statsForTextures([assets.swash, assets.seal, assets.grain]);
    metadata.groupBytes = group ? group.texture.width * group.texture.height * 4 : 0;
    metadata.roiBytes = roi ? roi.textures.reduce((n, x) => n + x.width * x.height * 4, 0) : 0;
    metadata.bufferBytes = [...slots.values()].reduce((n, x) => n + x.capacity * 4, 0) + samplerSlot.capacity * 4;
    metadata.instanceCPUBytes = [...slots.values()].reduce((n, x) => n + (x.data?.byteLength || 0), 0);
    metadata.byteCount =
      metadata.atlasBytes +
      metadata.assetBytes +
      metadata.groupBytes +
      metadata.roiBytes +
      metadata.bufferBytes +
      metadata.instanceCPUBytes +
      metadata.temporaryBytes;
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
  }
  function makeAtlasCanvas(specs, settings, limit) {
    if (typeof createGlyphCPUModel !== 'function') throw Error('GL UI needs the shared glyph CPU model');
    const model = createGlyphCPUModel(),
      measure = C.canvas(1, 1).getContext('2d');
    if (!measure) throw Error('Canvas2D UI glyph measurement is unavailable');
    return model
      .collect(
        'ui',
        specs,
        settings,
        request => model.raster('ui', request, measure, C.canvas, limit),
        async () => {},
      )
      .then(collected => model.finish('ui', collected, limit, 256, false));
  }
  function glyphAtlasPixels(prepared) {
    const size = prepared.size,
      pixels = new Uint8Array(size.w * size.h * 4);
    for (const glyph of prepared.glyphs) {
      const source = glyph.bitmap || glyph.canvas;
      if (!source) continue;
      const sampledCanvas = C.canvasPixels(source, glyph.w, glyph.h);
      const sampled = sampledCanvas.pixels.data;
      const clear = new Uint8Array(glyph.w * glyph.h);
      for (let i = 0; i < clear.length; i++) clear[i] = sampled[i * 4 + 3];
      const blur = glyph.blur > 0.08 ? C.blurredAlpha(clear, glyph.w, glyph.h, glyph.blur * glyph.dpr) : clear;
      for (let y = 0; y < glyph.h; y++)
        for (let x = 0; x < glyph.w; x++) {
          const i = y * glyph.w + x,
            at = ((glyph.ay + y) * size.w + glyph.ax + x) * 4;
          pixels[at] = clear[i];
          pixels[at + 1] = blur[i];
          pixels[at + 2] = 0;
          pixels[at + 3] = blur[i];
        }
      sampledCanvas.canvas.width = sampledCanvas.canvas.height = 1;
    }
    return { pixels, size };
  }
  function makeSwashCanvas() {
    const image = C.canvas(240, 60),
      context = image.getContext('2d');
    if (!context) throw Error('GL UI swash Canvas2D unavailable');
    const path = shared.samplePath(
      s => [
        10 + s * 220,
        31 - Math.sin(s * Math.PI) * 2.5 + (s - 0.5) * 4,
        21 * (0.78 + 0.22 * Math.sin(Math.PI * Math.min(1, s * 1.5))) * (1 - 0.18 * s * s),
      ],
      90,
    );
    shared.brush(context, path, {
      col: [0, 0, 0],
      a: 0.92,
      body: 0.85,
      edge: 0.2,
      streak: 0.4,
      tail: 0.32,
      head: 0.06,
      seed: 7,
      cover: 1.8,
    });
    return image;
  }
  async function fallbackSealPrepared() {
    if (sealClient)
      return sealClient.prepare(
        [
          ['字', 44 * 0.29],
          ['在', 44 * 0.73],
        ].map(([text, y]) => ({
          key: text,
          text,
          font: '600 18px "Noto Serif SC", "Songti SC", serif',
          fontSize: 18,
          dpr: 4,
          canvasWidth: 72,
          canvasHeight: 176,
          x: 9,
          y,
          textAlign: 'center',
          textBaseline: 'middle',
        })),
        {},
        { limit: 4096, alignment: 256 },
      );
    return null;
  }
  function makeSealCanvas(prepared) {
    const image = C.canvas(72, 176),
      context = image.getContext('2d');
    if (!context) throw Error('GL UI seal Canvas2D unavailable');
    const random = shared.rng(99),
      points = [];
    for (let i = 0; i < 160; i++) {
      const t = i / 40,
        s = t % 1,
        p = t < 1 ? [s * 18, 0] : t < 2 ? [18, s * 44] : t < 3 ? [18 - s * 18, 44] : [0, 44 - s * 44],
        j = (random() - 0.5) * 0.9;
      points.push([clamp(p[0] + j, 0, 18) * 4, clamp(p[1] + j, 0, 44) * 4]);
    }
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) context.lineTo(points[i][0], points[i][1]);
    context.closePath();
    context.fillStyle = 'rgb(179,57,45)';
    context.fill();
    context.globalCompositeOperation = 'destination-out';
    for (const [text, y] of [
      ['字', 44 * 0.29],
      ['在', 44 * 0.73],
    ]) {
      const glyph = prepared?.runs?.get(text)?.glyphs?.[0]?.glyph,
        source = glyph?.bitmap || glyph?.canvas;
      if (source) context.drawImage(source, 0, 0, 72, 176);
      else {
        context.save();
        context.scale(4, 4);
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = '600 18px "Noto Serif SC", "Songti SC", serif';
        context.fillStyle = '#fff';
        context.fillText(text, 9, y);
        context.restore();
      }
    }
    const rr = shared.rr;
    for (let i = 0; i < 120; i++) {
      const alpha = rr(random, 0.15, 0.85),
        x = random() * 18,
        y = random() * 44,
        radius = rr(random, 0.12, 0.55);
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(x * 4, y * 4, radius * 4, 0, Math.PI * 2);
      context.fillStyle = '#fff';
      context.fill();
    }
    context.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const alpha = rr(random, 0.1, 0.3),
        width = rr(random, 0.3, 0.8),
        y0 = random() * 44,
        y1 = y0 + rr(random, -4, 4);
      context.globalAlpha = alpha;
      context.strokeStyle = '#fff';
      context.lineWidth = width * 4;
      context.beginPath();
      context.moveTo(-2 * 4, y0 * 4);
      context.lineTo(20 * 4, y1 * 4);
      context.stroke();
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    return image;
  }
  function uiNoise(values, x, y, period, offset) {
    const xf = x - Math.floor(x),
      yf = y - Math.floor(y),
      sx = xf * xf * (3 - 2 * xf),
      sy = yf * yf * (3 - 2 * yf),
      bx = Math.floor(x),
      by = Math.floor(y);
    const x0 = ((bx % period) + period) % period,
      y0 = ((by % period) + period) % period,
      x1 = (x0 + 1) % period,
      y1 = (y0 + 1) % period;
    const a = values[offset + y0 * period + x0],
      b = values[offset + y0 * period + x1],
      c = values[offset + y1 * period + x0],
      d = values[offset + y1 * period + x1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  }
  function makeGrainPlan(packet) {
    if (
      packet?.values instanceof Float32Array &&
      packet?.fibres instanceof Float32Array &&
      packet.values.length === 13 * 13 + 55 * 55 + 220 * 220 * 2
    )
      return packet;
    const values = [];
    for (const [seed, period] of [
      [9, 13],
      [10, 55],
      [11, 220],
    ]) {
      const noise = shared.periodicNoise(seed, period);
      for (let y = 0; y < period; y++) for (let x = 0; x < period; x++) values.push(noise(x, y));
    }
    const random = shared.rng(12),
      rr = shared.rr;
    for (let i = 0; i < 220 * 220; i++) values.push(random());
    const fibres = [];
    for (let k = 0; k < (((220 * 220) / 380) | 0); k++) {
      const x = random() * 220,
        y = random() * 220,
        length = rr(random, 5, 30),
        angle0 = random() * Math.PI * 2,
        curv = rr(random, -0.12, 0.12),
        light = random() < 0.55,
        alpha = +(light ? rr(random, 0.1, 0.3) : rr(random, 0.04, 0.12)).toFixed(3),
        width = rr(random, 0.4, 1.1);
      for (const ox of [-220, 0, 220])
        for (const oy of [-220, 0, 220]) {
          let px = x + ox,
            py = y + oy,
            angle = angle0;
          if (px < -40 || px > 260 || py < -40 || py > 260) continue;
          for (let step = 0; step < 6; step++) {
            angle += curv;
            const nx = px + (Math.cos(angle) * length) / 6,
              ny = py + (Math.sin(angle) * length) / 6,
              pad = width * 0.5 + 0.5,
              c = light ? 1 : 0;
            fibres.push(
              Math.min(px, nx) - pad,
              Math.min(py, ny) - pad,
              Math.abs(nx - px) + pad * 2,
              Math.abs(ny - py) + pad * 2,
              px,
              py,
              nx,
              ny,
              c,
              c,
              c,
              alpha,
              2,
              width,
              0,
              0,
            );
            px = nx;
            py = ny;
          }
        }
    }
    return { values: new Float32Array(values), fibres: new Float32Array(fibres) };
  }
  function makeGrainCanvas(packet) {
    const plan = makeGrainPlan(packet),
      values = plan.values,
      offset55 = 13 * 13,
      offset220 = offset55 + 55 * 55,
      randomOffset = offset220 + 220 * 220;
    const image = C.canvas(220, 220),
      ctx = image.getContext('2d', { willReadFrequently: true }),
      pixels = ctx.createImageData(220, 220);
    for (let y = 0; y < 220; y++)
      for (let x = 0; x < 220; x++) {
        const uvx = x / 220,
          uvy = y / 220,
          value =
            0.5 +
            (uiNoise(values, uvx * 13, uvy * 13, 13, 0) - 0.5) * 0.26 +
            (uiNoise(values, uvx * 55, uvy * 55, 55, offset55) - 0.5) * 0.2 +
            (uiNoise(values, uvx * 220, uvy * 220, 220, offset220) - 0.5) * 0.16 +
            (values[randomOffset + y * 220 + x] - 0.5) * 0.13,
          c = Math.round(clamp(value) * 255),
          at = (y * 220 + x) * 4;
        pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = c;
        pixels.data[at + 3] = 255;
      }
    ctx.putImageData(pixels, 0, 0);
    ctx.lineCap = 'round';
    const fibres = plan.fibres;
    for (let i = 0; i < fibres.length; i += 16) {
      ctx.strokeStyle = `rgba(${Math.round(fibres[i + 8] * 255)},${Math.round(fibres[i + 9] * 255)},${Math.round(fibres[i + 10] * 255)},${fibres[i + 11]})`;
      ctx.lineWidth = fibres[i + 13];
      ctx.beginPath();
      ctx.moveTo(fibres[i + 4], fibres[i + 5]);
      ctx.lineTo(fibres[i + 6], fibres[i + 7]);
      ctx.stroke();
    }
    const final = ctx.getImageData(0, 0, 220, 220);
    for (let i = 0; i < final.data.length; i += 4) {
      const b = final.data[i],
        v = Math.round(232 + (b - 128) * 0.32),
        blue = Math.round(230 + (b - 128) * 0.32);
      final.data[i] = final.data[i + 1] = v;
      final.data[i + 2] = blue;
      final.data[i + 3] = 255;
    }
    ctx.putImageData(final, 0, 0);
    return image;
  }
  async function buildAssets() {
    let sealPrepared, grainPacket;
    try {
      grainPacket = shared.startup?.uiGrain ? await shared.startup.uiGrain() : null;
      sealPrepared = await fallbackSealPrepared();
      const swashCanvas = makeSwashCanvas(),
        sealCanvas = makeSealCanvas(sealPrepared),
        grainCanvas = makeGrainCanvas(grainPacket);
      const sealPixels = sealCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 72, 176).data;
      const premultiplied = new Uint8Array(sealPixels.length);
      for (let i = 0; i < sealPixels.length; i += 4) {
        const a = sealPixels[i + 3] / 255;
        premultiplied[i] = Math.round(sealPixels[i] * a);
        premultiplied[i + 1] = Math.round(sealPixels[i + 1] * a);
        premultiplied[i + 2] = Math.round(sealPixels[i + 2] * a);
        premultiplied[i + 3] = sealPixels[i + 3];
      }
      const state = C.beginState(gl);
      try {
        assets.swash = C.textureFromCanvas(gl, swashCanvas, 'GL UI seeded swash');
        assets.seal = C.texture(gl, 72, 176, premultiplied, 'GL UI engraved seal');
        assets.grain = C.textureFromCanvas(gl, grainCanvas, 'GL UI seeded paper grain');
        gl.bindTexture(gl.TEXTURE_2D, assets.grain);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      } finally {
        C.endState(gl, state);
      }
      metadata.glyphRasterizations += sealPrepared?.rasterizations || 0;
      metadata.glyphUploads += 2;
      swashCanvas.width =
        swashCanvas.height =
        sealCanvas.width =
        sealCanvas.height =
        grainCanvas.width =
        grainCanvas.height =
          1;
      recount();
    } finally {
      sealPrepared?.closeBitmaps?.();
      sealPrepared?.releaseData?.();
      sealPrepared?.dispose?.();
      sealClient?.release();
    }
  }
  await buildAssets();
  const handoff = metadata.atlasHandoffEnabled
    ? createUIAtlasHandoff({
        destroy: data => {
          if (data?.atlas) gl.deleteTexture(data.atlas);
        },
        afterSubmit: shared.afterSubmit || (fn => fn()),
        changed: () => {
          if (handoff) Object.assign(metadata, handoff.inspect());
        },
      })
    : null;
  function selectAtlas(frame, record) {
    if (!handoff) return null;
    record ||= handoff.select(frame);
    if (installed !== record.data) installed = record.data;
    return record;
  }
  async function restoreAtlasHandoff(records) {
    if (!handoff) throw Error('GL UI atlas handoff is disabled');
    for (const record of records) {
      await handoff.acquire(record.settings);
      await prepare(record.specs, record.settings);
      handoff.restorePublication(handoff.select(record), record.published);
    }
  }
  function makeGlyphAtlas(prepared) {
    const packed = glyphAtlasPixels(prepared),
      atlas = C.texture(gl, packed.size.w, packed.size.h, packed.pixels, 'GL UI glyph atlas');
    return { atlas, runs: prepared.runs, glyphs: prepared.glyphs, size: packed.size };
  }
  async function buildAtlas(specs, settings) {
    alive();
    const record = handoff?.begin(specs, settings);
    if (record?.data)
      return {
        generation: metadata.generation,
        ...handoff.result(record),
        byteCount: metadata.byteCount,
        glyphCount: record.data.glyphs.length,
      };
    metadata.prepareCount++;
    metadata.preparing = true;
    let prepared, next;
    try {
      prepared = glyphClient
        ? await glyphClient.prepare(specs, settings, { limit: C.maxTextureSize(gl), alignment: 256 })
        : await makeAtlasCanvas(specs, settings, C.maxTextureSize(gl));
      alive();
      const state = C.beginState(gl);
      try {
        const masks = makeGlyphAtlas(prepared);
        next = { ...masks, settings: { ...settings } };
      } finally {
        C.endState(gl, state);
      }
      alive();
      const previous = installed;
      if (handoff) {
        handoff.complete(record, next);
        if (!installed) installed = next;
      } else installed = next;
      metadata.generation++;
      metadata.prepareCompleted++;
      metadata.ready = true;
      metadata.runCount = next.runs.size;
      metadata.glyphCount = next.glyphs.length;
      metadata.atlasWidth = next.size.w;
      metadata.atlasHeight = next.size.h;
      metadata.glyphUploads += next.glyphs.length;
      metadata.glyphRasterizations += prepared.rasterizations || 0;
      metadata.cpuGlyphBytes = prepared.cpuGlyphBytes || 0;
      if (!handoff && previous?.atlas) gl.deleteTexture(previous.atlas);
      recount();
      return {
        generation: metadata.generation,
        ...(handoff ? handoff.result(record) : {}),
        byteCount: metadata.byteCount,
        glyphCount: metadata.glyphCount,
      };
    } finally {
      if (record && !record.data) handoff.fail(record);
      prepared?.closeBitmaps?.();
      prepared?.releaseData?.();
      prepared?.dispose?.();
      metadata.preparing = false;
      recount();
    }
  }
  function prepare(specs, settings = {}) {
    if (disposed) return Promise.reject(Error('GL UI renderer was disposed'));
    const copy = specs.map(s => ({ ...s, glyphs: s.glyphs?.map(g => ({ ...g })) }));
    const job = prepareQueue.then(() => buildAtlas(copy, { ...settings }));
    prepareQueue = job.catch(() => {});
    return job;
  }
  function makeSlot(name, count) {
    let value = slots.get(name);
    const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    if (!value || value.capacity < count * 28) {
      C.dropSlot(gl, value);
      value = C.vao(gl);
      value.name = name;
      value.capacity = capacity * 28;
      gl.bindBuffer(gl.ARRAY_BUFFER, value.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, capacity * 112, gl.DYNAMIC_DRAW);
      slots.set(name, value);
    }
    return value;
  }
  function instance(
    list,
    rect,
    uv,
    color,
    kind = 1,
    opacity = 1,
    blur = 0,
    radius = 0,
    aux = [0, 1, -1, 1],
    shape = rect,
    color2 = color,
  ) {
    if (!(rect[2] > 0 && rect[3] > 0) || opacity <= 0.00001) return;
    list.push([...rect, ...uv, ...color, ...color2, kind, opacity, blur, radius, ...aux, ...shape]);
  }
  function primitive(list, obj, type = 1, dpr = 1) {
    if (!obj) return;
    const color = obj.color || [26 / 255, 31 / 255, 27 / 255, 1],
      opacity = clamp(finite(obj.opacity, finite(obj.alpha, 1))),
      rect = [obj.x, obj.y, obj.width, obj.height],
      pad = 1 / dpr;
    instance(
      list,
      [rect[0] - pad, rect[1] - pad, rect[2] + pad * 2, rect[3] + pad * 2],
      [0, 0, 1, 1],
      obj.color0 || color,
      type,
      opacity,
      0,
      finite(obj.radius),
      [finite(obj.start, 0), finite(obj.end, 1), finite(obj.borderWidth), pad],
      rect,
      obj.color1 || color,
    );
  }
  function addRuns(list, runs, dpr, rim) {
    for (const item of runs || []) {
      const run = installed.runs.get(item.key);
      if (!run)
        throw Error('GL UI glyph is missing from prepared atlas: ' + String(item.text || item.key).slice(0, 80));
      const opacity = clamp(finite(item.opacity, 1));
      if (opacity <= 0.00001) continue;
      const sx = finite(item.width, run.width) / Math.max(0.0001, run.width),
        sy = finite(item.height, run.height) / Math.max(0.0001, run.height),
        scale = finite(item.scale, 1),
        cx = item.x + finite(item.width, run.width) * 0.5,
        cy = item.y + finite(item.translateY) + finite(item.height, run.height) * 0.5,
        color = item.inkColor || [26 / 255, 31 / 255, 27 / 255, 1];
      for (const placement of run.glyphs) {
        const glyph = placement.glyph;
        let x = item.x + (placement.x + glyph.left) * sx,
          y = item.y + finite(item.translateY) + (finite(run.baseline) + placement.y + glyph.top) * sy;
        x = cx + (x - cx) * scale;
        y = cy + (y - cy) * scale;
        const quad = [x, y, (glyph.w / glyph.dpr) * sx * scale, (glyph.h / glyph.dpr) * sy * scale];
        instance(
          list,
          quad,
          [
            glyph.ax / installed.size.w,
            glyph.ay / installed.size.h,
            glyph.w / installed.size.w,
            glyph.h / installed.size.h,
          ],
          color,
          0,
          opacity,
          glyph.blur ? clamp(finite(item.blur) / glyph.blur) : 0,
          rim ? rim.reach * finite(run.fontSize, finite(item.height, run.height)) * scale : 0,
          [0, 1, 0, 1 / dpr],
          quad,
          rim ? [rim.alpha, rim.lift, rim.paper, 0] : color,
        );
      }
    }
  }
  function drawInstances(
    programValue,
    target,
    list,
    W,
    H,
    originX = 0,
    originY = 0,
    name = 'overlay',
    paperFrame = null,
  ) {
    if (!list.length) return 0;
    const slot = makeSlot(name, list.length),
      data = C.instanceData(slot, list.length * 28);
    for (let i = 0; i < list.length; i++) data.set(list[i], i * 28);
    gl.useProgram(programValue);
    const view = glUniformLocation(gl, programValue, 'uViewport');
    if (view !== null) gl.uniform4f(view, W, H, originX, originY);
    if (programValue === drawProgram) {
      const paper = glUniformLocation(gl, programValue, 'uPaperValue');
      if (paper !== null) gl.uniform1f(paper, finite(paperFrame?.paperValue, finite(shared.paperValue?.(), 0.8)));
      C.bindPaper(gl, programValue, shared, paperFrame, paperLocations);
      C.textureUnit(gl, programValue, 'uGlyph', 10, installed.atlas);
      C.textureUnit(gl, programValue, 'uSwash', 11, assets.swash);
      C.textureUnit(gl, programValue, 'uSeal', 12, assets.seal);
      C.textureUnit(gl, programValue, 'uGroup', 13, name === 'box' ? assets.seal : group?.texture || assets.seal);
    }
    C.usePremultipliedBlend(gl);
    C.drawInstances(gl, slot, data, list.length);
    metadata.instances += list.length;
    return list.length;
  }
  function ensureGroup(width, height, dpr) {
    const pw = Math.max(1, Math.ceil(width * dpr)),
      ph = Math.max(1, Math.ceil(height * dpr));
    const need = !group || pw > group.texture.width || ph > group.texture.height || group.dpr !== dpr;
    if (need) {
      const gw = Math.max(group?.texture.width || 0, Math.ceil(pw / 64) * 64),
        gh = Math.max(group?.texture.height || 0, Math.ceil(ph / 64) * 64);
      C.dropFramebuffer(gl, group);
      const texture = C.texture(gl, gw, gh, null, 'GL UI candidate group');
      group = { texture, width: gw, height: gh, pw, ph, dpr, fbo: C.framebuffer(gl, texture) };
      metadata.groupAllocations++;
    } else {
      group.pw = pw;
      group.ph = ph;
    }
    metadata.groupWidth = group.texture.width;
    metadata.groupHeight = group.texture.height;
    return { pw, ph };
  }
  function ensureROI(width, height) {
    if (!roi || width > roi.width || height > roi.height) {
      if (roi) for (const item of roi.textures) C.dropFramebuffer(gl, item);
      const rw = Math.max(1, Math.ceil(width / 32) * 32),
        rh = Math.max(1, Math.ceil(height / 32) * 32);
      roi = {
        width: rw,
        height: rh,
        textures: [0, 1, 2].map(i => C.resizeTexture(gl, null, rw, rh, 'GL UI backdrop ROI ' + i)),
      };
    }
    metadata.roiWidth = roi.width;
    metadata.roiHeight = roi.height;
  }
  function filterBackdrop(sceneTexture, screenWidth, screenHeight, region, rw, rh) {
    ensureROI(rw, rh);
    const state = C.beginState(gl);
    try {
      C.fullScreenQuad(
        gl,
        roi.textures[0].fbo,
        rw,
        rh,
        blurProgram,
        { uRegion: region, uScreenCss: [screenWidth, screenHeight], uMode: 0, uSigma: 0, uAxis: [0, 0] },
        [['uSource', 0, sceneTexture]],
      );
      C.fullScreenQuad(
        gl,
        roi.textures[1].fbo,
        rw,
        rh,
        blurProgram,
        {
          uRegion: region,
          uScreenCss: [screenWidth, screenHeight],
          uMode: 1,
          uSigma: (16 * rw) / region[2],
          uAxis: [1 / rw, 0],
        },
        [['uSource', 0, roi.textures[0].texture]],
      );
      C.fullScreenQuad(
        gl,
        roi.textures[2].fbo,
        rw,
        rh,
        blurProgram,
        {
          uRegion: region,
          uScreenCss: [screenWidth, screenHeight],
          uMode: 1,
          uSigma: (16 * rh) / region[3],
          uAxis: [0, 1 / rh],
        },
        [['uSource', 0, roi.textures[1].texture]],
      );
    } finally {
      C.endState(gl, state);
    }
  }
  function paintCandidateBackground(frame, box, region, rw, rh, glass) {
    const width = box.width,
      height = box.height,
      dpr = finite(frame.dpr, 1),
      { pw, ph } = ensureGroup(width, height, dpr),
      tint = box.tint || {},
      edge = box.edge || [52 / 255, 72 / 255, 54 / 255, 0.15],
      glassColor = box.ground || box.glassColor || [252 / 255, 252 / 255, 249 / 255, 0.6];
    const state = C.beginState(gl);
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, group.fbo);
      gl.viewport(0, 0, pw, ph);
      C.prepare2D(gl);
      gl.disable(gl.BLEND);
      gl.useProgram(candidateProgram);
      const scalar = (name, value) => {
        const loc = glUniformLocation(gl, candidateProgram, name);
        if (loc !== null) gl.uniform1f(loc, value);
      };
      const vec2 = (name, value) => {
        const loc = glUniformLocation(gl, candidateProgram, name);
        if (loc !== null) gl.uniform2fv(loc, value);
      };
      const vec4 = (name, value) => {
        const loc = glUniformLocation(gl, candidateProgram, name);
        if (loc !== null) gl.uniform4fv(loc, value);
      };
      vec4('uExtent', [width, height, pw, ph]);
      vec4('uScreen', [box.x, box.y, Math.max(0.001, finite(box.scale, 1)), finite(box.radius, 18)]);
      vec4('uRegion', region);
      vec4('uGlass', glassColor);
      vec4('uOutside', tint.out || [214 / 255, 231 / 255, 204 / 255, 0.74]);
      vec4('uInside', tint.in || [248 / 255, 220 / 255, 228 / 255, 0.78]);
      vec4('uTint', [finite(tint.start), finite(tint.end, 1), glass ? 1 : 0, (width / pw + height / ph) * 0.5]);
      vec4('uEdge', edge);
      vec2('uRoiExtent', [rw, rh]);
      C.textureUnit(gl, candidateProgram, 'uRoi', 0, glass && roi ? roi.textures[2].texture : assets.seal);
      C.textureUnit(gl, candidateProgram, 'uGrain', 1, assets.grain);
      C.prepare2D(gl);
      gl.bindVertexArray(samplerSlot.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } finally {
      C.endState(gl, state);
    }
    return { pw, ph };
  }
  function encode(target, frame, resources = {}) {
    alive();
    const atlasRecord = selectAtlas(frame);
    if (!installed) throw Error('GL UI encode before prepare');
    const box = frame.box,
      W = frame.W,
      H = frame.H,
      dpr = finite(frame.dpr, 1);
    encoded = { generation: frame.generation, frameTimeMs: frame.frameTimeMs, atlasRecord, visible: false };
    if (!box || finite(box.opacity) <= 0.003 || box.width <= 0 || box.height <= 0) return encoded;
    const encodeState = C.beginState(gl);
    try {
      const scale = Math.max(0.001, finite(box.scale, 1)),
        region = [
          box.x - box.width * scale * 0.5 - 48,
          box.y - box.height * scale * 0.5 - 48,
          box.width * scale + 96,
          box.height * scale + 96,
        ],
        glass = box.glass !== false;
      let rw = 1,
        rh = 1;
      if (glass) {
        const sceneTexture = resources.sceneTexture || target?.texture;
        if (!sceneTexture) throw Error('GL UI glass requires the completed scene texture');
        rw = Math.max(1, Math.ceil(region[2] * 0.5));
        rh = Math.max(1, Math.ceil(region[3] * 0.5));
        filterBackdrop(sceneTexture, W, H, region, rw, rh);
      }
      const { pw, ph } = paintCandidateBackground(frame, box, region, rw, rh, glass),
        groupTarget = { texture: group.texture, fbo: group.fbo, width: pw, height: ph };
      const groupState = C.beginState(gl);
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, group.fbo);
        gl.viewport(0, 0, pw, ph);
        C.prepare2D(gl);
        const list = [];
        if (resources.drawBoxParticlesGL)
          resources.drawBoxParticlesGL({
            target: groupTarget,
            W: box.width,
            H: box.height,
            offsetX: box.width / 2 - 400,
            offsetY: box.height / 2 - 160,
            fade: clamp(finite(box.opacity, 1)) * 0.95,
            key: 'box',
          });
        for (const swash of frame.swashes || []) {
          const sx = finite(swash.scaleX, 1),
            sy = finite(swash.scaleY, 1);
          instance(
            list,
            [
              swash.x + (swash.width * (1 - sx)) / 2,
              swash.y + (swash.height * (1 - sy)) / 2,
              swash.width * sx,
              swash.height * sy,
            ],
            [0, 0, 1, 1],
            swash.color || [111 / 255, 154 / 255, 104 / 255, 1],
            3,
            finite(swash.opacity, 0.5),
          );
        }
        addRuns(list, frame.boxRuns, dpr);
        const rule = frame.rule;
        if (rule) {
          const rect = [rule.x, rule.y, rule.width, rule.height],
            color = rule.color || [26 / 255, 31 / 255, 27 / 255, 0.34],
            opacity = finite(rule.opacity, 0.5),
            pad = 1 / dpr;
          instance(
            list,
            [rect[0], rect[1] - pad, rect[2] * 0.16, rect[3] + 2 * pad],
            [0, 0, 1, 1],
            [...color.slice(0, 3), 0],
            2,
            opacity,
            0,
            0,
            [0, 1, 0, pad],
            [rect[0], rect[1], rect[2] * 0.16, rect[3]],
            color,
          );
          primitive(list, { ...rule, x: rule.x + rule.width * 0.16, width: rule.width * 0.68, color, opacity }, 1, dpr);
          instance(
            list,
            [rect[0] + rect[2] * 0.84, rect[1] - pad, rect[2] * 0.16, rect[3] + 2 * pad],
            [0, 0, 1, 1],
            color,
            2,
            opacity,
            0,
            0,
            [0, 1, 0, pad],
            [rect[0] + rect[2] * 0.84, rect[1], rect[2] * 0.16, rect[3]],
            [...color.slice(0, 3), 0],
          );
        }
        primitive(list, frame.rawCaret, 1, dpr);
        if (frame.meter) {
          primitive(list, frame.meter.bar, 2, dpr);
          const dot = frame.meter.dot;
          if (dot) {
            const shadow = [dot.x, dot.y + 1, dot.width, dot.height];
            instance(
              list,
              [shadow[0] - 4.5, shadow[1] - 4.5, shadow[2] + 9, shadow[3] + 9],
              [0, 0, 1, 1],
              [0, 0, 0, 0.18],
              6,
              finite(dot.opacity, 1),
              1.5,
              0,
              [0, 1, 0, 1 / dpr],
              shadow,
            );
            primitive(
              list,
              {
                ...dot,
                x: dot.x - 2,
                y: dot.y - 2,
                width: dot.width + 4,
                height: dot.height + 4,
                radius: (dot.width + 4) / 2,
                color: [1, 1, 1, 0.85],
              },
              1,
              dpr,
            );
            primitive(list, dot, 1, dpr);
          }
        }
        const edge = box.edge || [52 / 255, 72 / 255, 54 / 255, 0.15];
        primitive(
          list,
          {
            x: -box.width / 2 + 5,
            y: -box.height / 2 + 5,
            width: Math.max(0, box.width - 10),
            height: Math.max(0, box.height - 10),
            radius: 14,
            borderWidth: 1,
            color: edge,
            opacity: 0.55,
          },
          1,
          dpr,
        );
        drawInstances(
          drawProgram,
          groupTarget,
          list,
          box.width,
          box.height,
          -box.width / 2,
          -box.height / 2,
          'box',
          frame,
        );
      } finally {
        C.endState(gl, groupState);
      }
      encoded = {
        generation: frame.generation,
        frameTimeMs: frame.frameTimeMs,
        atlasRecord,
        visible: true,
        pw,
        ph,
        region,
        rw,
        rh,
      };
      return encoded;
    } finally {
      C.endState(gl, encodeState);
    }
  }
  function draw(target, frame) {
    alive();
    if (handoff) {
      const record = handoff.select(frame);
      if (record !== encoded?.atlasRecord) throw Error('GL UI draw needs encode of the same atlas generation');
      selectAtlas(frame, record);
    }
    if (!installed) throw Error('GL UI draw before prepare');
    if (!encoded || encoded.generation !== frame.generation || encoded.frameTimeMs !== frame.frameTimeMs)
      throw Error('GL UI draw requires encode of the same frame');
    metadata.instances = 0;
    const list = [],
      dpr = finite(frame.dpr, 1),
      box = frame.box;
    if (encoded.visible) {
      const scale = finite(box.scale, 1),
        width = box.width * scale,
        height = box.height * scale,
        x = box.x - width / 2,
        y = box.y - height / 2,
        opacity = clamp(finite(box.opacity, 1)),
        color = box.shade || [34 / 255, 52 / 255, 38 / 255, 0.4];
      for (const [offset, blur, spread] of [
        [30, 70, -30],
        [4, 14, -6],
      ]) {
        const sigma = blur * 0.5 * scale,
          shape = [
            x - spread * scale,
            y + (offset - spread) * scale,
            Math.max(0.001, width + spread * 2 * scale),
            Math.max(0.001, height + spread * 2 * scale),
          ],
          padding = sigma * 3;
        instance(
          list,
          [shape[0] - padding, shape[1] - padding, shape[2] + padding * 2, shape[3] + padding * 2],
          [0, 0, 1, 1],
          color,
          6,
          opacity,
          sigma,
          finite(box.radius, 18) * scale,
          [0, 1, -1, 1 / dpr],
          shape,
          [x, y, width, height],
        );
      }
      instance(
        list,
        [x, y, width, height],
        [0, encoded.ph / group.texture.height, encoded.pw / group.texture.width, -encoded.ph / group.texture.height],
        [1, 1, 1, 1],
        5,
        opacity,
        0,
        finite(box.radius, 18) * scale,
        [0, 1, 0, 1 / dpr],
        [x, y, width, height],
      );
    }
    addRuns(list, frame.sloganRuns, dpr, {
      reach: 0.19,
      alpha: 0.95,
      lift: 0.12,
      paper: finite(shared.paperValue?.(), 0.8),
    });
    const seal = frame.seal;
    if (seal) {
      const scale = finite(seal.scale, 1);
      instance(
        list,
        [
          seal.x + (seal.width * (1 - scale)) / 2,
          seal.y + (seal.height * (1 - scale)) / 2,
          seal.width * scale,
          seal.height * scale,
        ],
        [0, 0, 1, 1],
        [1, 1, 1, 1],
        4,
        clamp(finite(seal.opacity, 1)),
      );
    }
    if (frame.cover)
      primitive(
        list,
        {
          x: 0,
          y: 0,
          width: frame.W,
          height: frame.H,
          color: frame.cover.color || [233 / 255, 236 / 255, 228 / 255, 1],
          opacity: frame.cover.opacity,
        },
        1,
        dpr,
      );
    if (!list.length) return 0;
    const saved = C.beginState(gl);
    try {
      const targetInfo = C.bindTarget(gl, target, frame.targetWidth, frame.targetHeight);
      drawInstances(drawProgram, target, list, frame.W, frame.H, 0, 0, 'overlay', frame);
      metadata.lastTargetWidth = targetInfo.width;
      metadata.lastTargetHeight = targetInfo.height;
      recount();
    } finally {
      C.endState(gl, saved);
    }
    return metadata.instances;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (handoff) handoff.dispose();
    else if (installed?.atlas) gl.deleteTexture(installed.atlas);
    installed = null;
    glyphClient?.release();
    for (const value of [assets.glyph, assets.swash, assets.seal, assets.grain]) C.dropTexture(gl, value);
    assets.glyph = assets.swash = assets.seal = assets.grain = null;
    C.dropFramebuffer(gl, group);
    group = null;
    if (roi) {
      for (const value of roi.textures) C.dropFramebuffer(gl, value);
      roi = null;
    }
    for (const value of slots.values()) C.dropSlot(gl, value);
    slots.clear();
    if (samplerSlot) gl.deleteVertexArray(samplerSlot.vao);
    samplerSlot = null;
    for (const value of [drawProgram, blurProgram, candidateProgram]) if (value) gl.deleteProgram(value);
    metadata.ready = false;
    metadata.byteCount =
      metadata.atlasBytes =
      metadata.assetBytes =
      metadata.groupBytes =
      metadata.roiBytes =
      metadata.bufferBytes =
      metadata.instanceCPUBytes =
        0;
    metadata.glyphCount = metadata.runCount = 0;
  }
  return {
    prepare,
    encode,
    draw,
    dispose,
    metadata,
    acquireAtlasRoom: settings => (handoff ? handoff.acquire(settings) : Promise.resolve({})),
    cancelAtlasRoom: (revokeReady, cancelWaiting = true) =>
      handoff ? handoff.cancel(revokeReady, cancelWaiting) : false,
    noteAtlasPublication: frame => handoff?.publish(frame),
    setAtlasReferences: (frames = [], project) => handoff?.references(frames, project),
    snapshotAtlasHandoff: () => handoff?.snapshot() || [],
    restoreAtlasHandoff,
    get ready() {
      return metadata.ready && !disposed;
    },
    get byteCount() {
      return metadata.byteCount;
    },
  };
}
