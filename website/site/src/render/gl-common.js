const GL_PAPER_GLSL = `
precision highp float;
uniform sampler2D uMtn;
uniform sampler2D uPN;
uniform float uAsp;
uniform float uDpr;
uniform float uTime;
uniform float uT;
uniform float uD;
uniform float uVeil;
uniform vec4 uN1;
uniform vec4 uN3;
uniform vec4 uLag;
uniform vec2 uMS;
uniform vec2 uMO;
uniform vec2 uMY;
uniform vec2 uMouse;
uniform vec2 uRead;
uniform vec4 uMsk;
uniform vec4 uMark;
uniform vec3 uMistZ;
uniform vec3 uMistJ;
uniform vec3 uWashZ;
uniform vec3 uWashJ;
uniform vec3 uSkyZ0;
uniform vec3 uSkyZ1;
uniform vec3 uSkyZ2;
uniform vec3 uSkyJ0;
uniform vec3 uSkyJ1;
uniform vec3 uSkyJ2;
uniform vec3 uMtZA;
uniform vec3 uMtZB;
uniform vec3 uMtJA;
uniform vec3 uMtJB;
float glPaperRamp(float a,float b,float x){float q=clamp((x-a)/(b-a),0.0,1.0);return q*q*(3.0-2.0*q);}
float glPaperBand(float y,float c,float h){float d=(y-c)/h;return exp(-d*d);}
vec4 glPaperNoise(vec2 p){return texture(uPN,p);}
float glPaperWn(vec2 v,float o1,float o3,float yo){
  float xa=v.x*uAsp;float yt=1.0-v.y;
  return glPaperNoise(vec2(xa*.5+o1,yt*.5+yo)).g*.62+
         glPaperNoise(vec2(xa*1.5+o3,yt*1.5+yo)).b*.38;
}
float glPaperMask(float x,float n,float lag){
  float F=uMsk.x,J=uMsk.y,L=uMsk.z;
  float e=1.0+.5*F+.5*J+L-uT*(1.0+F+J+2.0*L)+lag;
  return glPaperRamp(e-.5*F,e+.5*F,x+(n-.5)*J);
}
vec4 glPaperXfade(vec4 a,vec4 b,float j){
  float wb=mix(j,glPaperRamp(.3,1.0,j),uMsk.w);
  float wa=mix(1.0-j,glPaperRamp(.3,1.0,1.0-j),uMsk.w);
  return a*wa+b*wb;
}
vec3 paperSky(float x,float yt,float j0,float mx){
  vec3 sz=mix(uSkyZ0,uSkyZ1,glPaperRamp(0.0,.58,yt));
  sz=mix(sz,uSkyZ2,glPaperRamp(.66,1.0,yt));
  vec3 sj=mix(uSkyJ0,uSkyJ1,glPaperRamp(0.0,.58,yt));
  sj=mix(sj,uSkyJ2,glPaperRamp(.66,1.0,yt));
  vec3 col=mix(sz,sj,j0);float tm=(yt-uMY.x)/(uMY.y-uMY.x);
  if(tm>0.0&&tm<1.0){
    float a=texture(uMtn,vec2(fract((x+mx*.001)*uMS.x+uMO.x),1.0-tm)).r*.4;
    float b=texture(uMtn,vec2(fract((x+mx*.002)*uMS.x+uMO.y),1.0-tm)).g*.4;
    col=mix(col,mix(uMtZA,uMtJA,j0),a);
    col=mix(col,mix(uMtZB,uMtJB,j0),b);
  }
  return col;
}
vec3 paperFinish(vec3 colIn,vec2 v,vec3 mist,float grain){
  vec2 c=(v-.5)*vec2(uAsp,1.0);vec2 cc=c*vec2(.85,1.55);
  vec3 col=mix(colIn,mist,exp(-dot(cc,cc)*3.0)*.2);
  col=mix(col,mist,uVeil*.7);col*=.935+.13*grain;
  col*=mix(.9,1.0,glPaperRamp(1.35,.45,length(c*vec2(.8,1.0))));
  return col;
}
vec3 textPaperAt(vec2 cssPosition,vec2 viewportCss,float paperValue){
  vec2 q=cssPosition/viewportCss;float x=q.x,yt=q.y;
  vec2 v=vec2(x,1.0-yt);float xa=x*uAsp,dr=uTime*.006;
  float j0=uD,j1=j0,j2=j0,mz=0.0;
  if(uT>.0005){
    float m0=glPaperMask(x,glPaperWn(v,uN1.x,uN3.x,0.0),uLag.x);
    float m1=glPaperMask(x,glPaperWn(v,uN1.y,uN3.y,.31),uLag.y);
    float m2=glPaperMask(x,glPaperWn(v,uN1.z,uN3.z,.63),uLag.z);
    j0=mix(m0,1.0-m0,uD);j1=mix(m1,1.0-m1,uD);j2=mix(m2,1.0-m2,uD);mz=m1;
  }
  vec3 col=paperSky(x,yt,j0,0.0);
  vec3 mist0=mix(uMistZ,uMistJ,j0),mist1=mix(uMistZ,uMistJ,j1),mist2=mix(uMistZ,uMistJ,j2);
  col=mix(col,mist0,glPaperBand(yt,.6,.1)*(.3+.42*glPaperNoise(vec2(xa*.5+uN1.x+dr,yt*1.7+.2)).g));
  col=mix(col,mist0,glPaperBand(yt,.668,.05)*(.22+.38*glPaperNoise(vec2(xa*.5+uN1.x+dr*1.3,yt*2.2+.5)).g));
  col=mix(col,mist1,glPaperBand(yt,.85,.065)*(.3+.42*glPaperNoise(vec2(xa*.5+uN1.y+dr*1.6,yt*2.4+.8)).g));
  float rn=glPaperNoise(vec2(xa*.35+dr*4.0,yt*.9+.45)).g;
  float fog=1.0-glPaperRamp(0.0,1.0,max(max(uRead.x-yt,0.0)/.1,max(yt-uRead.y,0.0)/.16)+(rn-.5)*.5);
  col=mix(col,mist2,glPaperRamp(.86,1.02,yt)*(.18+.3*glPaperNoise(vec2(xa*.5+uN1.z+dr*2.0,yt*2.0+.1)).g));
  col=mix(col,mist2,fog*.22);
  if(uT>.0005){
    vec3 wIn=mix(uWashJ,uWashZ,uD);float zone=4.0*mz*(1.0-mz);
    col=mix(col,mix(mist1,wIn,.75),zone*.42);
    col=mix(col,wIn,glPaperRamp(0.0,.35,mz)*(1.0-glPaperRamp(.55,1.0,mz))*.18);
  }
  return paperFinish(col,v,mist1,paperValue);
}
`;

