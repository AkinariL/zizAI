const GL_COMPOSITOR_VERTEX = `#version 300 es
precision highp float;
out vec2 v;
void main(){
  vec2 p=gl_VertexID==0?vec2(-1.0,-1.0):gl_VertexID==1?vec2(3.0,-1.0):vec2(-1.0,3.0);
  v=p*.5+.5;gl_Position=vec4(p,0.0,1.0);
}`;

const GL_COMPOSITOR_LAYER_COMMON = `
uniform sampler2D uZ0;uniform sampler2D uZ1;uniform sampler2D uZ2;uniform sampler2D uZ3;
uniform sampler2D uJ0;uniform sampler2D uJ1;uniform sampler2D uJ2;uniform sampler2D uJ3;
uniform vec4 uSc;uniform vec4 uOf;uniform vec4 uY0;uniform vec4 uY1;uniform vec4 uSway;
uniform vec2 uSize;uniform vec2 uBand;
in vec2 v;out vec4 outColor;
vec2 pointerShift(){return vec2(uMouse.x/max(uAsp,1.0),-uMouse.y*min(uAsp,1.0)*.7);}
vec4 glRingTap0(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uZ0,vec2(u,1.0-t));}
vec4 glRingTap1(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uZ1,vec2(u,1.0-t));}
vec4 glRingTap2(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uZ2,vec2(u,1.0-t));}
vec4 glRingTap3(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uZ3,vec2(u,1.0-t));}
vec4 glRingTap4(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uJ0,vec2(u,1.0-t));}
vec4 glRingTap5(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uJ1,vec2(u,1.0-t));}
vec4 glRingTap6(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uJ2,vec2(u,1.0-t));}
vec4 glRingTap7(float u,float t){return t<0.0||t>1.0?vec4(0.0):texture(uJ3,vec2(u,1.0-t));}
float glMixWorld(float x,float n,float lag){
  float F=uMsk.x,J=uMsk.y,L=uMsk.z;
  float edge=1.0+.5*F+.5*J+L-uT*(1.0+F+J+2.0*L)+lag;
  return glPaperRamp(edge-.5*F,edge+.5*F,x+(n-.5)*J);
}
float glLayerBlend(int layer,float x,float yt){
  if(uT<=.0005)return uD;
  vec2 q=vec2(x,1.0-yt);
  float n=layer==0?glPaperWn(q,uN1.x,uN3.x,0.0):
          layer==1?glPaperWn(q,uN1.y,uN3.y,.31):
          layer==2?glPaperWn(q,uN1.z,uN3.z,.63):glPaperWn(q,uN1.w,uN3.w,.87);
  float lag=layer==0?uLag.x:layer==1?uLag.y:layer==2?uLag.z:uLag.w;
  float m=glMixWorld(x,n,lag);return mix(m,1.0-m,uD);
}
vec4 glGroove0(float u,float t,float j){if(j<.002)return glRingTap0(u,t);if(j>.998)return glRingTap4(u,t);return mix(glRingTap0(u,t),glRingTap4(u,t),j);}
vec4 glGroove1(float u,float t,float j){if(j<.002)return glRingTap1(u,t);if(j>.998)return glRingTap5(u,t);return mix(glRingTap1(u,t),glRingTap5(u,t),j);}
vec4 glGroove2(float u,float t,float j){if(j<.002)return glRingTap2(u,t);if(j>.998)return glRingTap6(u,t);return glPaperXfade(glRingTap2(u,t),glRingTap6(u,t),j);}
vec4 glGroove3(float u,float t,float j){if(j<.002)return glRingTap3(u,t);if(j>.998)return glRingTap7(u,t);return glPaperXfade(glRingTap3(u,t),glRingTap7(u,t),j);}
`;

const GL_RING_SAMPLER_NAMES = ['uZ0', 'uZ1', 'uZ2', 'uZ3', 'uJ0', 'uJ1', 'uJ2', 'uJ3'];

const GL_BACKGROUND_FRAGMENT = `#version 300 es
${GL_PAPER_GLSL}
${GL_COMPOSITOR_LAYER_COMMON}
uniform sampler2D uFarTarget;uniform sampler2D uMidTarget;
uniform vec2 uFarBand;uniform vec2 uMidBand;
uniform float uUseFarTarget;uniform float uUseMidTarget;
vec4 depthFar(vec2 uv,float x,float yt,float u,float t,float j){
  if(uUseFarTarget<.5)return glGroove0(u,t,j);
  float q=(yt-uFarBand.x)/(uFarBand.y-uFarBand.x);
  return texture(uFarTarget,vec2(x,1.0-q))*step(0.0,q)*step(q,1.0);
}
vec4 depthMid(vec2 uv,float x,float yt,float u,float t,float j){
  if(uUseMidTarget<.5)return glGroove1(u,t,j);
  float q=(yt-uMidBand.x)/(uMidBand.y-uMidBand.x);
  return texture(uMidTarget,vec2(x,1.0-q))*step(0.0,q)*step(q,1.0);
}
void main(){
  float yt=1.0-v.y,x=v.x,xa=x*uAsp,mx=uMouse.x,dr=uTime*.006;vec2 par=pointerShift();
  float j0=uD,j1=uD,j2=uD,j3=uD,mz=0.0;
  if(uT>.0005){j0=glLayerBlend(0,x,yt);j1=glLayerBlend(1,x,yt);j2=glLayerBlend(2,x,yt);j3=glLayerBlend(3,x,yt);mz=j1;}
  vec3 col=paperSky(x,yt,j0,mx);
  vec3 mist0=mix(uMistZ,uMistJ,j0),mist1=mix(uMistZ,uMistJ,j1),mist2=mix(uMistZ,uMistJ,j2);
  col=mix(col,mist0,glPaperBand(yt,.6,.1)*(.3+.42*glPaperNoise(vec2(xa*.5+uN1.x+dr,yt*1.7+.2)).g));
  float t0=(yt+par.y*.004-uY0.x)/(uY1.x-uY0.x),u0=fract((x+par.x*.004)*uSc.x+uOf.x);
  vec4 c0=depthFar(v,x,yt,u0,t0,j0);col=col*(1.0-c0.a)+c0.rgb;
  col=mix(col,mist0,glPaperBand(yt,.668,.05)*(.22+.38*glPaperNoise(vec2(xa*.5+uN1.x+dr*1.3,yt*2.2+.5)).g));
  float t1=(yt+par.y*.009-uY0.y)/(uY1.y-uY0.y),u1=fract((x+par.x*.009)*uSc.y+uOf.y);
  vec4 c1=depthMid(v,x,yt,u1,t1,j1);col=col*(1.0-c1.a)+c1.rgb;
  col=mix(col,mist1,glPaperBand(yt,.85,.065)*(.3+.42*glPaperNoise(vec2(xa*.5+uN1.y+dr*1.6,yt*2.4+.8)).g));
  float rn=glPaperNoise(vec2(xa*.35+dr*4.0,yt*.9+.45)).g;
  float fog=1.0-glPaperRamp(0.0,1.0,max(max(uRead.x-yt,0.0)/.1,max(yt-uRead.y,0.0)/.16)+(rn-.5)*.5);
  float hs=pow(clamp((1.04-yt)/.72,0.0,1.0),1.5);
  float sw=(sin(uTime*.53+yt*2.1)*.65+sin(uTime*.97+1.3+yt*3.7)*.35)*uSway.x*hs*mix(1.0,.4,j2);
  float t2=(yt+par.y*.017-uY0.z)/(uY1.z-uY0.z),u2=fract((x+sw+par.x*.017)*uSc.z+uOf.z);
  vec4 c2=glGroove2(u2,t2,j2);col=col*(1.0-c2.a)+c2.rgb;
  col=mix(col,mist2,glPaperRamp(.86,1.02,yt)*(.18+.3*glPaperNoise(vec2(xa*.5+uN1.z+dr*2.0,yt*2.0+.1)).g));
  col=mix(col,mist2,fog*.22);
  float hs3=glPaperRamp(1.02,.2,yt);
  float sw3=(sin(uTime*.47+yt*1.9+x*2.1)*.6+sin(uTime*.89+2.1+yt*3.1)*.4)*uSway.x*1.5*hs3*mix(1.0,.55,j3);
  float t3=(yt+par.y*.032-uY0.w)/(uY1.w-uY0.w),u3=fract((x+sw3+par.x*.032)*uSc.w+uOf.w);
  vec4 c3=glGroove3(u3,t3,j3);float keep=1.0-fog*.8;col=col*(1.0-c3.a*keep)+c3.rgb*keep;
  if(uT>.0005){vec3 wIn=mix(uWashJ,uWashZ,uD);float zone=4.0*mz*(1.0-mz);col=mix(col,mix(mist1,wIn,.75),zone*.42);col=mix(col,wIn,glPaperRamp(0.0,.35,mz)*(1.0-glPaperRamp(.55,1.0,mz))*.18);}
  float pap=glPaperNoise(gl_FragCoord.xy/(512.0*uDpr)).r;
  col=paperFinish(col,vec2(x,1.0-yt),mist1,pap);outColor=vec4(col,1.0);
}`;

