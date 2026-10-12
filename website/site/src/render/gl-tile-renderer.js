async function createGLTileRenderer(gl, options = {}) {
  if (!gl || typeof gl.createVertexArray !== 'function' || typeof gl.drawArraysInstanced !== 'function')
    throw Error('A WebGL2 context is required for tile rendering');
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const requestedAA = options.antialias !== false;
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
  const colorSamples = gl.getInternalformatParameter?.(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) || [];
  const stencilSamples = gl.getInternalformatParameter?.(gl.RENDERBUFFER, gl.STENCIL_INDEX8, gl.SAMPLES) || [];
  const supports4x = maxSamples >= 4 && Array.from(colorSamples).includes(4) && Array.from(stencilSamples).includes(4);
  let antialias = requestedAA && supports4x,
    sampleCount = antialias ? 4 : 1;
  const metadata = {
    backend: 'webgl2-source-index-tables',
    antialias,
    sampleCount,
    aa: antialias ? '4x-msaa-stencil-paths-and-analytic-capsule-union' : '1x-stencil-paths-and-hard-capsule-union',
    aaRequested: requestedAA,
    aaCapability: supports4x ? '4x-rgba8-stencil8' : '1x-fallback',
    byteCount: 0,
    peakBytes: 0,
    bufferBytes: 0,
    textureBytes: 0,
    renderbufferBytes: 0,
    jobsStarted: 0,
    jobsCompleted: 0,
    jobsCancelled: 0,
    steps: 0,
    uploadedBytes: 0,
    uploadWrites: 0,
    draws: 0,
    stampDraws: 0,
    stampInstances: 0,
    stampFieldBytes: 0,
    stampFieldUploadBytes: 0,
    stampFieldUploads: 0,
    lastJob: null,
    warnings: [],
    lastStartCPUms: 0,
    lastStepCPUms: 0,
    maxTextureSize,
    maxSamples,
    stageTargets: 0,
    outputTargets: 0,
  };
  const resources = new Map();
  let disposed = false,
    active = null,
    completedTarget = null,
    sequence = 0;
  let currentProgram = null,
    currentArrayBuffer = null;

  const bytesFor = (kind, amount) => {
    metadata.byteCount += amount;
    metadata[kind] += amount;
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
  };
  const forgetBytes = (kind, amount) => {
    metadata.byteCount -= amount;
    metadata[kind] -= amount;
  };
  function captureGLState() {
    const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE),
      textureUnits = [...new Set([0, activeTexture - gl.TEXTURE0])],
      textures = [];
    for (const unit of textureUnits) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      textures.push({
        unit,
        texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
        texture2DArray: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),
      });
    }
    gl.activeTexture(activeTexture);
    const get = name => gl.getParameter(name);
    const enabled = name => gl.isEnabled(name);
    return {
      activeTexture,
      textures,
      framebufferRead: get(gl.READ_FRAMEBUFFER_BINDING),
      framebufferDraw: get(gl.DRAW_FRAMEBUFFER_BINDING),
      renderbuffer: get(gl.RENDERBUFFER_BINDING),
      viewport: get(gl.VIEWPORT),
      program: get(gl.CURRENT_PROGRAM),
      vao: get(gl.VERTEX_ARRAY_BINDING),
      arrayBuffer: get(gl.ARRAY_BUFFER_BINDING),
      vertexAttrib0: gl.getVertexAttrib(0, gl.CURRENT_VERTEX_ATTRIB),
      blend: enabled(gl.BLEND),
      depth: enabled(gl.DEPTH_TEST),
      cull: enabled(gl.CULL_FACE),
      stencil: enabled(gl.STENCIL_TEST),
      scissor: enabled(gl.SCISSOR_TEST),
      blendSrcRGB: get(gl.BLEND_SRC_RGB),
      blendDstRGB: get(gl.BLEND_DST_RGB),
      blendSrcAlpha: get(gl.BLEND_SRC_ALPHA),
      blendDstAlpha: get(gl.BLEND_DST_ALPHA),
      blendEqRGB: get(gl.BLEND_EQUATION_RGB),
      blendEqAlpha: get(gl.BLEND_EQUATION_ALPHA),
      colorMask: get(gl.COLOR_WRITEMASK),
      scissorBox: get(gl.SCISSOR_BOX),
      clearColor: get(gl.COLOR_CLEAR_VALUE),
      clearStencil: get(gl.STENCIL_CLEAR_VALUE),
      stencilFrontWrite: get(gl.STENCIL_WRITEMASK),
      stencilBackWrite: get(gl.STENCIL_BACK_WRITEMASK),
      stencilFrontFunc: get(gl.STENCIL_FUNC),
      stencilBackFunc: get(gl.STENCIL_BACK_FUNC),
      stencilFrontRef: get(gl.STENCIL_REF),
      stencilBackRef: get(gl.STENCIL_BACK_REF),
      stencilFrontValueMask: get(gl.STENCIL_VALUE_MASK),
      stencilBackValueMask: get(gl.STENCIL_BACK_VALUE_MASK),
      stencilFrontFail: get(gl.STENCIL_FAIL),
      stencilBackFail: get(gl.STENCIL_BACK_FAIL),
      stencilFrontDepthFail: get(gl.STENCIL_PASS_DEPTH_FAIL),
      stencilBackDepthFail: get(gl.STENCIL_BACK_PASS_DEPTH_FAIL),
      stencilFrontDepthPass: get(gl.STENCIL_PASS_DEPTH_PASS),
      stencilBackDepthPass: get(gl.STENCIL_BACK_PASS_DEPTH_PASS),
      unpackAlignment: get(gl.UNPACK_ALIGNMENT),
    };
  }
  function restoreGLState(state) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.framebufferRead);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.framebufferDraw);
    gl.bindRenderbuffer(gl.RENDERBUFFER, state.renderbuffer);
    gl.viewport(...state.viewport);
    gl.useProgram(state.program);
    gl.bindVertexArray(state.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
    if (state.vertexAttrib0) gl.vertexAttrib4fv(0, state.vertexAttrib0);
    for (const item of state.textures) {
      gl.activeTexture(gl.TEXTURE0 + item.unit);
      gl.bindTexture(gl.TEXTURE_2D, item.texture2D);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, item.texture2DArray);
    }
    gl.activeTexture(state.activeTexture);
    if (state.blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    if (state.depth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (state.cull) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);
    if (state.stencil) gl.enable(gl.STENCIL_TEST);
    else gl.disable(gl.STENCIL_TEST);
    if (state.scissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    gl.blendFuncSeparate(state.blendSrcRGB, state.blendDstRGB, state.blendSrcAlpha, state.blendDstAlpha);
    gl.blendEquationSeparate(state.blendEqRGB, state.blendEqAlpha);
    gl.colorMask(...state.colorMask);
    gl.scissor(...state.scissorBox);
    gl.clearColor(...state.clearColor);
    gl.clearStencil(state.clearStencil);
    gl.stencilMaskSeparate(gl.FRONT, state.stencilFrontWrite);
    gl.stencilMaskSeparate(gl.BACK, state.stencilBackWrite);
    gl.stencilFuncSeparate(gl.FRONT, state.stencilFrontFunc, state.stencilFrontRef, state.stencilFrontValueMask);
    gl.stencilFuncSeparate(gl.BACK, state.stencilBackFunc, state.stencilBackRef, state.stencilBackValueMask);
    gl.stencilOpSeparate(gl.FRONT, state.stencilFrontFail, state.stencilFrontDepthFail, state.stencilFrontDepthPass);
    gl.stencilOpSeparate(gl.BACK, state.stencilBackFail, state.stencilBackDepthFail, state.stencilBackDepthPass);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, state.unpackAlignment);
  }
  function resetGLStateAfterStep() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
  }
  function makeShader(type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw Error('Unable to allocate tile shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown GLSL compilation error';
      gl.deleteShader(shader);
      throw Error('Tile shader: ' + message);
    }
    return shader;
  }
  function makeProgram(vertexSource, fragmentSource, label) {
    const vs = makeShader(gl.VERTEX_SHADER, vertexSource),
      fs = makeShader(gl.FRAGMENT_SHADER, fragmentSource),
      program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw Error('Unable to allocate ' + label + ' program');
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Unknown GLSL link error';
      gl.deleteProgram(program);
      throw Error(label + ' program: ' + message);
    }
    return program;
  }
  const geometryVertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aPosition;