const GL_PAPER_UNIFORM_NAMES = [
  'uMtn',
  'uPN',
  'uAsp',
  'uDpr',
  'uTime',
  'uT',
  'uD',
  'uVeil',
  'uN1',
  'uN3',
  'uLag',
  'uMS',
  'uMO',
  'uMY',
  'uMouse',
  'uRead',
  'uMsk',
  'uMark',
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
];

const GL_UNIFORM_LOCATIONS = new WeakMap();
function glUniformLocation(gl, program, name) {
  let locations = GL_UNIFORM_LOCATIONS.get(program);
  if (!locations) {
    locations = Object.create(null);
    GL_UNIFORM_LOCATIONS.set(program, locations);
  }
  if (!Object.hasOwn(locations, name)) locations[name] = gl.getUniformLocation(program, name);
  return locations[name];
}
function glUniformLocations(gl, program, names) {
  for (const name of names) glUniformLocation(gl, program, name);
  return GL_UNIFORM_LOCATIONS.get(program);
}
function glPaperLocations(gl, program, supplied) {
  if (supplied) return supplied;
  return glUniformLocations(gl, program, GL_PAPER_UNIFORM_NAMES);
}

function glUploadPaperUniform(gl, locations, name, type, value) {
  const location = locations?.[name];
  if (location == null) return;
  if (type === 1) gl.uniform1f(location, value);
  else if (type === 2) gl.uniform2fv(location, value);
  else if (type === 3) gl.uniform3fv(location, value);
  else if (type === 4) gl.uniform4fv(location, value);
}