function glForestLayerFragment(layer) {
  const index = layer,
    far = layer === 0,
    depth = far ? 'x' : 'y',
    mouse = far ? '.004' : '.009';
  return `#version 300 es\n${GL_PAPER_GLSL}\n${GL_COMPOSITOR_LAYER_COMMON}\nvoid main(){
    float x=v.x,yt=mix(uBand.y,uBand.x,v.y),j=glLayerBlend(${index},x,yt);vec2 par=pointerShift();
    float t=(yt+par.y*${mouse}-uY0.${depth})/(uY1.${depth}-uY0.${depth});
    float u=fract((x+par.x*${mouse})*uSc.${depth}+uOf.${depth});
    outColor=${far ? 'glGroove0(u,t,j)' : 'glGroove1(u,t,j)'};
  }`;
}

const GL_COMPOSITOR_COPY_FRAGMENT = `#version 300 es
precision highp float;in vec2 v;out vec4 outColor;uniform sampler2D uSource;
void main(){outColor=texture(uSource,v);}`;

function glShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw Error('WebGL2 could not allocate ' + label + ' shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'unknown GLSL error';
    gl.deleteShader(shader);
    throw Error(label + ': ' + message);
  }
  return shader;
}
function glProgram(gl, fragment, label) {
  const vertex = glShader(gl, gl.VERTEX_SHADER, GL_COMPOSITOR_VERTEX, label + ' vertex');
  let pixel = null,
    program = null;
  try {
    pixel = glShader(gl, gl.FRAGMENT_SHADER, fragment, label + ' fragment');
    program = gl.createProgram();
    if (!program) throw Error('WebGL2 could not allocate ' + label + ' program');
    gl.attachShader(program, vertex);
    gl.attachShader(program, pixel);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(label + ': ' + (gl.getProgramInfoLog(program) || 'unknown link error'));
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (pixel) gl.deleteShader(pixel);
  }
}
function glTarget(gl, width, height, label, filter = gl.LINEAR) {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const texture = gl.createTexture(),
    fbo = gl.createFramebuffer();
  if (!texture || !fbo) {
    if (texture) gl.deleteTexture(texture);
    if (fbo) gl.deleteFramebuffer(fbo);
    throw Error('WebGL2 could not allocate ' + label + ' target');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    throw Error(label + ' framebuffer incomplete: 0x' + status.toString(16));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, fbo, width, height, label };
}
function glDeleteTarget(gl, target) {
  if (!target) return;
  gl.deleteFramebuffer(target.fbo);
  gl.deleteTexture(target.texture);
}
function glHashBytes(bytes) {
  let hash = 2166136261;
  for (const value of bytes) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash.toString(16);
}
function glTopDownPixels(source, width, height) {
  const output = new Uint8Array(width * height * 4),
    stride = width * 4;
  for (let y = 0; y < height; y++)
    output.set(source.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  return output;
}

async function createWebGL2(canvas, failed) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
  } catch (error) {}
  if (!gl) {
    GPU_DIAG.state = 'failed';
    GPU_DIAG.backend = 'webgl2';
    GPU_DIAG.error = 'Worker WebGL2 unavailable';
    return null;
  }
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
  if (maxUnits < 14) {
    GPU_DIAG.state = 'failed';
    GPU_DIAG.backend = 'webgl2';
    GPU_DIAG.error = 'WebGL2 needs 14 fragment texture units; available ' + maxUnits;
    return null;
  }
  GLTextUICommon.trackState(gl);
  let broken = false,
    disposed = false,
    validated = false,
    presented = false,
    firstFrame = true,
    renderGeneration = 0,
    frameCadenceMs = null,
    debugGLCheckPending = false,
    debugGLCheckLabel = 'frame';
  const fail = error => {
    if (broken || disposed) return;
    broken = true;
    validated = false;
    presented = false;
    GPU_DIAG.error = String(error?.message || error);
    GPU_DIAG.state = 'failed';
    GPU_DIAG.lost = !!gl.isContextLost?.();
    try {
      failed?.(error instanceof Error ? error : Error(String(error)));
    } catch (callbackError) {}
  };
  const markGLCheck = label => {
    if (SITE_DEBUG) {
      debugGLCheckPending = true;
      debugGLCheckLabel = label;
    }
  };
  function takeGLErrors() {
    const errors = [];
    for (let i = 0; i < 16; i++) {
      const code = gl.getError();
      if (code === gl.NO_ERROR) break;
      const names = new Map([
        [gl.INVALID_ENUM, 'INVALID_ENUM'],
        [gl.INVALID_VALUE, 'INVALID_VALUE'],
        [gl.INVALID_OPERATION, 'INVALID_OPERATION'],
        [gl.OUT_OF_MEMORY, 'OUT_OF_MEMORY'],
        [gl.CONTEXT_LOST_WEBGL, 'CONTEXT_LOST_WEBGL'],
      ]);
      errors.push(names.get(code) || '0x' + code.toString(16));
    }
    return errors;
  }
  const onContextLost = event => {
    event?.preventDefault?.();
    fail(Error('webgl2.contextlost: Worker WebGL2 context was lost'));
  };
  canvas.addEventListener?.('webglcontextlost', onContextLost, false);
  if (canvas.style) canvas.style.visibility = 'hidden';
  let backgroundProgram,
    farProgram,
    midProgram,
    copyProgram,
    compositorVAO = null,
    copyLocations = null;
  const ringTextures = new Array(10).fill(null),
    ringPhysical = [];
  let backgroundTarget = null,
    sceneTarget = null,
    farTarget = null,
    midTarget = null;
  let baseWidth = 1,
    baseHeight = 1,
    farWidth = 0,
    farHeight = 0,
    midWidth = 0,
    midHeight = 0,
    presentationScale = 1;
  let paperPacket = null,
    mountainPacket = null,
    textRenderer = null,
    uiRenderer = null,
    particles = null,
    textFrame = null,
    uiFrame = null;
  let tileRenderer = null,
    activeMesh = null,
    lastFrameScene = null;
  const meshQueue = [],
    afterFrame = [];
  let tileOpeningMode = false,
    tilePrewarmMode = false,
    sharing = false;
  const tileBacklog =
    typeof createGPUTileBacklogPolicy === 'function'
      ? createGPUTileBacklogPolicy()
      : {
          metadata: { planningLimit: 3, submissionLimit: 2, level: 0 },
          reset() {},
          update() {
            return this.metadata;
          },
        };
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
  const tileSubmission = { limit: 2, pending: 0, peak: 0, submitted: 0, emptySkipped: 0, blockedFrames: 0 };
  const sourceTileQuery = { tilefar: param('tilefar'), tilemid: param('tilemid'), tileaa: param('tileaa') };
  const sourceTileScales = {
    farScale: gpuSourceTileScale(sourceTileQuery.tilefar),
    midScale: gpuSourceTileScale(sourceTileQuery.tilemid),
    nearScale: 1,
    closeScale: 1,
  };
  const sourceTileAntialias = sourceTileQuery.tileaa !== 'off',
    sourceRasterScaling = sourceTileScales.farScale < 1 || sourceTileScales.midScale < 1;
  let resolutionOptions = {
    farScale: param('farres'),
    midScale: param('midres'),
    nearScale: param('nearres'),
    antialias: param('layeraa') ?? 'off',
    antialiasRaw: param('layeraa'),
  };
  let resolution = gpuBackgroundResolution(1, 1, resolutionOptions);
  let paperState = null,
    latestPaperLocations = new WeakMap(),
    frameSerial = 0,
    finishSerial = 0;
  let brokenUpload = 0;

  const uniformNames = [
    ...GL_PAPER_UNIFORM_NAMES,
    ...GL_RING_SAMPLER_NAMES,
    'uSc',
    'uOf',
    'uY0',
    'uY1',
    'uSway',
    'uSize',
    'uBand',
    'uFarBand',
    'uMidBand',
    'uFarTarget',
    'uMidTarget',
    'uUseFarTarget',
    'uUseMidTarget',
  ];
  function locations(program, names = uniformNames) {
    return glUniformLocations(gl, program, names);
  }
  function requireActiveUniforms(program, names, label) {
    const missing = names.filter(name => glUniformLocation(gl, program, name) === null);
    if (missing.length) throw Error('WebGL2 ' + label + ' is missing required uniforms: ' + missing.join(', '));
  }
  function set1(map, name, value) {
    const loc = map?.[name];
    if (loc != null) gl.uniform1f(loc, value);
  }
  function set2(map, name, value) {
    const loc = map?.[name];
    if (loc != null) gl.uniform2fv(loc, value);
  }
  function set4(map, name, value) {
    const loc = map?.[name];
    if (loc != null) gl.uniform4fv(loc, value);
  }
  function setSampler(map, name, unit) {
    const loc = map?.[name];
    if (loc != null) gl.uniform1i(loc, unit);
  }
  function bindTexture(unit, texture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }
  function paperValuesFor(scene) {
    const view = scene?.view || null,
      shape = typeof transShape === 'function' ? transShape() : { F: TRANS.F, J: TRANS.J, L: 0 };
    return {
      uAsp: (world.W || innerWidth) / (world.H || innerHeight),
      uDpr: scene?.dpr || 1,
      uTime: scene?.time || 0,
      uT: scene?.t || 0,
      uD: scene?.D || 0,
      uVeil: scene?.veil || 0,
      uN1: view?.n1 || [0, 0, 0, 0],
      uN3: view?.n3 || [0, 0, 0, 0],
      uLag: LAYERS.map(layer => layer.lag * TRANS.lag),
      uMS: [view?.ms || 1, view?.ms || 1],
      uMO: view?.mo || [0, 0],
      uMY: [MTN.y0, MTN.y1],
      uMouse: [scene?.mx || 0, scene?.my || 0],
      uRead: world.read || [-1, -1],
      uMsk: [shape.F, shape.J, shape.L, TRANS.dip],
      uMark: world.mark || [2, 2, 2, 2],
      uMistZ: glColor(MIST_ZH),
      uMistJ: glColor(MIST_JA),
      uWashZ: glColor(WASH_ZH),
      uWashJ: glColor(WASH_JA),
      uSkyZ0: glColor(SKY.zh[0]),
      uSkyZ1: glColor(SKY.zh[1]),
      uSkyZ2: glColor(SKY.zh[2]),
      uSkyJ0: glColor(SKY.ja[0]),
      uSkyJ1: glColor(SKY.ja[1]),
      uSkyJ2: glColor(SKY.ja[2]),
      uMtZA: glColor(MTN_TINT.zh[0]),
      uMtZB: glColor(MTN_TINT.zh[1]),
      uMtJA: glColor(MTN_TINT.ja[0]),
      uMtJB: glColor(MTN_TINT.ja[1]),
      uSc: view?.sc || [1, 1, 1, 1],
      uOf: view?.of || [0, 0, 0, 0],
      uY0: LAYERS.map(layer => layer.y0),
      uY1: LAYERS.map(layer => layer.y1),
      uSway: [scene?.sway || 0, 0, 0, 0],
      uSize: [baseWidth, baseHeight],
    };
  }
  function applyPaper(program, frame, providedLocations) {
    const map = glPaperLocations(gl, program, providedLocations);
    if (!paperState) return map;
    gl.useProgram(program);
    glUploadPaperUniform(gl, map, 'uAsp', 1, paperState.uAsp);
    glUploadPaperUniform(gl, map, 'uDpr', 1, paperState.uDpr);
    glUploadPaperUniform(gl, map, 'uTime', 1, paperState.uTime);
    glUploadPaperUniform(gl, map, 'uT', 1, paperState.uT);
    glUploadPaperUniform(gl, map, 'uD', 1, paperState.uD);
    glUploadPaperUniform(gl, map, 'uVeil', 1, paperState.uVeil);
    glUploadPaperUniform(gl, map, 'uN1', 4, paperState.uN1);
    glUploadPaperUniform(gl, map, 'uN3', 4, paperState.uN3);
    glUploadPaperUniform(gl, map, 'uLag', 4, paperState.uLag);
    glUploadPaperUniform(gl, map, 'uMS', 2, paperState.uMS);
    glUploadPaperUniform(gl, map, 'uMO', 2, paperState.uMO);
    glUploadPaperUniform(gl, map, 'uMY', 2, paperState.uMY);
    glUploadPaperUniform(gl, map, 'uMouse', 2, paperState.uMouse);
    glUploadPaperUniform(gl, map, 'uRead', 2, paperState.uRead);
    glUploadPaperUniform(gl, map, 'uMsk', 4, paperState.uMsk);
    glUploadPaperUniform(gl, map, 'uMark', 4, paperState.uMark);
    for (const name of [
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
    ])
      glUploadPaperUniform(gl, map, name, 3, paperState[name]);
    bindTexture(8, ringTextures[8]);
    bindTexture(9, ringTextures[9]);
    if (map.uMtn != null) gl.uniform1i(map.uMtn, 8);
    if (map.uPN != null) gl.uniform1i(map.uPN, 9);
    return map;
  }
  const bindPaperUniforms = (targetGL, program, frame, providedLocations) => {
    if (targetGL !== gl) throw Error('Paper uniforms belong to another WebGL2 context');
    const map = applyPaper(program, frame, providedLocations);
    latestPaperLocations.set(program, map);
    return map;
  };
  const sharedPaper = {
    paperGLSL: GL_PAPER_GLSL,
    paperUniforms: Object.create(null),
    getPaperUniforms: () => paperState,
    bindPaperUniforms,
    glyphPreparation: null,
    paperValue: () => textFrame?.paperValue,
    rng,
    rr,
    samplePath,
    brush,
    periodicNoise,
    startup: GPU_STARTUP,
    afterSubmit: action => {
      if (typeof action === 'function') afterFrame.push(action);
    },
  };

  function createStaticTexture(unit, wrap, filter) {
    const texture = gl.createTexture();
    if (!texture) throw Error('WebGL2 could not allocate static texture ' + unit);
    bindTexture(unit, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    ringTextures[unit] = texture;
    return texture;
  }
  function makeResolution(nextWidth, nextHeight) {
    const targetOptions = {
      ...resolutionOptions,
      farY0: LAYERS[0].y0,
      farY1: LAYERS[0].y1,
      midY0: LAYERS[1].y0,
      midY1: LAYERS[1].y1,
    };
    const next = gpuBackgroundResolution(nextWidth, nextHeight, targetOptions);
    baseWidth = next.nearWidth;
    baseHeight = next.nearHeight;
    resolution = next;
    farWidth = next.farWidth;
    farHeight = next.farHeight;
    midWidth = next.midWidth;
    midHeight = next.midHeight;
    const scale = Math.min(devicePixelRatio || 1, maxTex / Math.max(1, innerWidth), maxTex / Math.max(1, innerHeight));
    const cw = Math.max(1, Math.round(innerWidth * scale)),
      ch = Math.max(1, Math.round(innerHeight * scale));
    presentationScale = scale;
    canvas.width = cw;
    canvas.height = ch;
    glDeleteTarget(gl, backgroundTarget);
    glDeleteTarget(gl, sceneTarget);
    glDeleteTarget(gl, farTarget);
    glDeleteTarget(gl, midTarget);
    backgroundTarget = glTarget(gl, baseWidth, baseHeight, 'WebGL2 near background');
    sceneTarget = glTarget(gl, cw, ch, 'WebGL2 scene');
    farTarget = next.farAllocated ? glTarget(gl, next.farWidth, next.farHeight, 'WebGL2 far depth') : null;
    midTarget = next.midAllocated ? glTarget(gl, next.midWidth, next.midHeight, 'WebGL2 mid depth') : null;
    renderGeneration++;
    validated = false;
    presented = false;
    firstFrame = true;
    markGLCheck('resize');
    if (canvas.style) canvas.style.visibility = 'hidden';
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    updateBytes();
    const band = depth =>
      next[depth + 'Band']?.coverage || {
        worldY0: LAYERS[depth === 'far' ? 0 : 1].y0,
        worldY1: LAYERS[depth === 'far' ? 0 : 1].y1,
      };
    GPU_DIAG.backgroundResolution = {
      schema: 4,
      backend: 'webgl2',
      mode: next.mode,
      policy: 'three-depth-base-near-bands-webgl2-v1',
      allocationOptimization: next.allocationOptimization,
      viewport: { width: innerWidth, height: innerHeight },
      requested: {
        farres: resolutionOptions.farScale == null ? next.farScale : Number(resolutionOptions.farScale),
        midres: resolutionOptions.midScale == null ? next.midScale : Number(resolutionOptions.midScale),
        nearres: resolutionOptions.nearScale == null ? 1 : Number(resolutionOptions.nearScale),
        layeraa: resolutionOptions.antialias || 'off',
      },
      effective: { farScale: next.farScale, midScale: next.midScale, nearScale: 1, presentationScale: scale },
      base: { width: baseWidth, height: baseHeight },
      nearRequestNormalized: next.nearRequestNormalized,
      far: {
        allocated: !!farTarget,
        width: farWidth,
        height: farHeight,
        format: 'rgba8unorm',
        validRect: { x: 0, y: 0, width: farWidth, height: farHeight },
        ...next.farBand,
        coverage: band('far'),
      },
      mid: {
        allocated: !!midTarget,
        width: midWidth,
        height: midHeight,
        format: 'rgba8unorm',
        validRect: { x: 0, y: 0, width: midWidth, height: midHeight },
        ...next.midBand,
        coverage: band('mid'),
      },
      near: {
        width: baseWidth,
        height: baseHeight,
        format: 'rgba8unorm',
        layers: [2, 3],
        contents: 'sky, mountains, full-resolution near ink, inter-layer fog, paper grain and transition wash',
      },
      filter: {
        mode: next.mode === 'full' ? 'original-single-pass' : 'linear reduced far/mid depth targets',
        currentAA: 'off',
        method: 'source-ring linear sampling; near background remains full resolution',
        postprocess: 'none',
        far: { active: !!farTarget },
        mid: { active: !!midTarget },
      },
      presentation: { width: cw, height: ch, bytes: cw * ch * 4 },
      timestampScope: 'background, scene, text and UI are submitted in ordered WebGL2 passes',
    };
  }
  function updateBytes() {
    const ringBytes = ringTextures.slice(0, 8).reduce((n, t, unit) => {
      const p = ringPhysical[Math.floor(unit % 4)];
      return n + (p ? p.ringWidth * p.outputHeight * 4 : 0);
    }, 0);
    GPU_DIAG.bytes = {
      rings: ringBytes,
      noise: paperPacket ? paperPacket.width * paperPacket.height * 4 : 0,
      mountains: mountainPacket ? mountainPacket.Pw * mountainPacket.Ph * 4 : 0,
      background: backgroundTarget ? backgroundTarget.width * backgroundTarget.height * 4 : 0,
      backgroundFar: farTarget ? farTarget.width * farTarget.height * 4 : 0,
      backgroundMid: midTarget ? midTarget.width * midTarget.height * 4 : 0,
      backgroundUniform: 0,
      presentation: canvas.width * canvas.height * 4,
      presentationBuffers: 0,
      particles: particles?.metadata?.byteCount || 0,
      text: textRenderer?.metadata?.byteCount || 0,
      ui: uiRenderer?.metadata?.byteCount || 0,
      tileUploadScratch: 0,
      tileRaster: tileRenderer?.metadata?.byteCount || 0,
      tileTimingReadback: 0,
      sceneTimingReadback: 0,
    };
    GPU_DIAG.resourcePeak = Math.max(
      GPU_DIAG.resourcePeak || 0,
      Object.values(GPU_DIAG.bytes).reduce((a, b) => a + b, 0),
    );
  }
  function liveMesh(tile) {
    const job = tile?.job,
      ring = job && world.rings?.[job.sc]?.[job.li];
    return !!job && job.era === renderWorld.era && ring?.want[job.slot] === job.k;
  }
  function pruneMeshQueue() {
    for (let i = meshQueue.length - 1; i >= 0; i--)
      if (!liveMesh(meshQueue[i])) {
        releaseTileDelivery(meshQueue[i].mesh);
        meshQueue.splice(i, 1);
        GPU_DIAG.staleMeshDropped = (GPU_DIAG.staleMeshDropped || 0) + 1;
      }
  }
  function releaseActive() {
    if (!activeMesh) return;
    releaseTileDelivery(activeMesh.mesh);
    activeMesh = null;
  }
  function clearUploads() {
    const reset =
      GPU_DIAG.tileQueueReset || (GPU_DIAG.tileQueueReset = { count: 0, droppedQueued: 0, cancelledActive: 0 });
    reset.count++;
    reset.droppedQueued += meshQueue.length;
    reset.cancelledActive += activeMesh ? 1 : 0;
    tileRenderer?.cancel?.();
    for (const item of meshQueue) releaseTileDelivery(item.mesh);
    meshQueue.length = 0;
    releaseActive();
    tileBacklog.reset();
  }
  function updateTileBacklog(at) {
    let visibleMissing = 0,
      wantedMissing = 0;
    const cam = springs.cam.x,
      dom = st.page.D ? 'ja' : 'zh',
      transition = st.page.t > 0.0005;
    for (let li = 0; li < 4; li++) {
      const g = world.geo?.[li];
      if (!g) continue;
      const left = cam * LAYERS[li].pan * world.H,
        k0 = Math.floor((left * g.ts) / g.T),
        k1 = Math.ceil(((left + world.W) * g.ts) / g.T) - 1;
      for (const sc of ['zh', 'ja']) {
        const ring = world.rings?.[sc]?.[li];
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
    tileSubmission.limit = tileOpeningMode ? 16 : settings.submissionLimit;
    return settings;
  }
  function bindBackgroundLocations(program, frame, band, layer = false) {
    const map = applyPaper(program, frame, locations(program));
    set4(map, 'uSc', paperState.uSc);
    set4(map, 'uOf', paperState.uOf);
    set4(map, 'uY0', paperState.uY0);
    set4(map, 'uY1', paperState.uY1);
    set4(map, 'uSway', paperState.uSway);
    set2(map, 'uSize', paperState.uSize);
    if (band) set2(map, 'uBand', band);
    const ringNames = ['uZ0', 'uZ1', 'uZ2', 'uZ3', 'uJ0', 'uJ1', 'uJ2', 'uJ3'];
    for (let i = 0; i < 8; i++) {
      bindTexture(i, ringTextures[i]);
      setSampler(map, ringNames[i], i);
    }
    setSampler(map, 'uMtn', 8);
    setSampler(map, 'uPN', 9);
    if (!layer) {
      set2(map, 'uFarBand', [resolution.farBand.coverage.worldY0, resolution.farBand.coverage.worldY1]);
      set2(map, 'uMidBand', [resolution.midBand.coverage.worldY0, resolution.midBand.coverage.worldY1]);
      bindTexture(10, farTarget?.texture || ringTextures[0]);
      bindTexture(11, midTarget?.texture || ringTextures[1]);
      setSampler(map, 'uFarTarget', 10);
      setSampler(map, 'uMidTarget', 11);
      set1(map, 'uUseFarTarget', farTarget ? 1 : 0);
      set1(map, 'uUseMidTarget', midTarget ? 1 : 0);
    }
    return map;
  }
  function drawFull(program, target, frame, band, layer = false) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo || null);
    gl.viewport(0, 0, target?.width || canvas.width, target?.height || canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(compositorVAO);
    gl.useProgram(program);
    bindBackgroundLocations(program, frame, band, layer);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function drawCopy(target, source) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(compositorVAO);
    gl.useProgram(copyProgram);
    bindTexture(0, source.texture);
    if (copyLocations?.uSource != null) gl.uniform1i(copyLocations.uSource, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function waitFence() {
    if (broken || gl.isContextLost?.())
      return Promise.reject(Error('webgl2.contextlost: context unavailable while waiting for GPU'));
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return Promise.reject(Error('WebGL2 could not create completion fence'));
    gl.flush();
    const serial = ++finishSerial;
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (disposed || broken || gl.isContextLost?.()) {
          gl.deleteSync(sync);
          reject(Error('webgl2.contextlost: completion fence interrupted'));
          return;
        }
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          gl.deleteSync(sync);
          resolve(serial);
          return;
        }
        if (status === gl.WAIT_FAILED) {
          gl.deleteSync(sync);
          reject(Error('WebGL2 completion fence failed'));
          return;
        }
        setTimeout(poll, 4);
      };
      poll();
    });
  }
  function afterFrameFence(generation, actions, checkErrors = false, label = 'frame') {
    waitFence()
      .then(() => {
        if (disposed || broken) return;
        if (checkErrors) {
          const errors = takeGLErrors();
          if (errors.length) {
            fail(Error('WebGL2 ' + label + ' GL error: ' + errors.join(', ')));
            return;
          }
        }
        for (const action of actions)
          try {
            action();
          } catch (error) {
            fail(error);
            return;
          }
        if (broken || disposed) return;
        if (generation === renderGeneration) {
          validated = true;
          presented = true;
          if (canvas.style) canvas.style.visibility = '';
          GPU_DIAG.state = tileRenderer
            ? 'WebGL2 / stage 2 tiles'
            : uiRenderer && GPU_UI.enabled
              ? 'WebGL2 / stage 4 UI'
              : textRenderer && GPU_LINE.enabled
                ? 'WebGL2 / stage 3 text'
                : 'WebGL2 / stage 1';
        }
      })
      .catch(fail);
  }
  function applySceneUniforms(scene) {
    lastFrameScene = scene;
    paperState = paperValuesFor(scene);
  }
  function finishBackground(scene) {
    const bandFar = resolution.farBand.coverage,
      bandMid = resolution.midBand.coverage;
    if (farTarget) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, farTarget.fbo);
      gl.viewport(0, 0, farTarget.width, farTarget.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawFull(farProgram, farTarget, scene, [bandFar.worldY0, bandFar.worldY1], true);
    }
    if (midTarget) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, midTarget.fbo);
      gl.viewport(0, 0, midTarget.width, midTarget.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawFull(midProgram, midTarget, scene, [bandMid.worldY0, bandMid.worldY1], true);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, backgroundTarget.fbo);
    gl.viewport(0, 0, baseWidth, baseHeight);
    drawFull(backgroundProgram, backgroundTarget, scene, [bandFar.worldY0, bandFar.worldY1]);
  }
  function finishScene(scene) {
    drawCopy(sceneTarget, backgroundTarget);
    const dpr = world.W ? sceneTarget.width / world.W : presentationScale;
    const target = {
      texture: sceneTarget.texture,
      fbo: sceneTarget.fbo,
      width: sceneTarget.width,
      height: sceneTarget.height,
      dpr,
      cssWidth: world.W || innerWidth,
      cssHeight: world.H || innerHeight,
    };
    if (particles) particles.draw(target, drift, LAB.drift ? 1 : 0, world.W, world.H);
    if (textRenderer && textFrame && GPU_LINE.enabled) {
      textRenderer.draw(target, textFrame);
      GPU_LINE.ack(textFrame);
    }
    const uiActive = !!(uiRenderer && uiFrame && GPU_UI.enabled);
    if (uiActive) {
      const drawBoxParticlesGL = (options = {}) => {
        if (!particles) return;
        const boxTarget = options.target || target,
          boxOptions = { offsetX: options.offsetX || 0, offsetY: options.offsetY || 0, key: 'ui-box' };
        return particles.draw(
          boxTarget,
          boxDrift,
          options.fade || 0,
          options.W || world.W,
          options.H || world.H,
          boxOptions,
        );
      };
      uiRenderer.encode?.(target, uiFrame, {
        sceneTexture: sceneTarget.texture,
        width: sceneTarget.width,
        height: sceneTarget.height,
        dpr,
        drawBoxParticlesGL,
      });
      uiRenderer.draw(target, uiFrame);
      GPU_UI.ack(uiFrame);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(compositorVAO);
    gl.useProgram(copyProgram);
    bindTexture(0, sceneTarget.texture);
    if (copyLocations?.uSource != null) gl.uniform1i(copyLocations.uSource, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!sharing) gl.flush();
    frameSerial++;
    const actions = afterFrame.splice(0),
      mustValidate = firstFrame,
      checkErrors = mustValidate || debugGLCheckPending,
      label = debugGLCheckPending ? debugGLCheckLabel : 'first frame';
    firstFrame = false;
    if (mustValidate || actions.length || debugGLCheckPending) {
      debugGLCheckPending = false;
      afterFrameFence(renderGeneration, actions, checkErrors, label);
    }
    return true;
  }
  function drawLayerStaticTextures(program) {
    const map = locations(program);
    const names = ['uZ0', 'uJ0', 'uZ1', 'uJ1'];
    for (let i = 0; i < 8; i++) {
      bindTexture(i, ringTextures[i]);
      const name = i < 4 ? 'uZ' + i : 'uJ' + (i - 4);
      setSampler(map, name, i);
    }
  }

  try {
    backgroundProgram = glProgram(gl, GL_BACKGROUND_FRAGMENT, 'WebGL2 layered paper background');
    farProgram = glProgram(gl, glForestLayerFragment(0), 'WebGL2 far forest layer');
    midProgram = glProgram(gl, glForestLayerFragment(1), 'WebGL2 mid forest layer');
    requireActiveUniforms(
      backgroundProgram,
      [...GL_RING_SAMPLER_NAMES, 'uMtn', 'uPN', 'uFarTarget', 'uMidTarget'],
      'background shader',
    );
    requireActiveUniforms(farProgram, ['uZ0', 'uJ0', 'uPN'], 'far forest shader');
    requireActiveUniforms(midProgram, ['uZ1', 'uJ1', 'uPN'], 'mid forest shader');
    copyProgram = glProgram(gl, GL_COMPOSITOR_COPY_FRAGMENT, 'WebGL2 scene copy');
    compositorVAO = gl.createVertexArray();
    if (!compositorVAO) throw Error('WebGL2 could not allocate fullscreen vertex array');
    gl.bindVertexArray(compositorVAO);
    for (let i = 0; i < 8; i++) createStaticTexture(i, gl.CLAMP_TO_EDGE, gl.LINEAR);
    createStaticTexture(8, gl.CLAMP_TO_EDGE, gl.LINEAR);
    createStaticTexture(9, gl.REPEAT, gl.LINEAR);
    copyLocations = locations(copyProgram, ['uSource']);
    if (copyLocations.uSource != null) {
      gl.useProgram(copyProgram);
      gl.uniform1i(copyLocations.uSource, 0);
    }
    GPU_DIAG.backend = 'webgl2';
    GPU_DIAG.requested = true;
    GPU_DIAG.adapter = 'WebGL2 / ' + String(gl.getParameter(gl.RENDERER) || 'unknown renderer');
    GPU_DIAG.state = 'WebGL2 / initializing';
    GPU_DIAG.error = '';
    GPU_DIAG.upload = GPU_DIAG.upload || { samples: 0, slow: 0, worker: false, mode: 'mesh' };
    GPU_DIAG.tileSubmission = tileSubmission;
    GPU_DIAG.tileBacklog = tileBacklog.metadata;
    GPU_DIAG.tileOpening = tileOpeningStats;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    makeResolution(1, 1);
  } catch (error) {
    GPU_DIAG.backend = 'webgl2';
    GPU_DIAG.state = 'failed';
    GPU_DIAG.error = String(error?.message || error);
    for (const texture of ringTextures) if (texture) gl.deleteTexture(texture);
    for (const program of [backgroundProgram, farProgram, midProgram, copyProgram])
      if (program) gl.deleteProgram(program);
    if (compositorVAO) gl.deleteVertexArray(compositorVAO);
    canvas.removeEventListener?.('webglcontextlost', onContextLost, false);
    return null;
  }

  const api = {
    kind: 'webgl2',
    maxTex,
    format: 'rgba8unorm',
    tilePreprocessLimits: {
      maxTextureDimension2D: maxTex,
      maxStorageBufferBindingSize: 32 * 1024 * 1024,
      maxBufferSize: 32 * 1024 * 1024,
    },
    get valid() {
      return validated;
    },
    get presented() {
      return presented;
    },
    get lost() {
      return broken || !!gl.isContextLost?.();
    },
    get frameRoom() {
      return !broken && !disposed && !gl.isContextLost?.();
    },
    get queue() {
      return {
        onSubmittedWorkDone(callback) {
          const task = waitFence();
          if (typeof callback === 'function') task.then(callback);
          return task;
        },
      };
    },
    get meshPending() {
      return meshQueue.length + (activeMesh ? 1 : 0);
    },
    get uploading() {
      return this.meshPending;
    },
    get uploadUrgent() {
      return activeMesh?.job.pri === 0 || meshQueue.some(item => item.job.pri === 0);
    },
    get tilePlanningLimit() {
      return SITE_DEBUG && HASH.includes('debug') && GPU_DIAG.tileBacklogProbeDisabled
        ? 2
        : tileBacklog.metadata.planningLimit || 3;
    },
    setFrameCadence(ms) {
      if (Number.isFinite(ms) && ms >= 4 && ms <= 34) frameCadenceMs = ms;
    },
    setTilePrewarmMode(enabled) {
      tilePrewarmMode = enabled === true;
    },
    statics(packet) {
      if (broken || disposed) return;
      paperPacket = packet;
      bindTexture(9, ringTextures[9]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (packet.data)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          packet.width,
          packet.height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          packet.data,
        );
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, packet);
      markGLCheck('paper texture upload');
      updateBytes();
    },
    alloc(geo) {
      clearUploads();
      ringPhysical.length = 0;
      markGLCheck('ring allocation');
      const plans = geo.map((g, li) => {
        const scale = li === 0 ? sourceTileScales.farScale : li === 1 ? sourceTileScales.midScale : 1;
        const plan = gpuTileRasterPlan(g.T, g.Ht, g.pad, scale),
          ringWidth = g.n * plan.outputWidth;
        if (!Number.isSafeInteger(g.n) || g.n < 1 || ringWidth > maxTex || plan.outputHeight > maxTex)
          throw Error('Physical WebGL tile ring exceeds texture dimension limit');
        return { ...plan, ringWidth, slots: g.n };
      });
      ringPhysical.push(...plans);
      for (let unit = 0; unit < 8; unit++) {
        const texture = ringTextures[unit],
          plan = plans[unit % 4];
        bindTexture(unit, texture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          plan.ringWidth,
          plan.outputHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
      }
      GPU_DIAG.sourceTileResolution = {
        schema: 1,
        policy: 'source-root-raster-scale-v1',
        query: { ...sourceTileQuery },
        requested: { ...sourceTileScales },
        effective: { farScale: plans[0]?.scale ?? 1, midScale: plans[1]?.scale ?? 1, nearScale: 1, closeScale: 1 },
        meshOnly: true,
        meshEnabled: true,
        rasterScaling: sourceRasterScaling,
        rasterAA: sourceTileAntialias ? 'analytic' : 'off',
        nearForced1: true,
        closeForced1: true,
        worldGeometry: 'logical-original',
        groupAtlasResolution: 'original',
        layers: plans.map((p, li) => ({
          li,
          requestedScale: li === 0 ? sourceTileScales.farScale : li === 1 ? sourceTileScales.midScale : 1,
          effectiveScale: p.scale,
          physical: { width: p.outputWidth, height: p.outputHeight, ringWidth: p.ringWidth },
        })),
        logicalRingBytes: geo.reduce((n, g) => n + 2 * g.R * g.Ht * 4, 0),
        physicalRingBytes: plans.reduce((n, p) => n + 2 * p.ringWidth * p.outputHeight * 4, 0),
      };
      updateBytes();
    },
    mountains(packet) {
      mountainPacket = packet;
      const data = new Uint8ClampedArray(packet.Pw * packet.Ph * 4);
      for (let y = 0; y < packet.Ph; y++)
        for (let x = 0; x < packet.Pw; x++) {
          const from = y * packet.Pw + x,
            to = ((packet.Ph - 1 - y) * packet.Pw + x) * 4;
          data[to] = Math.max(0, Math.min(255, packet.dA[from] * 255));
          data[to + 1] = Math.max(0, Math.min(255, packet.dB[from] * 255));
          data[to + 3] = 255;
        }
      bindTexture(8, ringTextures[8]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, packet.Pw, packet.Ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
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
      makeResolution(baseWidth, baseHeight);
      return GPU_DIAG.backgroundResolution;
    },
    resize(w, h) {
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1)
        throw Error('Invalid WebGL2 compositor dimensions');
      makeResolution(Math.round(w), Math.round(h));
    },
    setTileOpeningMode(enabled) {
      tileOpeningMode = enabled === true;
      tileOpeningStats.enabled = tileOpeningMode;
      tileBacklog.reset();
      tileSubmission.limit = tileOpeningMode ? 16 : 2;
      return tileOpeningStats;
    },
    async prepareTiles(settings = {}) {
      if (typeof createGLTileRenderer !== 'function') throw Error('WebGL2 tile renderer module is unavailable');
      const made = await createGLTileRenderer(gl, {
        format: 'rgba8unorm',
        gpuPreparation: false,
        reuseResources: true,
        antialias: sourceTileAntialias,
        rasterScaling: sourceRasterScaling,
        stampField: settings.stampField,
        onError: fail,
      });
      if (broken || disposed) {
        made.dispose();
        throw Error('WebGL2 tile preparation was cancelled');
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
    reprioritizeTiles(priorityOfJob) {
      if (activeMesh) activeMesh.job.pri = priorityOfJob(activeMesh.job);
      for (const item of meshQueue) item.job.pri = priorityOfJob(item.job);
    },
    debugTileSnapshot() {
      const identity = item => {
        if (!item) return null;
        const job = item.job,
          ring = world.rings?.[job.sc]?.[job.li];
        return {
          era: job.era,
          id: job.id,
          sc: job.sc,
          li: job.li,
          k: job.k,
          slot: job.slot,
          pri: job.pri,
          live: liveMesh(item),
          wanted: ring?.want[job.slot] ?? null,
          has: ring?.has[job.slot] ?? null,
        };
      };
      const rendererJob = tileRenderer?.active,
        rendererTerminal = !!rendererJob && ['done', 'failed', 'cancelled'].includes(rendererJob.phase),
        rendererOwnerRequired = !!rendererJob && !rendererTerminal,
        active = identity(activeMesh),
        queued = meshQueue.map(identity),
        rendererOrphan = rendererOwnerRequired && !activeMesh,
        rendererIdentityMismatch =
          rendererOwnerRequired &&
          !!activeMesh &&
          rendererJob.settings?.jobId !== undefined &&
          rendererJob.settings.jobId !== activeMesh.job.id;
      const rings = [];
      let missingWanted = 0;
      for (const sc of ['zh', 'ja'])
        for (let li = 0; li < 4; li++) {
          const ring = world.rings?.[sc]?.[li];
          if (!ring) continue;
          const wanted = Array.from(ring.want),
            has = Array.from(ring.has);
          let missing = 0;
          for (let i = 0; i < wanted.length; i++) if (Number.isFinite(wanted[i]) && wanted[i] !== has[i]) missing++;
          missingWanted += missing;
          rings.push({ sc, li, wanted, has, missingWanted: missing });
        }
      const activeOrphan = !!active && !active.live,
        queuedOrphans = queued.filter(item => !item.live).length;
      return {
        active,
        queued,
        rings,
        missingWanted,
        opening: { ...tileOpeningStats },
        submission: { ...tileSubmission },
        orphans: {
          active: activeOrphan,
          queued: queuedOrphans,
          renderer: rendererOrphan,
          rendererIdentityMismatch,
          count: Number(activeOrphan) + queuedOrphans + Number(rendererOrphan) + Number(rendererIdentityMismatch),
        },
        renderer: rendererJob
          ? {
              id: rendererJob.id,
              jobId: rendererJob.settings?.jobId ?? null,
              phase: rendererJob.phase,
              terminal: rendererTerminal,
              ownerRequired: rendererOwnerRequired,
              iterations: rendererJob.iterations || 0,
              uploadIndex: rendererJob.uploadIndex || 0,
              stageIndex: rendererJob.stageIndex || 0,
              postIndex: rendererJob.postIndex || 0,
            }
          : null,
      };
    },
    renderMeshSlice(budget = {}) {
      if (!tileRenderer || broken || disposed) return { advanced: false };
      const startAt = performance.now();
      pruneMeshQueue();
      let started = false;
      if (!activeMesh && meshQueue.length) {
        let best = 0;
        for (let i = 1; i < meshQueue.length; i++) if (meshQueue[i].job.pri < meshQueue[best].job.pri) best = i;
        activeMesh = meshQueue.splice(best, 1)[0];
        const { job, mesh } = activeMesh,
          g = world.geo[job.li],
          physical = ringPhysical[job.li];
        if (!liveMesh(activeMesh)) {
          releaseActive();
          return { advanced: true };
        }
        if (!physical) throw Error('WebGL2 tile has no ring allocation plan');
        const startedAt = performance.now();
        tileRenderer.start(mesh, {
          width: g.T,
          height: g.Ht,
          pad: g.pad,
          sigma: LAYERS[job.li].blur * (world.H / 900) * g.ts,
          rasterScale: physical.scale,
          era: job.era,
          jobId: job.id,
        });
        activeMesh.cpu += performance.now() - startedAt;
        started = true;
      }
      const tile = activeMesh;
      if (!tile) return { advanced: started };
      const { job } = tile,
        ring = world.rings[job.sc]?.[job.li];
      if (job.era !== renderWorld.era || ring?.want[job.slot] !== job.k) {
        tileRenderer.cancel?.();
        releaseActive();
        return { advanced: true };
      }
      const previousPhase = tileRenderer.active?.phase;
      const result = tileRenderer.step({
        maxCPUms: budget.maxCPUms ?? 0.65,
        frameDeadline: budget.frameDeadline ?? Infinity,
        maxDraws: budget.maxDraws ?? 512,
        opening: tileOpeningMode,
      });
      const stepMs = performance.now() - startAt;
      tile.slices++;
      if (tile.lastRenderFrame !== frameSerial) {
        tile.lastRenderFrame = frameSerial;
        tile.frames++;
      }
      if (result?.encoded || result?.done) {
        tileSubmission.submitted++;
        tileSubmission.peak = Math.max(tileSubmission.peak, meshQueue.length + (activeMesh ? 1 : 0));
        if (tileOpeningMode) {
          tileOpeningStats.submitted++;
          if (result?.encoded) tileOpeningStats.untimestamped++;
        }
      }
      const slice = GPU_DIAG.meshSlices || (GPU_DIAG.meshSlices = []);
      slice.push({
        t: performance.now(),
        frame: frameSerial,
        id: result?.id ?? job.id,
        sc: job.sc,
        li: job.li,
        k: job.k,
        phase: result?.phase || tileRenderer.active?.phase,
        submitted: !!(result?.encoded || result?.done),
        done: !!result?.done,
        opening: tileOpeningMode,
        ms: stepMs,
        bytes: result?.uploadedBytes || 0,
        draws: result?.draws || 0,
      });
      if (slice.length > 600) slice.shift();
      if (result?.done) {
        const p = ringPhysical[job.li],
          target = ringTextures[unitOf(job.sc, job.li)],
          output = result.texture,
          outputFbo = output?.fbo;
        if (
          !p ||
          result.width !== p.outputWidth ||
          result.height !== p.outputHeight ||
          output?.width !== p.outputWidth ||
          output?.height !== p.outputHeight ||
          !outputFbo ||
          !target ||
          !Number.isInteger(job.slot) ||
          job.slot < 0 ||
          job.slot >= p.slots ||
          (job.slot + 1) * p.outputWidth > p.ringWidth
        )
          throw Error('WebGL2 tile output dimensions do not match physical ring slot');
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, outputFbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, job.slot * p.outputWidth, 0, 0, 0, p.outputWidth, p.outputHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        ring.has[job.slot] = job.k;
        DIAG.tiles++;
        tileRenderer.retireCPUViews?.();
        releaseTileDelivery(tile.mesh);
        markGLCheck('tile ring commit');
        const completed = GPU_DIAG.tileJobs || (GPU_DIAG.tileJobs = []);
        completed.push({
          id: result.id ?? job.id,
          era: job.era,
          sc: job.sc,
          li: job.li,
          k: job.k,
          slot: job.slot,
          workerMs: tile.ms,
          frames: tile.frames,
          slices: tile.slices,
          finished: performance.now(),
          productionJobId: job.id,
          ...(tileRenderer.metadata.lastJob || {}),
        });
        if (completed.length > 256) completed.shift();
        activeMesh = null;
        tileRenderer.submitted?.();
      }
      GPU_DIAG.upload.samples = (GPU_DIAG.upload.samples || 0) + Number(result?.uploads || 0);
      GPU_DIAG.bytes.tileRaster = tileRenderer.metadata?.byteCount || 0;
      const elapsed = performance.now() - startAt;
      tile?.cpu && (tile.cpu += elapsed);
      DIAG.up += elapsed;
      DIAG.upMax = Math.max(DIAG.upMax, elapsed);
      return {
        submitted: !!(result?.encoded || result?.done),
        uploadedBytes: result?.uploadedBytes || 0,
        estimatedGPUms: result?.estimatedGPUms || 0,
        advanced:
          started ||
          !!result?.advanced ||
          !!result?.uploads ||
          !!result?.allocationOperations ||
          previousPhase !== tileRenderer.active?.phase ||
          !!result?.done,
      };
    },
    renderMesh() {
      if (broken || disposed || !tileRenderer) return;
      const queued = activeMesh || meshQueue.length;
      if (!queued) return;
      const start = performance.now(),
        settings = updateTileBacklog(start),
        catchUp = settings.visibleMissing > 0 || (tilePrewarmMode && settings.wantedMissing > 0);
      const rounds = tileOpeningMode ? 16 : settings.rounds || 1,
        frameCPUms = tileOpeningMode
          ? 12
          : Math.min(
              rounds === 1 ? settings.cpuMs : settings.frameCPUms,
              frameCadenceMs && !catchUp ? Math.max(0.65, frameCadenceMs * 0.2) : Infinity,
            ),
        deadline = tileOpeningMode ? Infinity : start + frameCPUms;
      let uploadedBytes = 0,
        estimatedGPUms = 0;
      settings.batches++;
      if (tileOpeningMode) tileOpeningStats.batches++;
      for (let i = 0; i < rounds; i++) {
        if (!(activeMesh || meshQueue.length) || performance.now() >= deadline) break;
        const result = this.renderMeshSlice({
          maxCPUms: tileOpeningMode ? 12 : settings.cpuMs,
          frameDeadline: deadline,
          maxDraws: tileOpeningMode ? 4096 : 512,
        });
        settings.roundsRun++;
        uploadedBytes += result?.uploadedBytes || 0;
        estimatedGPUms += result?.estimatedGPUms || 0;
        if (tileOpeningMode) tileOpeningStats.rounds++;
        if (!result?.advanced) break;
      }
      Object.assign(settings, {
        lastFrameEstimatedGPUms: estimatedGPUms,
        lastFrameUploadBytes: uploadedBytes,
        lastFrameCPUAllowanceMs: frameCPUms,
        peakPlayPending: Math.max(settings.peakPlayPending || 0, meshQueue.length + (activeMesh ? 1 : 0)),
      });
    },
    uploadTiles() {
      if (activeMesh || meshQueue.length) this.renderMesh();
    },
    beginFrame() {
      sharing = true;
    },
    endFrame() {
      if (sharing) {
        sharing = false;
        gl.flush();
      }
      if (debugGLCheckPending) {
        const label = debugGLCheckLabel;
        debugGLCheckPending = false;
        afterFrameFence(renderGeneration, [], true, label);
      }
    },
    setTextFrame(frame) {
      textFrame = frame;
    },
    setUIFrame(frame) {
      if (frame && !uiFrame) {
        firstFrame = true;
        validated = false;
      }
      uiFrame = frame;
    },
    async prepareStartupRenderers() {
      const constructionScope = { active: true },
        timing = { mode: 'parallel-webgl2', started: performance.now(), ended: null, wallMs: null, jobs: [] };
      GPU_DIAG.rendererPreparation = timing;
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
      let results;
      try {
        results = await Promise.allSettled([
          task('particles', () => (particles ? null : api.prepareParticles(null, constructionScope))),
          task('text', () => textRenderer || api.prepareText(constructionScope)),
          task('ui', () => uiRenderer || api.prepareUI(constructionScope)),
        ]);
      } finally {
        constructionScope.active = false;
        timing.ended = performance.now();
        timing.wallMs = timing.ended - timing.started;
      }
      const failedResult = results.find(result => result.status === 'rejected');
      if (failedResult) throw failedResult.reason;
      if (broken || disposed) throw Error('WebGL2 startup renderer preparation was cancelled');
      return { text: textRenderer, ui: uiRenderer };
    },
    async prepareParticles(spr, constructionScope) {
      if (typeof createGLParticles !== 'function') throw Error('WebGL2 particle renderer module is unavailable');
      const made = await createGLParticles(gl, 'rgba8unorm', {
        motion: 'cpu-gl',
        constructionScope,
        debug: SITE_DEBUG,
      });
      try {
        await made.prepareGPU?.({ rng, rr, inkLeaf, petalPath });
        if (broken || disposed) throw Error('WebGL2 particle preparation was cancelled');
        particles = made;
        GPU_DIAG.particles = made.metadata;
        updateBytes();
      } catch (error) {
        made.dispose?.();
        throw error;
      }
    },
    stepParticles(frame) {
      if (!particles?.step) return false;
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
      particles?.restoreCPU?.();
    },
    async prepareText(constructionScope) {
      await glyphManifest();
      if (typeof createGLText !== 'function') throw Error('WebGL2 text renderer module is unavailable');
      const made = await createGLText(gl, 'rgba8unorm', { ...sharedPaper, glyphPreparation, constructionScope });
      if (broken || disposed) {
        made.dispose?.();
        throw Error('WebGL2 text preparation was cancelled');
      }
      textRenderer = made;
      GPU_DIAG.text = made.metadata;
      updateBytes();
      return made;
    },
    async prepareUI(constructionScope) {
      await glyphManifest();
      if (typeof createGLUI !== 'function') throw Error('WebGL2 UI renderer module is unavailable');
      const made = await createGLUI(gl, 'rgba8unorm', { ...sharedPaper, glyphPreparation, constructionScope });
      if (broken || disposed) {
        made.dispose?.();
        throw Error('WebGL2 UI preparation was cancelled');
      }
      uiRenderer = made;
      GPU_DIAG.ui = made.metadata;
      updateBytes();
      return made;
    },
    finish() {
      return waitFence();
    },
    presentFrame() {
      return false;
    },
    debugPresentationSnapshot() {
      return { textureCount: 0, mode: 'direct' };
    },
    render(scene) {
      if (broken || disposed || !ringTextures[8] || !ringTextures[9] || !backgroundTarget || !sceneTarget) return false;
      try {
        applySceneUniforms(scene);
        finishBackground(scene);
        finishScene(scene);
        if (textRenderer?.metadata && GPU_DIAG.bytes.text !== textRenderer.metadata.byteCount)
          GPU_DIAG.bytes.text = textRenderer.metadata.byteCount;
        if (uiRenderer?.metadata && GPU_DIAG.bytes.ui !== uiRenderer.metadata.byteCount)
          GPU_DIAG.bytes.ui = uiRenderer.metadata.byteCount;
        if (particles?.metadata && GPU_DIAG.bytes.particles !== particles.metadata.byteCount)
          GPU_DIAG.bytes.particles = particles.metadata.byteCount;
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    async ringPixels(sc, li) {
      await this.finish();
      const unit = unitOf(sc, li),
        p = ringPhysical[li],
        texture = ringTextures[unit];
      if (!p || !texture) throw Error('Invalid WebGL2 ring readback request');
      const fbo = gl.createFramebuffer(),
        pixels = new Uint8Array(p.ringWidth * p.outputHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        throw Error('WebGL2 ring readback framebuffer incomplete');
      }
      gl.readPixels(0, 0, p.ringWidth, p.outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      return glTopDownPixels(pixels, p.ringWidth, p.outputHeight);
    },
    async ringHash(sc, li) {
      return glHashBytes(await this.ringPixels(sc, li));
    },
    async debugTilePixels(sc, li, slot) {
      if (!SITE_DEBUG || !HASH.includes('debug')) throw Error('Tile readback requires #debug');
      const p = ringPhysical[li],
        texture = ringTextures[unitOf(sc, li)];
      if (!p || !texture || !Number.isInteger(slot) || slot < 0 || slot >= p.slots)
        throw Error('Invalid debug tile slot');
      await this.finish();
      const fbo = gl.createFramebuffer(),
        raw = new Uint8Array(p.outputWidth * p.outputHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        throw Error('WebGL2 tile readback framebuffer incomplete');
      }
      gl.readPixels(slot * p.outputWidth, 0, p.outputWidth, p.outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      return {
        width: p.outputWidth,
        height: p.outputHeight,
        pixels: glTopDownPixels(raw, p.outputWidth, p.outputHeight),
        format: 'rgba8unorm',
        alpha: 'premultiplied',
        rowOrder: 'top-to-bottom',
      };
    },
    abandon() {
      if (broken) return;
      broken = true;
      clearUploads();
      tileRenderer?.dispose?.();
      if (uiRenderer?.metadata?.atlasHandoffEnabled) uiRenderer.dispose?.();
      GPU_DIAG.tileAbandoned = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearUploads();
      tileRenderer?.dispose?.();
      uiRenderer?.dispose?.();
      textRenderer?.dispose?.();
      particles?.dispose?.();
      for (const texture of ringTextures) if (texture) gl.deleteTexture(texture);
      for (const target of [backgroundTarget, sceneTarget, farTarget, midTarget]) glDeleteTarget(gl, target);
      for (const program of [backgroundProgram, farProgram, midProgram, copyProgram])
        if (program) gl.deleteProgram(program);
      if (compositorVAO) gl.deleteVertexArray(compositorVAO);
      canvas.removeEventListener?.('webglcontextlost', onContextLost, false);
      GPU_DIAG.state = 'disposed';
    },
  };
  api.setTileOpeningMode(true);
  let glyphManifestPromise = null;
  const glyphPreparation = createGlyphPreparationService({
    fonts: self.fonts,
    nativePrewarm: true,
    validation: param('glyphvalidate') === 'all' ? 'all' : 'sample',
  });
  sharedPaper.glyphPreparation = glyphPreparation;
  const glyphManifest = () =>
    glyphManifestPromise ||
    (glyphManifestPromise = GPU_STARTUP.fontManifest().then(manifest => glyphPreparation.setFontManifest(manifest)));
  GPU_DIAG.glyphPreparation = glyphPreparation.metadata;
  const unguarded = {
    prepareTiles: api.prepareTiles,
    statics: api.statics,
    alloc: api.alloc,
    mountains: api.mountains,
    setBackgroundResolution: api.setBackgroundResolution,
    resize: api.resize,
    render: api.render,
    renderMesh: api.renderMesh,
    renderMeshSlice: api.renderMeshSlice,
    uploadTiles: api.uploadTiles,
  };
  for (const [name, impl] of Object.entries(unguarded))
    api[name] = function (...args) {
      if (broken || disposed) return;
      try {
        return impl.apply(api, args);
      } catch (error) {
        fail(error);
        if (name === 'prepareTiles') throw error;
        return undefined;
      }
    };
  GPU_DIAG.state = 'WebGL2 / validating first frame';
  return api;
}

function glColor(value) {
  return [value[0] / 255, value[1] / 255, value[2] / 255];
}