uniform int uQuad;
uniform vec4 uRect;
uniform vec4 uViewport;
uniform vec4 uUvRect;
out vec2 vLocal;
out vec2 vUv;
void main(){
  const vec2 q[6]=vec2[6](vec2(0.,0.),vec2(1.,0.),vec2(0.,1.),vec2(0.,1.),vec2(1.,0.),vec2(1.,1.));
  vec2 p=aPosition;
  vUv=vec2(0.);
  if(uQuad!=0){p=uRect.xy+q[gl_VertexID]*uRect.zw;vUv=uUvRect.xy+q[gl_VertexID]*uUvRect.zw;}
  vec2 pixel=p+uViewport.zw;
  gl_Position=vec4(pixel.x/uViewport.x*2.-1.,1.-pixel.y/uViewport.y*2.,0.,1.);
  vLocal=p;
}`;
  const geometryFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vLocal;
in vec2 vUv;
uniform int uMode;
uniform vec4 uRect;
uniform vec4 uViewport;
uniform vec4 uUvRect;
uniform float uAlpha;
uniform float uRadius;
uniform int uPointCount;
uniform vec2 uCapsulePoints[64];
uniform vec4 uPaint[16];
uniform sampler2D uGroup;
out vec4 outColor;
float paintF(int i){ return uPaint[i/4][i-4*(i/4)]; }
vec4 stopColor(int index){ int k=16+index*5; return vec4(paintF(k+1),paintF(k+2),paintF(k+3),paintF(k+4)); }
vec4 paintAt(vec2 p){
  int kind=int(uPaint[0].x+0.5); int count=clamp(int(uPaint[0].z+0.5),1,9); float t=0.;
  if(kind!=0){
    vec2 q=vec2(paintF(4)*p.x+paintF(6)*p.y+paintF(8),paintF(5)*p.x+paintF(7)*p.y+paintF(9));
    vec2 a=vec2(paintF(10),paintF(11)),d=vec2(paintF(12),paintF(13))-a,v=q-a;
    if(kind==1){float dd=dot(d,d);if(dd<1e-12)return vec4(0.);t=dot(v,d)/dd;}
    else {
      float r0=paintF(14),dr=paintF(15)-r0,aa=dot(d,d)-dr*dr,bb=-2.*(dot(v,d)+r0*dr),cc=dot(v,v)-r0*r0;
      if(abs(aa)<1e-8){if(abs(bb)<1e-8)return vec4(0.);t=-cc/bb;if(r0+t*dr<0.)return vec4(0.);}
      else {float disc=bb*bb-4.*aa*cc;if(disc<0.)return vec4(0.);float root=sqrt(max(0.,disc));float ta=(-bb-root)/(2.*aa),tb=(-bb+root)/(2.*aa);bool va=r0+ta*dr>=0.,vb=r0+tb*dr>=0.;if(!va&&!vb)return vec4(0.);t=va?ta:tb;if(va&&vb)t=max(ta,tb);}
    }
  }
  vec4 c=stopColor(0);
  for(int j=1;j<9;j++){if(j<count){float hi=paintF(16+j*5),lo=paintF(16+(j-1)*5);vec4 right=stopColor(j);if(t<hi){c=mix(c,right,clamp((t-lo)/max(hi-lo,1e-8),0.,1.));break;}c=right;}}
  float alpha=c.a*paintF(1);return vec4(c.rgb*alpha,alpha);
}
void main(){
  if(uMode==0){outColor=vec4(0.);return;}
  if(uMode==2){outColor=texture(uGroup,vec2(vUv.x,1.-vUv.y))*uAlpha;return;}
  if(uMode==3){
    float distanceToLine=1e20;
    for(int i=0;i<32;i++){if(i<uPointCount){vec2 a=uCapsulePoints[i*2],b=uCapsulePoints[i*2+1],d=b-a;float t=clamp(dot(vLocal-a,d)/max(dot(d,d),1e-12),0.,1.);distanceToLine=min(distanceToLine,length(vLocal-(a+d*t)));}}
    float coverage;
    if(uRadius>=0.) coverage=clamp(uRadius+0.5-distanceToLine,0.,min(1.,2.*uRadius));
    else coverage=distanceToLine<=-uRadius?1.:0.;
    if(coverage<=0.)discard;outColor=paintAt(vLocal)*coverage;return;
  }
  outColor=paintAt(vLocal);
}`;

  const stampVertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=1) in vec4 aS0; layout(location=2) in vec4 aS1; layout(location=3) in vec4 aS2; layout(location=4) in vec4 aS3;
