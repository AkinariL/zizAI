async function createGLText(gl, canvasFormat = 'rgba8', shared = {}) {
  if (!gl || typeof gl.drawArraysInstanced !== 'function') throw Error('GL text requires a WebGL2 context');
  const C = GLTextUICommon,
    clamp = C.clamp,
    finite = C.finite;
  const metadata = {
    backend: 'webgl2-text-runs',
    ready: false,
    preparing: false,
    generation: 0,
    prepareCount: 0,
    prepareCompleted: 0,
    glyphRasterizations: 0,
    glyphUploads: 0,
    glyphCount: 0,
    runCount: 0,
    instances: 0,
    atlasWidth: 0,
    atlasHeight: 0,
    atlasLayers: 2,
    atlasFormat: 'rgba8',
    filterFormat: 'rgba8',
    atlasBytes: 0,
    glyphAtlasBytes: 0,
    bufferBytes: 0,
    instanceCPUBytes: 0,
    temporaryBytes: 0,
    byteCount: 0,
    peakBytes: 0,
    cpuGlyphBytes: 0,
    warnings: [],
    floatFBO: false,
    filters: {
      entrySigmaCss: 6,
      drySigmaEm: 0.2,
      gaussianExtent: 3,
      morphology: 'separable square with RGBA8 CPU fallback',
      runChannels: ['clear / halo / dry / unused', 'entry clear / entry halo / unused / unused'],
    },
  };
  const glyphClient = shared.glyphPreparation?.acquire('text');
  if (glyphClient) metadata.preparation = glyphClient.metadata;
  let disposed = false,
    installed = null,
    prepareQueue = Promise.resolve(),
    slot = null,
    program = null;
  let uniforms = null;
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
  const paperLocations = Object.create(null);
  const paperSource =
    typeof shared.paperGLSL === 'string' && shared.paperGLSL
      ? shared.paperGLSL
      : `vec3 textPaperAt(vec2 cssPosition,vec2 viewportCss,float paperValue){return vec3(.82);}`;
  const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec4 aRect;
layout(location=1) in vec4 aUV;
layout(location=2) in vec4 aColour;
layout(location=3) in vec4 aEffect;
layout(location=4) in vec4 aUnderline;
layout(location=5) in vec4 aUnderlineColour;
layout(location=6) in vec4 aExtra;
uniform vec2 uViewport;
out vec2 vCss;
out vec2 vUV;
out vec4 vColour;
out vec4 vEffect;
out vec4 vUnderline;
out vec4 vUnderlineColour;
out vec4 vBox;
void main(){
  const vec2 corner[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
  vec2 p=aRect.xy+corner[gl_VertexID]*aRect.zw;
  gl_Position=vec4(p.x/uViewport.x*2.0-1.0,1.0-p.y/uViewport.y*2.0,0.0,1.0);
  vCss=p;vUV=aUV.xy+corner[gl_VertexID]*aUV.zw;vColour=aColour;vEffect=aEffect;
  vUnderline=aUnderline;vUnderlineColour=aUnderlineColour;vBox=vec4(aRect.xy+aExtra.xy,aExtra.zw);
}`;
  const fragmentSource = `#version 300 es
precision highp float;
${paperSource}
in vec2 vCss;in vec2 vUV;in vec4 vColour;in vec4 vEffect;in vec4 vUnderline;in vec4 vUnderlineColour;in vec4 vBox;
uniform vec2 uViewport;
uniform vec4 uClip;
uniform vec4 uConfig;
uniform vec4 uFlags;
uniform sampler2D uSteadyAtlas;
uniform sampler2D uEntryAtlas;
out vec4 outColor;
float erfApprox(float value){float x=abs(value);float t=1.0/(1.0+0.3275911*x);float q=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t;return sign(value)*(1.0-q*exp(-x*x));}
float cdf(float value){return .5+.5*erfApprox(value*.7071067811865476);}
float rectangleCoverage(vec2 point,vec4 box,float sigma){
  if(box.z<=0.0||box.w<=0.0)return 0.0;
  if(sigma>0.0){vec2 a=(point-box.xy)/sigma;vec2 b=(point-box.xy-box.zw)/sigma;return max(0.0,(cdf(a.x)-cdf(b.x))*(cdf(a.y)-cdf(b.y)));}
  vec2 halfSize=box.zw*.5;vec2 d=abs(point-box.xy-halfSize)-halfSize;float aa=.5/max(1.0,uFlags.y);return clamp(.5-max(d.x,d.y)/(2.0*aa),0.0,1.0);
}
vec4 over(vec4 front,vec4 back){return front+back*(1.0-front.a);}
void main(){
  if(vCss.x<uClip.x||vCss.x>uClip.x+uClip.z||vCss.y<uClip.y||vCss.y>uClip.y+uClip.w)discard;
  float fadeWidth=max(.0001,uClip.z*(uConfig.y-uConfig.x));
  float fade=clamp((vCss.x-uClip.x-uClip.z*uConfig.x)/fadeWidth,0.0,1.0);
  if(fade<=0.0)discard;
  vec4 pixel=vec4(0.0);
  if(vEffect.w>.5){
    float radius=min(vEffect.y,min(vBox.z,vBox.w)*.5);vec2 q=abs(vCss-vBox.xy-vBox.zw*.5)-(vBox.zw*.5-vec2(radius));
    float distance=length(max(q,vec2(0)))+min(max(q.x,q.y),0.0)-radius;
    float alpha=clamp(.5-distance*uFlags.y,0.0,1.0)*vColour.a;pixel=vec4(vColour.rgb*alpha,alpha);
  }else{
    vec4 clear=texture(uSteadyAtlas,vUV),entry=texture(uEntryAtlas,vUV);vec2 coverage=mix(clear.rg,entry.rg,vEffect.y);
    float inkAlpha=coverage.r*vColour.a;
    float haloAlpha=coverage.g*uFlags.x*uFlags.z;
    float dryAlpha=clear.b*vEffect.z;
    float underMask=0.0;
    if(vUnderlineColour.a>.0001&&vUnderline.z>0.0&&vUnderline.w>0.0){underMask=rectangleCoverage(vCss,vUnderline,0.0);if(vEffect.y>.0001)underMask=mix(underMask,rectangleCoverage(vCss,vUnderline,6.0),vEffect.y);}
    float underAlpha=underMask*vUnderlineColour.a;
    if(max(max(inkAlpha,haloAlpha),max(dryAlpha,underAlpha))<.0001)discard;
    if(haloAlpha>.0001){vec3 paper=mix(textPaperAt(vCss,uViewport,uConfig.w),vec3(1.0),uConfig.z);pixel=vec4(paper*haloAlpha,haloAlpha);}
    pixel=over(vec4(vColour.rgb*inkAlpha,inkAlpha),pixel);
    pixel=over(pixel,vec4(vColour.rgb*dryAlpha,dryAlpha));
    pixel=over(pixel,vec4(vUnderlineColour.rgb*underAlpha,underAlpha));
  }
  outColor=pixel*(vEffect.x*fade);
}`;
  const initState = C.beginState(gl);
  try {
    program = C.program(gl, vertexSource, fragmentSource, 'GL text runs');
    uniforms = C.locations(gl, program, ['uViewport', 'uClip', 'uConfig', 'uFlags', 'uSteadyAtlas', 'uEntryAtlas']);
    for (const name of paperNames) paperLocations[name] = gl.getUniformLocation(program, name);
    slot = C.vao(gl);
    metadata.shader = 'webgl2-instanced-text-runs';
    metadata.shaderReady = true;
  } catch (error) {
    glyphClient?.release();
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    C.endState(gl, initState);
  }
  const alive = () => {
    if (disposed) throw Error('GL text renderer was disposed');
  };
  function recount() {
    metadata.instanceCPUBytes = slot?.data?.byteLength || 0;
    metadata.byteCount =
      metadata.atlasBytes +
      metadata.glyphAtlasBytes +
      metadata.bufferBytes +
      metadata.instanceCPUBytes +
      metadata.temporaryBytes;
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
  }
  function clearRun(run) {
    const surface = C.canvas(run.w, run.h),
      context = surface.getContext('2d', { willReadFrequently: true });
    if (!context) throw Error('Canvas2D text-mask preparation is unavailable');
    context.clearRect(0, 0, run.w, run.h);
    context.imageSmoothingEnabled = true;
    for (const placement of run.glyphs) {
      const glyph = placement.glyph,
        source = glyph.bitmap || glyph.canvas;
      if (!source) continue;
      context.drawImage(
        source,
        run.padding + (placement.x + glyph.left) * run.dpr,
        run.padding + (run.baseline + placement.y + glyph.top) * run.dpr,
        glyph.w,
        glyph.h,
      );
    }
    const pixels = context.getImageData(0, 0, run.w, run.h).data,
      alpha = new Uint8Array(run.w * run.h);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
    surface.width = surface.height = 1;
    return alpha;
  }
  function composeAtlases(prepared) {
    const runs = prepared.runs,
      pack = prepared.runPack || prepared.runPackInfo;
    if (!pack || !(pack.width > 0 && pack.height > 0)) throw Error('Glyph service did not pack the GL text runs');
    const steady = new Uint8Array(pack.width * pack.height * 4),
      entrance = new Uint8Array(pack.width * pack.height * 4);
    for (const run of runs) {
      const clear = clearRun(run),
        expanded = C.dilateAlpha(clear, run.w, run.h, run.radius),
        halo = C.blurredAlpha(expanded, run.w, run.h, run.sigma);
      const dry = C.blurredAlpha(clear, run.w, run.h, run.drySigma),
        entry = C.blurredAlpha(clear, run.w, run.h, 6 * run.dpr);
      for (let y = 0; y < run.h; y++)
        for (let x = 0; x < run.w; x++) {
          const i = y * run.w + x,
            at = ((run.atlasY + y) * pack.width + run.atlasX + x) * 4;
          steady[at] = clear[i];
          steady[at + 1] = halo[i];
          steady[at + 2] = dry[i];
          steady[at + 3] = 0;
          entrance[at] = clear[i];
          entrance[at + 1] = entry[i];
          entrance[at + 2] = 0;
          entrance[at + 3] = 0;
        }
    }
    return { width: pack.width, height: pack.height, steady, entrance };
  }
  async function fallbackPrepare(specs, settings) {
    if (typeof createGlyphCPUModel !== 'function') throw Error('GL text needs the shared glyph CPU model');
    const model = createGlyphCPUModel(),
      measure = C.canvas(1, 1).getContext('2d');
    if (!measure) throw Error('Canvas2D text measurement is unavailable');
    const collected = await model.collect(
      'text',
      specs,
      settings,
      request => model.raster('text', request, measure, C.canvas, C.maxTextureSize(gl)),
      async () => {},
    );
    return model.finish('text', collected, C.maxTextureSize(gl), 256, false);
  }
  async function buildAtlas(specs, settings) {
    alive();
    metadata.prepareCount++;
    metadata.preparing = true;
    let prepared,
      next = null;
    try {
      prepared = glyphClient
        ? await glyphClient.prepare(specs, settings, { limit: C.maxTextureSize(gl), alignment: 256 })
        : await fallbackPrepare(specs, settings);
      alive();
      const masks = composeAtlases(prepared),
        state = C.beginState(gl);
      try {
        const steadyTexture = C.texture(gl, masks.width, masks.height, masks.steady, 'GL text clear/halo/dry atlas');
        const entryTexture = C.texture(gl, masks.width, masks.height, masks.entrance, 'GL text entrance atlas');
        next = {
          atlas: steadyTexture,
          entryAtlas: entryTexture,
          runs: new Map(prepared.runs.map(run => [run.key, run])),
          glyphCount: prepared.glyphs.length,
          width: masks.width,
          height: masks.height,
          glyphWidth: prepared.glyphPack?.width || 0,
          glyphHeight: prepared.glyphPack?.height || 0,
          glyphBytes: 0,
        };
      } finally {
        C.endState(gl, state);
      }
      alive();
      const previous = installed;
      installed = next;
      metadata.generation++;
      metadata.prepareCompleted++;
      metadata.ready = true;
      metadata.runCount = next.runs.size;
      metadata.glyphCount = next.glyphCount;
      metadata.atlasWidth = next.width;
      metadata.atlasHeight = next.height;
      metadata.glyphAtlasBytes = 0;
      metadata.atlasBytes = next.width * next.height * 8;
      metadata.glyphRasterizations += prepared.rasterizations || 0;
      metadata.glyphUploads += next.glyphCount;
      metadata.cpuGlyphBytes = prepared.cpuGlyphBytes || 0;
      if (previous) {
        gl.deleteTexture(previous.atlas);
        gl.deleteTexture(previous.entryAtlas);
      }
      recount();
      return {
        generation: metadata.generation,
        runCount: metadata.runCount,
        glyphCount: metadata.glyphCount,
        byteCount: metadata.byteCount,
      };
    } finally {
      prepared?.closeBitmaps?.();
      prepared?.releaseData?.();
      prepared?.dispose?.();
      metadata.preparing = false;
    }
  }
  function prepare(specs, settings = {}) {
    if (disposed) return Promise.reject(Error('GL text renderer was disposed'));
    const copy = specs.map(spec => ({ ...spec, glyphs: spec.glyphs?.map(glyph => ({ ...glyph })) }));
    const operation = prepareQueue.then(() => buildAtlas(copy, { ...settings }));
    prepareQueue = operation.catch(() => {});
    return operation;
  }
  function encode(target, frame) {
    alive();
    return { target, generation: frame?.generation, frameTimeMs: frame?.frameTimeMs };
  }
  function draw(target, frame) {
    alive();
    if (!installed) throw Error('GL text draw before its atlas is ready');
    const W = finite(frame.W, frame.viewportCss?.[0]),
      H = finite(frame.H, frame.viewportCss?.[1]);
    if (!(W > 0 && H > 0)) return 0;
    const runs = frame.runs || frame.items || [],
      clip = frame.clip || frame.lineRect || { x: 0, y: 0, width: W, height: H, fadeStart: 0, fadeEnd: 0 };
    const data = C.instanceData(slot, (runs.length + Number(!!frame.caret) + 1) * 28);
    const ink = frame.inkColor || [26 / 255, 31 / 255, 27 / 255, 1],
      shift = finite(frame.shiftX, 0);
    let count = 0;
    for (const item of runs) {
      const run = installed.runs.get(item.key),
        opacity = clamp(finite(item.opacity, 1));
      if (!run)
        throw Error('GL text run is missing from the prepared atlas: ' + String(item.text || item.key).slice(0, 80));
      if (opacity <= 0.0001) continue;
      const scaleX = run.width > 0 ? finite(item.width, run.width) / run.width : 1,
        scaleY = finite(item.height, run.height) / Math.max(0.0001, run.height);
      const padX = (run.padding / run.dpr) * scaleX,
        padY = (run.padding / run.dpr) * scaleY;
      const x = item.x + shift - padX,
        y = item.y + finite(item.translateY, 0) - padY,
        width = (run.w / run.dpr) * scaleX,
        height = (run.h / run.dpr) * scaleY;
      if (x + width < clip.x || x > clip.x + clip.width || y + height < clip.y || y > clip.y + clip.height) continue;
      const underline = item.underline,
        underColour = underline?.color || [0, 0, 0, 0],
        runInk = item.inkColor || ink,
        at = count++ * 28;
      data.set(
        [
          x,
          y,
          width,
          height,
          run.atlasX / installed.width,
          run.atlasY / installed.height,
          run.w / installed.width,
          run.h / installed.height,
          runInk[0],
          runInk[1],
          runInk[2],
          finite(runInk[3], 1),
          opacity,
          clamp(finite(item.blurMix, finite(item.blur, 0) / 6)),
          clamp(finite(item.dryAlpha, 0)),
          0,
          finite(underline?.x, 0) + shift,
          finite(underline?.y, 0) + finite(item.translateY, 0),
          Math.max(0, finite(underline?.width, 0)),
          Math.max(0, finite(underline?.height, 0)),
          underColour[0],
          underColour[1],
          underColour[2],
          finite(underColour[3], 1) * clamp(finite(underline?.alpha, 1)),
          0,
          0,
          0,
          0,
        ],
        at,
      );
    }
    const caret = frame.caret;
    if (caret && caret.width > 0 && caret.height > 0 && finite(caret.alpha, 1) > 0.0001) {
      const colour = caret.color || ink,
        aa = 1 / finite(frame.dpr, 1),
        at = count++ * 28;
      data.set(
        [
          caret.x + shift - aa,
          caret.y - aa,
          caret.width + 2 * aa,
          caret.height + 2 * aa,
          0,
          0,
          0,
          0,
          colour[0],
          colour[1],
          colour[2],
          finite(colour[3], 1),
          clamp(finite(caret.alpha, 1)),
          Math.max(0, finite(caret.radius, 1)),
          0,
          1,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          aa,
          aa,
          caret.width,
          caret.height,
        ],
        at,
      );
    }
    metadata.instances = count;
    if (!count) return 0;
    const state = C.beginState(gl);
    try {
      const targetInfo = C.bindTarget(gl, target, frame.targetWidth, frame.targetHeight);
      gl.useProgram(program);
      gl.uniform2f(uniforms.uViewport, W, H);
      gl.uniform4f(uniforms.uClip, clip.x, clip.y, clip.width, clip.height);
      gl.uniform4f(
        uniforms.uConfig,
        finite(clip.fadeStart, 0.03),
        finite(clip.fadeEnd, 0.42),
        clamp(finite(frame.baseLift, 0.12)),
        finite(frame.paperValue, 0),
      );
      gl.uniform4f(
        uniforms.uFlags,
        clamp(finite(frame.baseA, 0.95)),
        finite(frame.dpr, 1),
        frame.groundEnabled === false ? 0 : 1,
        0,
      );
      C.bindPaper(gl, program, shared, frame, paperLocations);
      C.textureUnit(gl, program, 'uSteadyAtlas', 10, installed.atlas);
      C.textureUnit(gl, program, 'uEntryAtlas', 11, installed.entryAtlas);
      C.usePremultipliedBlend(gl);
      C.drawInstances(gl, slot, data, count);
      metadata.lastTargetWidth = targetInfo.width;
      metadata.lastTargetHeight = targetInfo.height;
      metadata.bufferBytes = slot.capacity * 4;
      recount();
    } finally {
      C.endState(gl, state);
    }
    return count;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    glyphClient?.release();
    if (installed) {
      gl.deleteTexture(installed.atlas);
      gl.deleteTexture(installed.entryAtlas);
      installed = null;
    }
    C.dropSlot(gl, slot);
    slot = null;
    if (program) gl.deleteProgram(program);
    program = null;
    metadata.ready = false;
    metadata.atlasBytes =
      metadata.glyphAtlasBytes =
      metadata.bufferBytes =
      metadata.instanceCPUBytes =
      metadata.byteCount =
        0;
    metadata.runCount = metadata.glyphCount = 0;
  }
  return {
    prepare,
    encode,
    draw,
    dispose,
    metadata,
    get ready() {
      return metadata.ready && !disposed;
    },
    get byteCount() {
      return metadata.byteCount;
    },
  };
}