layout(location=5) in vec4 aS4; layout(location=6) in vec4 aS5; layout(location=7) in vec4 aS6; layout(location=8) in vec4 aS7;
uniform vec4 uRect; uniform vec4 uViewport;
out vec2 vPoint; out vec4 vClip;
flat out vec4 vS0; flat out vec4 vS1; flat out vec4 vS2; flat out vec4 vS3;
flat out vec4 vS4; flat out vec4 vS5; flat out vec4 vS6; flat out vec4 vS7;
void main(){
  const vec2 q[6]=vec2[6](vec2(-1.,-1.),vec2(1.,-1.),vec2(-1.,1.),vec2(-1.,1.),vec2(1.,-1.),vec2(1.,1.));
  vec2 p; int kind=int(aS0.x+0.5);
  if(kind==5){float len=aS3.x,width=aS3.y*(1.+abs(aS3.w)),bend=aS3.z*len;vec2 lo=vec2(-1.5,min(0.,bend)-width-1.5),hi=vec2(len+1.5,max(0.,bend)+width+1.5);vec2 local=mix(lo,hi,q[gl_VertexID]*0.5+0.5);vec2 dir=aS2.zw;p=aS2.xy+dir*local.x+vec2(-dir.y,dir.x)*local.y;}
  else p=clamp(aS1.xy+q[gl_VertexID]*aS1.zw,uRect.xy,uRect.xy+uRect.zw);
  vec2 pixel=p+uViewport.zw;gl_Position=vec4(pixel.x/uViewport.x*2.-1.,1.-pixel.y/uViewport.y*2.,0.,1.);
  vPoint=p;vClip=vec4(uRect.xy,uRect.xy+uRect.zw);vS0=aS0;vS1=aS1;vS2=aS2;vS3=aS3;vS4=aS4;vS5=aS5;vS6=aS6;vS7=aS7;
}`;
  const stampFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vPoint; in vec4 vClip;
flat in vec4 vS0; flat in vec4 vS1; flat in vec4 vS2; flat in vec4 vS3;
flat in vec4 vS4; flat in vec4 vS5; flat in vec4 vS6; flat in vec4 vS7;
uniform sampler2DArray uStampField;
out vec4 outColor;
const float PI=3.141592653589793;
const vec3 SMALL0=vec3(221.,131.,156.)/255.; const vec3 SMALL1=vec3(241.,186.,201.)/255.;
const vec3 SMALL2=vec3(251.,229.,234.)/255.; const vec3 SMALL3=vec3(176.,66.,98.)/255.;
const vec3 LINE0=vec3(192.,104.,128.)/255.; const vec3 LINE1=vec3(44.,31.,34.)/255.;
vec4 st(int i,vec4 s[8]){return s[i];}
vec2 stampShape(vec4 m,vec2 d,int layer,float unit){vec2 u=vec2(dot(m.xy,d),dot(m.zw,d));vec2 origin=layer==0?vec2(-0.3,-0.8):vec2(-1.15,-0.8);vec2 uv=(u-origin)/1.6;vec2 tc=uv*256.-0.5;ivec2 base=ivec2(floor(tc));vec2 f=fract(tc);ivec2 p0=clamp(base,ivec2(0),ivec2(255)),p1=clamp(base+ivec2(1),ivec2(0),ivec2(255));vec4 a=mix(texelFetch(uStampField,ivec3(p0,layer),0),texelFetch(uStampField,ivec3(p1.x,p0.y,layer),0),f.x);vec4 b=mix(texelFetch(uStampField,ivec3(p0.x,p1.y,layer),0),texelFetch(uStampField,ivec3(p1,layer),0),f.x);vec4 t=mix(a,b,f.y);float beyond=max(max(-uv.x,uv.x-1.),max(-uv.y,uv.y-1.));float sd=t.r+max(beyond,0.)*1.6;float grow=length(vec2(m.x*t.g+m.z*t.b,m.y*t.g+m.w*t.b));float px=sd/max(grow,1e-6)/unit;return vec2(clamp(0.5-px,0.,1.),px);}
vec4 smallAlphas(vec4 s[8]){uint ab=uint(s[0].w),ch=uint(s[2].w);return vec4(float(ab&1023u),float(ab>>10u),float(ch&1023u),float(ch>>10u))/1000.;}
vec4 smallGradient(float t,vec4 a){vec4 x=vec4(SMALL0,a.x),y=vec4(SMALL1,a.y),z=vec4(SMALL2,a.z),color;if(t<0.36)color=mix(x,y,clamp(t/0.36,0.,1.));else color=mix(y,z,clamp((t-0.36)/0.64,0.,1.));return vec4(color.rgb*color.a,color.a);}
float leafProfile(float s){return pow(max(sin(PI*pow(0.035+0.965*s,0.62)),0.),1.08);}
float leafBand(float a,float b,float unit){return max(clamp(0.5+a/unit,0.,1.)+clamp(0.5+b/unit,0.,1.)-1.,0.);}
float leafCover(vec2 q,float len,float wid,float bend,float asym,float unit){float s=clamp(q.x/len,0.,1.);for(int k=0;k<2;k++){vec2 c=vec2(s*len,bend*len*s*s),t=vec2(len,2.*bend*len*s);s+=dot(q-c,t)/dot(t,t);}float sc=clamp(s,0.,1.);vec2 c=vec2(sc*len,bend*len*sc*sc),t=vec2(len,2.*bend*len*sc);float tl=length(t),off=dot(q-c,vec2(-t.y,t.x))/tl,h=wid*leafProfile(sc);return leafBand(h*(1.+asym)-off,h*(1.-asym)+off,unit)*leafBand(s*tl,(1.-s)*tl,unit);}
uint inkHash(ivec2 c){uint h=uint(c.x)*0x9E3779B1u+uint(c.y)*0x85EBCA77u;h^=h>>15u;h*=0x2C1B3C6Du;h^=h>>12u;h*=0x297A2D39u;h^=h>>15u;return h;}
float hash01(ivec2 c){return float(inkHash(c)>>8u)/16777216.;}
float inkNoise(vec2 p){vec2 c=floor(p),f=fract(p),u=f*f*(3.-2.*f);ivec2 i=ivec2(c);return mix(mix(hash01(i),hash01(i+ivec2(1,0)),u.x),mix(hash01(i+ivec2(0,1)),hash01(i+ivec2(1,1)),u.x),u.y);}
float inkPaper(float density,vec2 wp,float pu,float tooth){float th=0.55*inkNoise(wp/max(1.5*pu,2.))+0.45*inkNoise(wp/max(6.*pu,4.)+vec2(17.,43.));return clamp(density-tooth*pow(max(1.-density,0.),1.4)*1.7*(th-0.45)*density,0.,1.);}
float inkStreak(float t,float s,float seed){return smoothstep(0.42,0.62,inkNoise(vec2((t*0.5+0.5)*39.+seed*977.,s*4.+seed*131.)));}
vec4 inkLeaf(vec4 s[8],vec2 p,float unit){vec2 d=p-s[2].xy,dir=s[2].zw,q=vec2(dot(d,dir),dot(d,vec2(-dir.y,dir.x)));float len=s[3].x,wid=s[3].y,bend=s[3].z;vec4 col=s[4];float seed=s[5].z,pu=s[5].w,rim=s[6].x,dry=s[6].y;float a=clamp(q.x/len,0.,1.);for(int k=0;k<2;k++){vec2 c=vec2(a*len,bend*len*a*a),t=vec2(len,2.*bend*len*a);a+=dot(q-c,t)/dot(t,t);}float sc=clamp(a,0.,1.);vec2 c=vec2(sc*len,bend*len*sc*sc),tg=vec2(len,2.*bend*len*sc),normal=vec2(-tg.y,tg.x);float tl=length(tg),off=dot(q-c,normal)/tl;float profile=pow(max(1.-sc,0.)/0.8,1.25);if(sc<0.2)profile=pow(sc/0.2,0.45);float h=wid*profile*(1.+0.04*(2.*inkNoise((p-s[5].xy)/max(2.2*pu,2.))-1.));float cover=leafBand(h-off,h+off,unit)*leafBand(a*tl,(1.-a)*tl,unit);if(cover<=0.)return vec4(0.);float t=clamp(off/max(h,1e-4),-1.,1.),side=fract(seed*7.31)<0.5?-1.:1.;float tone=col.a*(1.1-0.3*sc)*(1.+0.2*side*t)+rim*smoothstep(0.6,0.95,abs(t))*(1.-sc);float density=cover*clamp(tone,0.,1.);density*=1.-dry*smoothstep(0.5,1.,sc)*inkStreak(t,sc,seed);float alpha=inkPaper(density,p-s[5].xy,pu,col.a<0.5?1.:0.5)*s[0].z;return vec4(col.rgb*alpha,alpha);}
vec4 inkStroke(vec4 s[8],vec2 p,float unit){vec2 P0=s[2].xy,P1=s[2].zw,P2=s[3].xy,A=P1-P0,B=P0-2.*P1+P2,C=P2-P1;uint flags=uint(s[6].w);float e0=dot(p-P0,A)/max(length(A),1e-4),e2=dot(P2-p,C)/max(length(C),1e-4),ends=1.;if((flags&1u)!=0u)ends*=clamp(0.5+e0/unit,0.,1.);else if(e0<0.)return vec4(0.);if((flags&2u)!=0u)ends*=clamp(0.5+e2/unit,0.,1.);else if(e2<=0.)return vec4(0.);vec2 chord=P2-P0;float u=clamp(dot(p-P0,chord)/max(dot(chord,chord),1e-6),0.,1.);for(int k=0;k<3;k++){vec2 c=P0+(2.*A+B*u)*u,t=A+B*u;u=clamp(u+0.5*dot(p-c,t)/max(dot(t,t),1e-6),0.,1.);}vec2 c=P0+(2.*A+B*u)*u,tv=A+B*u,tg=tv/max(length(tv),1e-4);float off=dot(p-c,vec2(-tg.y,tg.x)),w=mix(s[3].z,s[3].w,u);bool stalk=int(s[0].w+0.5)==1;if((flags&1u)!=0u&&!stalk)w*=pow(clamp(e0/(3.*w),0.,1.),0.6);float seed=s[5].z,pu=s[5].w;vec2 wp=p-s[5].xy;float sa=mix(s[6].x,s[6].y,u)+seed*613.,ink=s[7].x,bleed=s[7].y,side=s[7].z,base=s[4].a;float rag=2.*inkNoise(wp/max(2.2*pu,2.))-1.,wan=2.*inkNoise(wp/max(16.*pu,8.)+vec2(seed*53.,7.))-1.;float thin=1.-smoothstep(1.5,5.,w/pu),h=w*(1.+(0.012+0.03*ink+(0.05+0.08*thin)*bleed)*rag+0.1*ink*wan),hf=(1.25*w+1.6*pu)*(1.+0.14*rag+0.15*wan);if(stalk)hf=(1.1*w+3.*pu)*(1.+0.1*rag+0.12*wan);float tf=clamp(off/hf,-1.,1.),crept=leafBand(hf-off,hf+off,unit);if(crept<=0.)return vec4(0.);float t=clamp(off/max(h,1e-4),-1.,1.)*side,tone=base*(1.+(0.16+0.25*ink)*t)*(0.9+0.1*t*t)*(1.+(0.1+0.14*ink)*sin(sa/40.));if(stalk)tone=base*(0.6+0.4*pow(abs(t),1.6)+0.14*smoothstep(0.72,0.97,abs(t)))*(1.+0.15*t)*(1.+0.08*sin(sa/40.));float body=leafBand(h-off,h+off,unit)*clamp(tone,0.,1.);float hairs=inkNoise(vec2(off/max(1.3*pu,1.7*unit)+seed*977.,sa/70.));body*=1.-(0.1+0.25*ink)*smoothstep(0.42,0.62,hairs);body=inkPaper(body,wp,pu,0.35+0.4*ink);float fringe=inkPaper(crept*(stalk?0.36:0.17)*bleed*pow(max(1.-tf*tf,0.),0.6),wp,pu,1.);float density=body+fringe*(1.-body),alpha=density*ends*s[0].z;return vec4(s[4].rgb*alpha,alpha);}
vec4 leafColor(vec4 s[8],vec2 p,float unit){if(int(s[0].w+0.5)==2)return inkLeaf(s,p,unit);vec2 d=p-s[2].xy,dir=s[2].zw,q=vec2(dot(d,dir),dot(d,vec2(-dir.y,dir.x)));float len=s[3].x,wid=s[3].y,bend=s[3].z,asym=s[3].w,cover=leafCover(q,len,wid,bend,asym,unit);vec4 col=s[4];if(int(s[0].w+0.5)==1){float alpha=cover*col.a*s[0].z;return vec4(col.rgb*alpha,alpha);}float along=clamp(q.x/len,0.,1.),a=floor(col.a*1000.+0.5)/1000.,b=floor(col.a*0.93*1000.+0.5)/1000.,c=floor(col.a*0.62*1000.+0.5)/1000.;float ga=along<0.45?mix(a,b,along/0.45):mix(b,c,(along-0.45)/0.55);float base=cover*ga*s[0].z,over=leafCover(q-vec2(0.04*len,0.),0.8*len,0.55*wid,bend,0.6*asym,unit)*floor(col.a*0.1*1000.+0.5)/1000.*s[0].z,alpha=over+base*(1.-over);return vec4(col.rgb*alpha,alpha);}
vec4 stampColor(vec4 s[8],vec2 p,float unit){int kind=int(s[0].x+0.5);if(kind==5)return leafColor(s,p,unit);if(kind==6)return inkStroke(s,p,unit);
  if(kind==1){vec2 d=p-s[1].xy;float r=length(d);vec4 a=smallAlphas(s),petals=vec4(0.);for(int k=0;k<5;k++)petals=min(vec4(1.),petals+vec4(stampShape(s[3+k],d,0,unit).x));petals=smallGradient(r/s[2].x,a)*petals*s[0].z;float ha=a.w*clamp(0.5-(r-s[2].z)/unit,0.,1.)*s[0].z;vec4 heart=vec4(SMALL3*ha,ha);return heart+petals*(1.-heart.a);}
  if(kind==2&&(int(s[3].z+0.5)==2||s[4].y>0.)){vec2 sh=stampShape(s[2],p-s[3].xy,int(s[0].w+0.5),unit);int gradient=int(s[3].z+0.5);vec4 color=s[5];if(gradient==2||gradient==3){float t=length(p-s[3].xy)/s[4].x,middle=gradient==2?0.4:0.3;vec4 a=vec4(SMALL0,s[6].x),b=vec4(SMALL1,s[6].y),c=vec4(SMALL2,s[6].z);color=t<middle?mix(a,b,clamp(t/middle,0.,1.)):mix(b,c,clamp((t-middle)/(1.-middle),0.,1.));}vec4 fill=vec4(color.rgb*color.a,color.a)*sh.x*s[0].z;if(s[4].y<=0.)return fill;float lc=clamp(0.5-(abs(sh.y)-s[4].y/unit),0.,1.),la=lc*s[4].z*s[0].z;vec4 line=vec4((int(s[4].w+0.5)==4?LINE0:LINE1)*la,la);return line+fill*(1.-line.a);}
  if(kind==2){float cover=stampShape(s[2],p-s[3].xy,int(s[0].w+0.5),unit).x;if(int(s[3].z+0.5)==3){float t=length(p-s[3].xy)/s[4].x;vec4 a=vec4(SMALL0,s[6].x),b=vec4(SMALL1,s[6].y),c=vec4(SMALL2,s[6].z),color=t<0.4?mix(a,b,clamp(t/0.4,0.,1.)):mix(b,c,clamp((t-0.4)/0.6,0.,1.));return vec4(color.rgb*color.a,color.a)*cover*s[0].z;}vec4 color=s[5];return vec4(color.rgb*color.a,color.a)*cover*s[0].z;}
  if(kind==4){vec2 d=p-s[1].xy;int count=min(int(s[2].x+0.5),11);float distance=1e30;for(int k=0;k<11;k++){if(k<count){vec4 fields=s[2+(k+1)/2];vec2 end=(k%2==0)?fields.zw:fields.xy;float along=clamp(dot(d,end)/max(dot(end,end),1e-12),0.,1.);distance=min(distance,length(d-end*along)-s[2].y);}}float alpha=clamp(0.5-distance/unit,0.,1.)*s[0].z;vec3 lineColor=int(s[0].w+0.5)==4?LINE0:LINE1;return vec4(lineColor*alpha,alpha);}
  if(kind==3){
    vec4 m=s[2];vec2 d=p-s[3].xy,u=vec2(dot(m.xy,d),dot(m.zw,d));float r=length(u);int mode=int(s[3].z+0.5);
    if(mode==0||mode==2){vec2 g=u/max(r,1e-6);float grow=length(vec2(m.x*g.x+m.z*g.y,m.y*g.x+m.w*g.y)),px=(r-1.)/max(grow,1e-6)/unit,cover=clamp(0.5-px,0.,1.);
      if(mode==0){vec4 color=s[4];return vec4(color.rgb*color.a,color.a)*cover*s[0].z;}
      vec4 gm=s[6];vec2 rel=p-s[7].xy,q=vec2(dot(gm.xy,rel),dot(gm.zw,rel)),focus=vec2(0.3,-0.2),delta=-focus,v=q-focus;float aa=dot(delta,delta)-1.3*1.3,bb=-2.*dot(v,delta),cc=dot(v,v),t;if(abs(aa)<1e-8){if(abs(bb)<1e-8)return vec4(0.);t=-cc/bb;}else{float disc=bb*bb-4.*aa*cc;if(disc<0.)return vec4(0.);float root=sqrt(max(0.,disc)),ta=(-bb-root)/(2.*aa),tb=(-bb+root)/(2.*aa);if(max(ta,tb)<0.)return vec4(0.);t=max(ta,tb);}vec4 color=mix(s[4],s[5],clamp(t,0.,1.));return vec4(color.rgb*color.a,color.a)*cover*s[0].z;
    }
    if(mode!=1)return vec4(0.);float t=length(u);vec4 a=s[4],b=s[5],c=mix(b,vec4(b.rgb,0.),clamp((t-0.55)/0.45,0.,1.));vec4 color=t<0.55?mix(a,b,clamp(t/0.55,0.,1.)):c;float alpha=color.a*s[0].z;return vec4(color.rgb*alpha,alpha);
  }
  return vec4(0.);
}
void main(){vec4 s[8];s[0]=vS0;s[1]=vS1;s[2]=vS2;s[3]=vS3;s[4]=vS4;s[5]=vS5;s[6]=vS6;s[7]=vS7;int kind=int(s[0].x+0.5);if(kind==5&&(any(lessThan(vPoint,vClip.xy))||any(greaterThanEqual(vPoint,vClip.zw)))){outColor=vec4(0.);return;}float unit=max(abs(dFdx(vPoint.x)),abs(dFdy(vPoint.y)));outColor=stampColor(s,vPoint,max(unit,1e-4));}`;
  const postVertex = `#version 300 es
precision highp float;
void main(){const vec2 p[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));gl_Position=vec4(p[gl_VertexID],0.,1.);}`;
  const postFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uInput;
uniform ivec2 uStageSize;
uniform ivec2 uOutputSize;
uniform ivec2 uPad;
uniform float uSigma;
uniform int uFinal;
out vec4 outColor;
vec4 pixel(ivec2 p){if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,uStageSize)))return vec4(0.);return texelFetch(uInput,p,0);}
void main(){ivec2 outPixel=ivec2(gl_FragCoord.xy),base=outPixel,axis=ivec2(1,0);if(uFinal!=0){int logicalTopY=uOutputSize.y-1-outPixel.y;base=ivec2(outPixel.x+uPad.x,uStageSize.y-1-(logicalTopY+uPad.y));axis=ivec2(0,1);}if(uSigma<=0.01){outColor=pixel(base);return;}int radius=min(64,int(ceil(3.*uSigma)));vec4 sum=vec4(0.);float weight=0.;for(int k=-64;k<=64;k++){if(abs(k)<=radius){float f=float(k),w=exp(-0.5*f*f/(uSigma*uSigma));sum+=pixel(base+axis*k)*w;weight+=w;}}outColor=sum/max(weight,1e-8);}`;

  let geometryProgram, stampProgram, postProgram, vao, stampVao, stampFieldTexture;
  const capsulePointsScratch = new Float32Array(128);
  let geometryUniforms = {},
    stampUniforms = {},
    postUniforms = {};
  function uniforms(program, names) {
    const out = Object.create(null);
    for (const requestedName of names) {
      const name = requestedName.replace(/\[0\]$/, '');
      const location = gl.getUniformLocation(program, requestedName);
      if (location === null) throw Error('Tile shader uniform unavailable: ' + requestedName);
      const alias = name.startsWith('u') ? name[1].toLowerCase() + name.slice(2) : name;
      out[name] = location;
      out[alias] = location;
    }
    return out;
  }
  try {
    const initState = captureGLState();
    try {
      geometryProgram = makeProgram(geometryVertex, geometryFragment, 'tile geometry');
      stampProgram = makeProgram(stampVertex, stampFragment, 'tile stamps');
      postProgram = makeProgram(postVertex, postFragment, 'tile postprocess');
      geometryUniforms = uniforms(geometryProgram, [
        'uQuad',
        'uRect',
        'uViewport',
        'uUvRect',
        'uMode',
        'uAlpha',
        'uRadius',
        'uPointCount',
        'uCapsulePoints[0]',
        'uPaint[0]',
        'uGroup',
      ]);
      stampUniforms = uniforms(stampProgram, ['uRect', 'uViewport', 'uStampField']);
      postUniforms = uniforms(postProgram, ['uInput', 'uStageSize', 'uOutputSize', 'uPad', 'uSigma', 'uFinal']);
      vao = gl.createVertexArray();
      stampVao = gl.createVertexArray();
      if (!vao || !stampVao) throw Error('Unable to allocate tile vertex arrays');
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0);
      gl.bindVertexArray(stampVao);
      for (let i = 1; i <= 8; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribDivisor(i, 1);
      }
    } finally {
      restoreGLState(initState);
    }
    const fieldBegin = clock();
    if (typeof options.stampField !== 'function') throw Error('Tile stamp field provider is required');
    const field = await options.stampField();
    if (
      field?.width !== 256 ||
      field.height !== 256 ||
      field.layers !== 2 ||
      field.format !== 'rgba16float' ||
      !(field.pixels instanceof Uint16Array) ||
      field.pixels.length !== 256 * 256 * 2 * 4
    )
      throw Error('Invalid tile stamp field');
    const uploadState = captureGLState();
    try {
      stampFieldTexture = gl.createTexture();
      if (!stampFieldTexture) throw Error('Unable to allocate tile stamp field texture');
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, stampFieldTexture);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA16F, 256, 256, 2, 0, gl.RGBA, gl.HALF_FLOAT, field.pixels);
      metadata.stampFieldBytes = field.pixels.byteLength;
      metadata.stampFieldUploadBytes = field.pixels.byteLength;
      metadata.stampFieldUploads = 1;
      bytesFor('textureBytes', field.pixels.byteLength);
      metadata.stampField = {
        width: 256,
        height: 256,
        layers: 2,
        format: 'rgba16float',
        bytes: field.pixels.byteLength,
        buildMs: Number.isFinite(field.buildMs) ? field.buildMs : null,
        requestWallMs: clock() - fieldBegin,
        persistent: true,
      };
    } finally {
      restoreGLState(uploadState);
    }
  } catch (error) {
    if (stampFieldTexture) gl.deleteTexture(stampFieldTexture);
    if (vao) gl.deleteVertexArray(vao);
    if (stampVao) gl.deleteVertexArray(stampVao);
    if (geometryProgram) gl.deleteProgram(geometryProgram);
    if (stampProgram) gl.deleteProgram(stampProgram);
    if (postProgram) gl.deleteProgram(postProgram);
    throw error;
  }

  function ownBuffer(job, bytes) {
    const handle = gl.createBuffer();
    if (!handle) throw Error('Unable to allocate tile buffer');
    job.buffers.push({ handle, bytes });
    bytesFor('bufferBytes', bytes);
    return handle;
  }
  function deleteBuffer(row) {
    if (!row || row.deleted) return;
    row.deleted = true;
    gl.deleteBuffer(row.handle);
    forgetBytes('bufferBytes', row.bytes);
  }
  function deleteTarget(target) {
    if (!target || target.deleted) return;
    target.deleted = true;
    for (const fbo of new Set([target.drawFbo, target.resolveFbo, target.fbo])) if (fbo) gl.deleteFramebuffer(fbo);
    if (target.texture) gl.deleteTexture(target.texture);
    if (target.colorBuffer) gl.deleteRenderbuffer(target.colorBuffer);
    if (target.stencilBuffer) gl.deleteRenderbuffer(target.stencilBuffer);
    forgetBytes('textureBytes', target.textureBytes || 0);
    forgetBytes('renderbufferBytes', target.renderbufferBytes || 0);
    if (target.kind === 'output') metadata.outputTargets = Math.max(0, metadata.outputTargets - 1);
    else metadata.stageTargets = Math.max(0, metadata.stageTargets - 1);
  }
  function makeTarget(width, height, kind, withStencil = true) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > maxTextureSize ||
      height > maxTextureSize
    )
      throw Error('Tile target exceeds WebGL texture dimensions: ' + width + 'x' + height);
    const texture = gl.createTexture();
    if (!texture) throw Error('Unable to allocate tile texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const resolveFbo = gl.createFramebuffer();
    if (!resolveFbo) throw Error('Unable to allocate tile framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    let drawFbo = resolveFbo,
      colorBuffer = null,
      stencilBuffer = null,
      renderbufferBytes = 0;
    if (withStencil && antialias) {
      drawFbo = gl.createFramebuffer();
      colorBuffer = gl.createRenderbuffer();
      stencilBuffer = gl.createRenderbuffer();
      if (!drawFbo || !colorBuffer || !stencilBuffer) throw Error('Unable to allocate multisample tile target');
      gl.bindFramebuffer(gl.FRAMEBUFFER, drawFbo);
      gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.RGBA8, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorBuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, stencilBuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 4, gl.STENCIL_INDEX8, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencilBuffer);
      renderbufferBytes = width * height * 5 * 4;
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(drawFbo);
        gl.deleteRenderbuffer(colorBuffer);
        gl.deleteRenderbuffer(stencilBuffer);
        gl.deleteFramebuffer(resolveFbo);
        gl.deleteTexture(texture);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        if (metadata.stageTargets || metadata.outputTargets)
          throw Error('A later tile target could not retain the selected 4x MSAA mode');
        antialias = false;
        sampleCount = 1;
        metadata.antialias = false;
        metadata.sampleCount = 1;
        metadata.aa = '1x-stencil-paths-and-hard-capsule-union';
        metadata.aaCapability = '4x-allocation-fallback';
        return makeTarget(width, height, kind, withStencil);
      }
    } else if (withStencil) {
      drawFbo = resolveFbo;
      stencilBuffer = gl.createRenderbuffer();
      if (!stencilBuffer) throw Error('Unable to allocate tile stencil buffer');
      gl.bindFramebuffer(gl.FRAMEBUFFER, drawFbo);
      gl.bindRenderbuffer(gl.RENDERBUFFER, stencilBuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencilBuffer);
      renderbufferBytes = width * height;
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (drawFbo !== resolveFbo) gl.deleteFramebuffer(drawFbo);
      gl.deleteFramebuffer(resolveFbo);
      gl.deleteTexture(texture);
      if (colorBuffer) gl.deleteRenderbuffer(colorBuffer);
      if (stencilBuffer) gl.deleteRenderbuffer(stencilBuffer);
      throw Error('Tile framebuffer is incomplete');
    }
    const target = {
      texture,
      fbo: resolveFbo,
      drawFbo,
      resolveFbo,
      colorBuffer,
      stencilBuffer,
      width,
      height,
      kind,
      textureBytes: width * height * 4,
      renderbufferBytes,
      cleared: false,
    };
    bytesFor('textureBytes', target.textureBytes);
    bytesFor('renderbufferBytes', renderbufferBytes);
    if (kind === 'output') metadata.outputTargets++;
    else metadata.stageTargets++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return target;
  }
  function ensurePlan(packet, settings) {
    const p = packet?.preprocessed;
    if (
      ![1, 2].includes(packet?.version) ||
      !(packet.vertices instanceof Float32Array) ||
      packet.vertices.length % 2 ||
      !(packet.paints instanceof Float32Array) ||
      packet.paints.length % 64 ||
      (!(packet.stamps instanceof Float32Array) && packet.stamps !== undefined) ||
      packet.stamps?.length % 32
    )
      throw Error('Invalid source tile packet');
    if (
      !p ||
      p.version !== 2 ||
      p.storage !== 'wasm-index-tables' ||
      p.consumed ||
      p.gpuPreparation ||
      p.gpuOpCount !== 0
    )
      throw Error('WebGL2 tile renderer requires a source-only wasm-index-tables plan');
    if (
      p.packetVersion !== packet.version ||
      p.width !== packet.width ||
      p.height !== packet.height ||
      p.vertexLength !== packet.vertices.length ||
      p.paintLength !== packet.paints.length ||
      p.stampLength !== (packet.stamps?.length || 0)
    )
      throw Error('Tile plan does not match its source packet');
    if (
      ![p.opCount, p.nodeCount, p.stageCount].every(Number.isSafeInteger) ||
      p.opCount < 0 ||
      p.nodeCount < 1 ||
      p.stageCount < 1 ||
      !(p.opData instanceof Uint32Array) ||
      p.opData.length !== p.opCount * 12 ||
      !(p.nodeData instanceof Uint32Array) ||
      p.nodeData.length !== p.nodeCount * 8 ||
      !(p.nodeOps instanceof Uint32Array) ||
      p.nodeOps.length !== p.opCount ||
      !(p.stageData instanceof Uint32Array) ||
      p.stageData.length !== p.stageCount * 6 ||
      !(p.stageNodes instanceof Uint32Array) ||
      !(p.recordData instanceof Float32Array) ||
      p.recordData.length !== Math.max(16, p.opCount * 16)
    )
      throw Error('Invalid indexed source tile plan tables');
    for (let i = 0; i < p.nodeCount; i++) {
      const k = i * 8,
        first = p.nodeData[k + 5],
        count = p.nodeData[k + 6];
      if (first + count > p.nodeOps.length) throw Error('Indexed source node operation range is invalid');
      for (let j = 0; j < count; j++)
        if (p.nodeOps[first + j] >= p.opCount) throw Error('Indexed source node references an invalid operation');
    }
    for (let i = 0; i < p.stageCount; i++) {
      const k = i * 6,
        first = p.stageData[k + 2],
        count = p.stageData[k + 3];
      if (
        !(p.stageData[k] > 0 && p.stageData[k + 1] > 0) ||
        first + count > p.stageNodes.length ||
        p.stageData[k + 4] > 1
      )
        throw Error('Indexed source stage range is invalid');
      for (let j = 0; j < count; j++)
        if (p.stageNodes[first + j] >= p.nodeCount) throw Error('Indexed source stage references an invalid node');
    }
    for (let i = 0; i < p.opCount; i++) {
      const k = i * 12,
        kind = p.opData[k],
        flags = p.opData[k + 1],
        first = p.opData[k + 2],
        count = p.opData[k + 3],
        paint = p.opData[k + 10];
      if (![1, 2, 3, 5].includes(kind) || (flags & ~15) !== 0)
        throw Error('Unsupported indexed source operation kind or flags');
      if (flags & 1) continue;
      if ((kind === 1 || kind === 2) && paint >= packet.paints.length / 64)
        throw Error('Indexed source operation paint is out of range');
      if (kind === 1 && (first + count > packet.vertices.length / 2 || count % 3 !== 0))
        throw Error('Indexed source path vertex range is invalid');
      if (kind === 2 && (count > 32 || first + count * 2 > packet.vertices.length / 2))
        throw Error('Indexed source capsule range is invalid');
      if (kind === 3 && p.opData[k + 5] >= p.nodeCount) throw Error('Indexed source group child is invalid');
      if (kind === 5 && first + count > (packet.stamps?.length || 0) / 32)
        throw Error('Indexed source stamp range is invalid');
    }
    const end = (p.stageCount - 1) * 6;
    if (
      p.stageData[end] !== packet.width ||
      p.stageData[end + 1] !== packet.height ||
      p.stageData[end + 3] !== 1 ||
      p.stageData[end + 4] !== 1 ||
      p.stageNodes[p.stageData[end + 2]] !== 0 ||
      p.nodeData[0] !== p.stageCount - 1
    )
      throw Error('Indexed source plan has no root tile stage');
    const width = Math.round(settings.width ?? packet.width),
      height = Math.round(settings.height ?? packet.height),
      pad = Math.round(settings.pad || 0),
      sigma = Number(settings.sigma || 0),
      scale =
        Number.isFinite(settings.rasterScale) && settings.rasterScale >= 0.5 && settings.rasterScale <= 1
          ? settings.rasterScale
          : 1;
    if (!(
      width > 0 &&
      height > 0 &&
      pad >= 0 &&
      sigma >= 0 &&
      sigma <= 64 / 3 &&
      packet.width === width + pad * 2 &&
      packet.height === height + pad * 2
    ))
      throw Error('Tile crop/blur dimensions do not match packet');
    if (packet.width > maxTextureSize || packet.height > maxTextureSize)
      throw Error('Tile packet exceeds WebGL texture dimensions');
    const outputWidth = Math.max(1, Math.round(width * scale)),
      outputHeight = Math.max(1, Math.round(height * scale)),
      sx = outputWidth / width,
      sy = outputHeight / height,
      padX = Math.ceil(pad * sx),
      padY = Math.ceil(pad * sy);
    const raster = {
      scale,
      sx,
      sy,
      outputWidth,
      outputHeight,
      padX,
      padY,
      stageWidth: outputWidth + padX * 2,
      stageHeight: outputHeight + padY * 2,
      viewport: {
        x: padX - pad * sx,
        y: padY - pad * sy,
        width: (width + pad * 2) * sx,
        height: (height + pad * 2) * sy,
      },
    };
    return { p, width, height, pad, sigma, raster };
  }
  function prepareJob(packet, settings) {
    const dims = ensurePlan(packet, settings),
      p = dims.p,
      job = {
        id: ++sequence,
        packet,
        plan: p,
        settings: { width: dims.width, height: dims.height, pad: dims.pad, sigma: dims.sigma, raster: dims.raster },
        phase: 'upload-allocate',
        stageIndex: 0,
        nodeIndex: 0,
        opIndex: 0,
        postIndex: 0,
        postRow: 0,
        postPrepared: false,
        stages: [],
        targets: [],
        buffers: [],
        uploads: [],
        uploadIndex: 0,
        output: null,
        blurTarget: null,
        stageTarget: null,
        stats: {
          ...(p.stats || {}),
          id: sequence,
          phase: 'upload-allocate',
          draws: 0,
          passes: 0,
          steps: 0,
          uploadedBytes: 0,
          stampInstances: (packet.stamps?.length || 0) / 32,
          stampBytes: packet.stamps?.byteLength || 0,
          stampDraws: 0,
          raster: {
            ...dims.raster,
            logicalWidth: dims.width,
            logicalHeight: dims.height,
            logicalPad: dims.pad,
            logicalStageWidth: packet.width,
            logicalStageHeight: packet.height,
            rootOnly: true,
            groupAtlasScaled: false,
            geometryScaled: false,
            packetChanged: false,
          },
        },
      };
    for (let i = 0; i < p.stageCount; i++) {
      const k = i * 6;
      job.stages.push({
        width: p.stageData[k],
        height: p.stageData[k + 1],
        nodeFirst: p.stageData[k + 2],
        nodeCount: p.stageData[k + 3],
        kind: p.stageData[k + 4] ? 'tile' : 'atlas',
        completed: false,
        target: null,
      });
    }
    job.tileStage = job.stages[job.stages.length - 1];
    job.stageUsers = new Uint32Array(p.stageCount);
    for (let i = 0; i < p.opCount; i++) {
      const k = i * 12;
      if (p.opData[k] === 3 && !(p.opData[k + 1] & 1)) {
        const child = p.opData[k + 5];
        if (child < p.nodeCount) job.stageUsers[p.nodeData[child * 8]]++;
      }
    }
    job.stats.preprocessMode = 'worker';
    job.stats.commandStorage = p.storage;
    job.stats.foregroundPathObjects = 0;
    job.stats.foregroundAtlasObjects = p.stageCount;
    const vertexBuffer = ownBuffer(job, Math.max(8, packet.vertices.byteLength));
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, Math.max(8, packet.vertices.byteLength), gl.DYNAMIC_DRAW);
    job.vertexBuffer = vertexBuffer;
    job.uploads.push({ buffer: vertexBuffer, data: packet.vertices, offset: 0 });
    if (packet.stamps?.length) {
      const stampBuffer = ownBuffer(job, packet.stamps.byteLength);
      gl.bindBuffer(gl.ARRAY_BUFFER, stampBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packet.stamps.byteLength, gl.DYNAMIC_DRAW);
      job.stampBuffer = stampBuffer;
      job.uploads.push({ buffer: stampBuffer, data: packet.stamps, offset: 0 });
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return job;
  }
  function releaseJob(job, preserveOutput = false) {
    if (!job) return;
    for (const target of job.targets) if (target && (!preserveOutput || target !== job.output)) deleteTarget(target);
    for (const row of job.buffers) deleteBuffer(row);
    if (job.output && !job.targets.includes(job.output) && !preserveOutput) deleteTarget(job.output);
    job.targets.length = 0;
    job.buffers.length = 0;
    job.uploads.length = 0;
  }
  function cancel() {
    if (!active) return;
    const job = active;
    active = null;
    if (job.phase !== 'done') metadata.jobsCancelled++;
    releaseJob(job);
    metadata.lastCancelCPUms = 0;
  }
  function start(packet, settings = {}) {
    if (disposed) throw Error('Tile renderer disposed');
    const begin = clock();
    cancel();
    if (completedTarget) {
      deleteTarget(completedTarget);
      completedTarget = null;
    }
    const job = prepareJob(packet, settings);
    active = job;
    metadata.jobsStarted++;
    metadata.stampInstances += job.stats.stampInstances;
    metadata.lastStartCPUms = clock() - begin;
    metadata.lastJob = { ...job.stats, phase: job.phase };
    return job;
  }
  function setupGeometryTarget(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.drawFbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
  }
  function clearTarget(target) {
    setupGeometryTarget(target);
    gl.scissor(0, 0, target.width, target.height);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | (target.stencilBuffer ? gl.STENCIL_BUFFER_BIT : 0));
    target.cleared = true;
  }
  function setNodeClip(job, target, node, stage) {
    const nd = node * 8,
      x = job.plan.nodeData[nd + 1],
      y = job.plan.nodeData[nd + 2],
      w = job.plan.nodeData[nd + 3],
      h = job.plan.nodeData[nd + 4];
    if (stage.kind === 'tile') gl.scissor(0, 0, target.width, target.height);
    else gl.scissor(x, target.height - y - h, w, h);
  }
  function setPaint(index, paintData, loc) {
    gl.uniform4fv(loc, paintData.subarray(index * 64, index * 64 + 64));
  }
  function setView(job, target, op, uniforms) {
    const r = op * 16,
      d = job.plan.recordData;
    gl.uniform4f(uniforms.rect, d[r], d[r + 1], d[r + 2], d[r + 3]);
    gl.uniform4f(uniforms.viewport, d[r + 4], d[r + 5], d[r + 6], d[r + 7]);
  }
  function drawQuad() {
    gl.disableVertexAttribArray(0);
    gl.vertexAttrib2f(0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enableVertexAttribArray(0);
  }
  function bindGeometry(job) {
    gl.useProgram(geometryProgram);
    currentProgram = geometryProgram;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, job.vertexBuffer);
    currentArrayBuffer = job.vertexBuffer;
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.enableVertexAttribArray(0);
  }
  function drawOne(job, stage, node, opIndex) {
    const p = job.plan,
      k = opIndex * 12,
      od = p.opData,
      kind = od[k],
      flags = od[k + 1],
      r = opIndex * 16;
    if (flags & 1) return 0;
    const target = stage.target,
      d = p.recordData;
    setupGeometryTarget(target);
    setNodeClip(job, target, node, stage);
    if (stage.kind === 'tile') {
      const v = job.settings.raster.viewport;
      gl.viewport(
        Math.round(v.x),
        Math.round(target.height - v.y - v.height),
        Math.round(v.width),
        Math.round(v.height),
      );
    } else gl.viewport(0, 0, target.width, target.height);
    if (!(d[r + 2] > 0 && d[r + 3] > 0)) return 0;
    if (kind === 5) {
      const count = od[k + 3];
      if (!count) return 0;
      const u = stampUniforms;
      gl.useProgram(stampProgram);
      currentProgram = stampProgram;
      gl.bindVertexArray(stampVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, job.stampBuffer);
      currentArrayBuffer = job.stampBuffer;
      for (let i = 0; i < 8; i++) {
        gl.vertexAttribPointer(i + 1, 4, gl.FLOAT, false, 128, od[k + 2] * 128 + i * 16);
        gl.enableVertexAttribArray(i + 1);
        gl.vertexAttribDivisor(i + 1, 1);
      }
      gl.uniform4f(u.rect, d[r], d[r + 1], d[r + 2], d[r + 3]);
      gl.uniform4f(u.viewport, d[r + 4], d[r + 5], d[r + 6], d[r + 7]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, stampFieldTexture);
      gl.uniform1i(u.stampField, 0);
      gl.stencilMask(0);
      gl.disable(gl.STENCIL_TEST);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.enable(gl.STENCIL_TEST);
      job.stats.stampDraws++;
      job.stats.stampDrawInstances += count;
      metadata.stampDraws++;
      return 1;
    }
    bindGeometry(job);
    const u = geometryUniforms;
    gl.uniform4f(u.rect, d[r], d[r + 1], d[r + 2], d[r + 3]);
    gl.uniform4f(u.viewport, d[r + 4], d[r + 5], d[r + 6], d[r + 7]);
    if (kind === 1) {
      const first = od[k + 2],
        count = od[k + 3],
        paint = od[k + 10];
      setPaint(paint, job.packet.paints, u.paint);
      gl.uniform1i(u.quad, 0);
      gl.uniform1i(u.mode, 1);
      gl.uniform4f(u.uvRect, 0, 0, 0, 0);
      gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      if (flags & 2) {
        gl.drawArrays(gl.TRIANGLES, first, count);
        return 1;
      }
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(0xff);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
      gl.colorMask(false, false, false, false);
      gl.uniform1i(u.mode, 0);
      gl.drawArrays(gl.TRIANGLES, first, count);
      gl.colorMask(true, true, true, true);
      gl.stencilMask(0xff);
      gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
      gl.uniform1i(u.quad, 1);
      gl.uniform1i(u.mode, 1);
      drawQuad();
      gl.stencilMask(0);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      return 2;
    }
    if (kind === 2) {
      const first = od[k + 2],
        count = od[k + 3];
      setPaint(od[k + 10], job.packet.paints, u.paint);
      capsulePointsScratch.fill(0);
      for (let i = 0; i < count * 4; i++) capsulePointsScratch[i] = job.packet.vertices[first * 2 + i];
      gl.uniform2fv(u.capsulePoints, capsulePointsScratch);
      gl.uniform1i(u.pointCount, count);
      gl.uniform1f(u.radius, antialias ? d[r + 13] : -d[r + 13]);
      gl.uniform1i(u.quad, 1);
      gl.uniform1i(u.mode, 3);
      gl.uniform4f(u.uvRect, 0, 0, 0, 0);
      gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      drawQuad();
      return 1;
    }
    if (kind === 3) {
      const child = od[k + 5],
        sourceStage = p.nodeData[child * 8],
        source = job.stages[sourceStage]?.target;
      if (!source) throw Error('Tile group source target is not ready');
      gl.uniform1i(u.quad, 1);
      gl.uniform1i(u.mode, 2);
      gl.uniform4f(u.uvRect, d[r + 8], d[r + 9], d[r + 10], d[r + 11]);
      gl.uniform1f(u.alpha, d[r + 13]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(u.group, 0);
      gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      drawQuad();
      job.stageUsers[sourceStage] = Math.max(0, job.stageUsers[sourceStage] - 1);
      if (
        job.stages[sourceStage].completed &&
        job.stageUsers[sourceStage] === 0 &&
        sourceStage !== job.stages.length - 1
      ) {
        deleteTarget(source);
        job.stages[sourceStage].target = null;
      }
      return 1;
    }
    throw Error('Unsupported source tile operation kind ' + kind);
  }
  function resolveStage(stage) {
    const t = stage.target;
    if (!t) return;
    if (t.drawFbo !== t.resolveFbo) {
      const scissorEnabled = gl.isEnabled(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.drawFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, t.resolveFbo);
      gl.disable(gl.SCISSOR_TEST);
      try {
        gl.blitFramebuffer(0, 0, t.width, t.height, 0, 0, t.width, t.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.resolveFbo);
        if (scissorEnabled) gl.enable(gl.SCISSOR_TEST);
        else gl.disable(gl.SCISSOR_TEST);
      }
    }
    stage.completed = true;
  }
  function finishStage(job, stage) {
    resolveStage(stage);
    job.stageIndex++;
    job.nodeIndex = 0;
    job.opIndex = 0;
    if (stage.kind !== 'tile' && job.stageUsers[job.stageIndex - 1] === 0) {
      deleteTarget(stage.target);
      stage.target = null;
    }
    if (stage.kind === 'tile') {
      job.phase = 'post-allocate';
    }
  }
  function newOutputTarget(job) {
    const r = job.settings.raster,
      target = makeTarget(r.outputWidth, r.outputHeight, 'output', false);
    target.logicalWidth = job.settings.width;
    target.logicalHeight = job.settings.height;
    job.output = target;
    job.targets.push(target);
    return target;
  }
  function setupPost(job, post) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, post.output.resolveFbo);
    gl.viewport(0, 0, post.output.width, post.output.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(postProgram);
    currentProgram = postProgram;
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, post.input.texture);
    gl.uniform1i(postUniforms.input, 0);
    gl.uniform2i(postUniforms.stageSize, post.input.width, post.input.height);
    gl.uniform2i(postUniforms.outputSize, post.output.width, post.output.height);
    gl.uniform2i(postUniforms.pad, job.settings.raster.padX, job.settings.raster.padY);
    gl.uniform1f(postUniforms.sigma, post.sigma);
    gl.uniform1i(postUniforms.final, post.final ? 1 : 0);
  }
  function advanceStage(job) {
    const p = job.plan;
    while (job.stageIndex < job.stages.length) {
      const stage = job.stages[job.stageIndex];
      if (!stage.target) {
        const raster = job.settings.raster,
          w = stage.kind === 'tile' ? raster.stageWidth : stage.width,
          h = stage.kind === 'tile' ? raster.stageHeight : stage.height;
        const s = makeTarget(w, h, 'stage', true);
        stage.target = s;
        job.targets.push(s);
        job.stageTarget = s;
        clearTarget(s);
        return true;
      }
      if (job.nodeIndex >= stage.nodeCount) {
        finishStage(job, stage);
        return true;
      }
      const node = p.stageNodes[stage.nodeFirst + job.nodeIndex],
        nd = node * 8,
        first = p.nodeData[nd + 5],
        count = p.nodeData[nd + 6];
      if (job.opIndex >= count) {
        job.nodeIndex++;
        job.opIndex = 0;
        continue;
      }
      const op = p.nodeOps[first + job.opIndex];
      const draws = drawOne(job, stage, node, op);
      job.opIndex++;
      job.stats.draws = (job.stats.draws || 0) + draws;
      metadata.draws += draws;
      return true;
    }
    return false;
  }
  function initUpload(job) {
    const requested = Number(job.currentBudget?.maxUploadBytes ?? 786432),
      maxBytes = Math.min(786432, Math.max(4, Math.floor((Number.isFinite(requested) ? requested : 786432) / 4) * 4));
    const u = job.uploads[job.uploadIndex];
    if (!u) {
      job.phase = 'render';
      return true;
    }
    if (u.offset >= u.data.byteLength) {
      job.uploadIndex++;
      return true;
    }
    const bytes = Math.min(u.data.byteLength - u.offset, maxBytes, 262144);
    gl.bindBuffer(gl.ARRAY_BUFFER, u.buffer);
    const start = u.offset / 4,
      elements = bytes / 4;
    gl.bufferSubData(gl.ARRAY_BUFFER, u.offset, u.data, start, elements);
    u.offset += bytes;
    job.stats.uploadedBytes = (job.stats.uploadedBytes || 0) + bytes;
    metadata.uploadedBytes += bytes;
    metadata.uploadWrites++;
    return true;
  }
  function initPost(job) {
    if (job.phase === 'post-allocate') {
      const raster = job.settings.raster;
      job.output = newOutputTarget(job);
      if (job.settings.sigma > 0.01) {
        job.blurTarget = makeTarget(job.tileStage.target.width, job.tileStage.target.height, 'stage', false);
        job.targets.push(job.blurTarget);
        job.posts = [
          {
            input: job.tileStage.target,
            output: job.blurTarget,
            width: job.tileStage.target.width,
            height: job.tileStage.target.height,
            sigma: job.settings.sigma * raster.sx,
            final: false,
          },
          {
            input: job.blurTarget,
            output: job.output,
            width: raster.outputWidth,
            height: raster.outputHeight,
            sigma: job.settings.sigma * raster.sy,
            final: true,
          },
        ];
      } else
        job.posts = [
          {
            input: job.tileStage.target,
            output: job.output,
            width: raster.outputWidth,
            height: raster.outputHeight,
            sigma: 0,
            final: true,
          },
        ];
      job.postIndex = 0;
      job.postRow = 0;
      job.phase = 'post';
      return true;
    }
    return false;
  }
  function renderPostSlice(job, budget, deadline) {
    const post = job.posts[job.postIndex];
    if (!post) {
      job.phase = 'done';
      metadata.jobsCompleted++;
      completedTarget = job.output;
      return false;
    }
    const rows = post.height - job.postRow;
    if (rows <= 0) {
      job.postIndex++;
      job.postRow = 0;
      return true;
    }
    const perRows = Math.max(
      1,
      Math.min(
        rows,
        budget.postRows || 32,
        Math.floor(
          (Math.max(0.05, deadline - clock()) * Math.max(1, post.width)) /
            (Math.max(1, Math.ceil(post.sigma * 6 + 1)) * 0.00015),
        ),
      ),
    );
    setupPost(job, post);
    gl.scissor(0, job.postRow, post.width, perRows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    job.postRow += perRows;
    job.stats.draws = (job.stats.draws || 0) + 1;
    metadata.draws++;
    if (job.postRow === post.height) {
      job.postIndex++;
      job.postRow = 0;
      if (job.postIndex >= job.posts.length) {
        job.phase = 'done';
        metadata.jobsCompleted++;
        completedTarget = job.output;
      }
    }
    return true;
  }
  function step(budget = {}) {
    if (disposed) throw Error('Tile renderer disposed');
    if (!active)
      return {
        done: false,
        idle: true,
        texture: null,
        width: 0,
        height: 0,
        logicalWidth: 0,
        logicalHeight: 0,
        advanced: false,
        phase: 'idle',
        cpuMs: 0,
        stats: metadata.lastJob,
      };
    const job = active,
      begin = clock(),
      cpuBudget = budget.opening === true ? Infinity : Math.max(0.05, budget.maxCPUms ?? 0.65);
    job.currentBudget = budget;
    let advanced = false,
      draws = 0,
      uploadBytes = 0,
      phaseBefore = job.phase,
      forceAdvance = true;
    const drawCountBefore = job.stats.draws || 0;
    const frameDeadline =
      Number.isFinite(budget.frameDeadline) && budget.frameDeadline > begin ? budget.frameDeadline : Infinity;
    const deadline = budget.opening === true ? Infinity : Math.min(begin + cpuBudget, frameDeadline);
    try {
      if (job.phase === 'upload-allocate') {
        job.phase = 'upload';
        advanced = true;
      }
      if (job.phase === 'upload' && (clock() < deadline || forceAdvance)) {
        const before = job.stats.uploadedBytes || 0;
        const did = initUpload(job);
        advanced = did || advanced;
        uploadBytes = (job.stats.uploadedBytes || 0) - before;
        if (did) forceAdvance = false;
      }
      const maxDraws = budget.maxDraws === undefined ? 64 : Math.max(1, Math.floor(budget.maxDraws)),
        maxOperations =
          budget.maxOperations === undefined
            ? Math.max(64, maxDraws * 4)
            : Math.max(1, Math.floor(budget.maxOperations));
      let operations = 0;
      while (
        job.phase === 'render' &&
        (clock() < deadline || forceAdvance) &&
        draws < maxDraws &&
        operations < maxOperations
      ) {
        const before = job.stats.draws || 0,
          was = job.stageIndex;
        const did = advanceStage(job);
        if (!did) break;
        operations++;
        advanced = true;
        forceAdvance = false;
        draws += (job.stats.draws || 0) - before;
        if (job.phase === 'post-allocate' || job.stageIndex !== was) break;
      }
      if (job.phase === 'post-allocate') advanced = initPost(job) || advanced;
      if (job.phase === 'post' && draws < maxDraws && (clock() < deadline || forceAdvance)) {
        const did = renderPostSlice(job, budget, deadline);
        advanced = did || advanced;
        if (did) forceAdvance = false;
      }
      draws = (job.stats.draws || 0) - drawCountBefore;
      if (job.phase === 'done' && active === job) {
        active = null;
        job.phase = 'done';
        job.packet = null;
        job.plan = null;
      }
      job.stats.phase = job.phase;
      job.stats.steps = (job.stats.steps || 0) + 1;
      metadata.steps++;
      const cpuMs = clock() - begin;
      metadata.lastStepCPUms = cpuMs;
      metadata.lastJob = { ...job.stats, phase: job.phase, byteCount: metadata.byteCount };
      const done = job.phase === 'done',
        texture = done ? job.output : null;
      if (done) {
        releaseJob(job, true);
        job.targets.length = 0;
        job.buffers.length = 0;
        job.uploads.length = 0;
      }
      return {
        done,
        texture,
        width: job.settings.raster.outputWidth,
        height: job.settings.raster.outputHeight,
        logicalWidth: job.settings.width,
        logicalHeight: job.settings.height,
        advanced: advanced || phaseBefore !== job.phase || uploadBytes > 0,
        phase: job.phase,
        cpuMs,
        uploadedBytes: uploadBytes,
        uploads: uploadBytes,
        draws,
        passes: draws ? 1 : 0,
        encoded: draws > 0,
        submitted: false,
        stats: { ...job.stats, phase: job.phase, byteCount: metadata.byteCount },
      };
    } catch (error) {
      if (active === job) {
        active = null;
        releaseJob(job);
      }
      throw error;
    } finally {
      resetGLStateAfterStep();
    }
  }
  function retireCPUViews() {
    return active ? false : true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancel();
    if (completedTarget) {
      deleteTarget(completedTarget);
      completedTarget = null;
    }
    if (stampFieldTexture) {
      gl.deleteTexture(stampFieldTexture);
      stampFieldTexture = null;
      forgetBytes('textureBytes', metadata.stampFieldBytes);
    }
    if (vao) gl.deleteVertexArray(vao);
    if (stampVao) gl.deleteVertexArray(stampVao);
    if (geometryProgram) gl.deleteProgram(geometryProgram);
    if (stampProgram) gl.deleteProgram(stampProgram);
    if (postProgram) gl.deleteProgram(postProgram);
    metadata.lastJob = { ...metadata.lastJob, disposed: true, byteCount: metadata.byteCount };
  }
  return {
    start,
    step,
    cancel,
    dispose,
    retireCPUViews,
    submitted() {},
    metadata,
    get active() {
      return active;
    },
    get ready() {
      return !disposed;
    },
    get byteCount() {
      return metadata.byteCount;
    },
  };
}
