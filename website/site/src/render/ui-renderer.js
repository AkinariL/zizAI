async function createGPUUI(device, canvasFormat, shared) {
  const BU = GPUBufferUsage,
    TU = GPUTextureUsage,
    SS = GPUShaderStage;
  for (const name of ['rng', 'rr', 'samplePath', 'brush', 'periodicNoise'])
    if (typeof shared?.[name] !== 'function') throw Error('GPU UI requires ' + name);
  const metadata = {
    backend: 'webgpu-ui',
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
    atlasBytes: 0,
    assetBytes: 0,
    groupBytes: 0,
    roiBytes: 0,
    bufferBytes: 0,
    temporaryBytes: 0,
    byteCount: 0,
    peakBytes: 0,
    cpuGlyphBytes: 0,
    instances: 0,
    roiWidth: 0,
    roiHeight: 0,
    groupWidth: 0,
    groupHeight: 0,
    allocations: 0,
    warnings: [],
    filters: {
      backdropSigmaCss: 16,
      backdropTexelsPerCss: 0.5,
      backdropPaddingCss: 48,
      gaussianExtent: 3,
      slogan: 'clear / sigma 7 crossfade',
      shadow: 'analytic Gaussian rectangle',
      grain: 'seeded GPU noise and analytic fibre segments',
    },
  };
  const owned = new Map(),
    glyphCache = new Map(),
    slots = new Map();
  const glyphClient = shared.glyphPreparation?.acquire('ui');
  const sealClient = shared.glyphPreparation?.acquire('seal');
  if (glyphClient) metadata.preparation = glyphClient.metadata;
  if (sealClient) metadata.sealPreparation = sealClient.metadata;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
    finite = (x, d = 0) => (Number.isFinite(x) ? x : d);
  const premul = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  let disposed = false,
    installed = null,
    prepareQueue = Promise.resolve(),
    assets = null,
    group = null,
    roi = null,
    encoded = null;
  const atlasHandoffEnabled = typeof param !== 'function' || param('uiatlashandoff') !== '0';
  metadata.atlasHandoffEnabled = atlasHandoffEnabled;
  const handoff = atlasHandoffEnabled
    ? createUIAtlasHandoff({
        destroy: data => release(data.atlas),
        afterSubmit: shared.afterSubmit,
        changed: () => Object.assign(metadata, handoff.inspect()),
      })
    : null;
  function selectAtlas(frame, record) {
    if (!handoff) return null;
    record ??= handoff.select(frame);
    if (installed !== record.data) {
      installed = record.data;
      for (const slot of slots.values()) slot.bind = null;
    }
    return record;
  }
  async function restoreAtlasHandoff(records) {
    if (!handoff) throw Error('UI atlas handoff is disabled');
    for (const record of records) {
      await handoff.acquire(record.settings);
      await prepare(record.specs, record.settings);
      handoff.restorePublication(handoff.select(record), record.published);
    }
  }
  function recount() {
    for (const k of [
      'byteCount',
      'bufferBytes',
      'temporaryBytes',
      'atlasBytes',
      'assetBytes',
      'groupBytes',
      'roiBytes',
    ])
      metadata[k] = 0;
    for (const { bytes, kind } of owned.values()) {
      metadata.byteCount += bytes;
      metadata[kind + 'Bytes'] += bytes;
    }
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
  }
  function own(r, bytes, kind = 'temporary') {
    owned.set(r, { bytes, kind });
    metadata.allocations++;
    recount();
    return r;
  }
  function release(r) {
    if (r && owned.delete(r)) {
      r.destroy();
      recount();
    }
  }
  function alive() {
    if (disposed) throw Error('GPU UI renderer was disposed');
  }
  function buffer(label, size, usage, kind = 'buffer') {
    return own(device.createBuffer({ label, size: Math.max(4, size), usage }), Math.max(4, size), kind);
  }
  function texture(label, w, h, format = 'rgba8unorm', kind = 'temporary', extra = 0) {
    if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D)
      throw Error('GPU UI texture exceeds device limit');
    return own(
      device.createTexture({ label, size: [w, h], format, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING | extra }),
      w * h * 4,
      kind,
    );
  }
  function attachment(t, loadOp = 'clear') {
    return [
      { view: t.createView(), loadOp, storeOp: 'store', ...(loadOp === 'clear' ? { clearValue: [0, 0, 0, 0] } : {}) },
    ];
  }
  async function module(label, code) {
    const m = device.createShaderModule({ label, code }),
      info = await m.getCompilationInfo(),
      errors = info.messages.filter(x => x.type === 'error');
    if (errors.length)
      throw Error(label + ': ' + errors.map(x => x.lineNum + ':' + x.linePos + ' ' + x.message).join('\n'));
    metadata.warnings.push(...info.messages.filter(x => x.type === 'warning').map(x => label + ': ' + x.message));
    return m;
  }
  const fullscreen = `@vertex fn uiFull(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,1),vec2f(3,1),vec2f(-1,-3));return vec4f(p[i],0,1);}`;
  let sampler,
    repeatSampler,
    drawLayout,
    drawPipeline,
    filterLayout,
    filterPipeline,
    filterComputeLayout,
    filterComputePipeline,
    boxLayout,
    boxPipeline,
    glyphLayout,
    glyphPipeline,
    pathLayout,
    pathStencil,
    pathFill,
    assetShapeLayout,
    assetShapePipeline,
    assetErasePipeline,
    grainLayout,
    grainPipeline;

  const pipelineJobs = [];
  const compile = (promise, publish) => {
    const job = Promise.resolve(promise).then(publish);
    job.catch(() => {});
    pipelineJobs.push(job);
  };
  const pipelinesReady = async () => {
    const settled = await Promise.allSettled(pipelineJobs);
    const failed = settled.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
  };
  const creationValidation = operation =>
    shared.constructionScope?.active ? operation() : uiValidationScope(device, operation);
  try {
    await creationValidation(async () => {
      sampler = device.createSampler({ label: 'UI linear clamp', minFilter: 'linear', magFilter: 'linear' });
      repeatSampler = device.createSampler({
        label: 'UI grain repeat',
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      });
      drawLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          ...[2, 3, 4, 5].map(binding => ({ binding, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } })),
        ],
      });
      const drawShader = await module(
        'UI instances',
        `${shared.paperWGSL}

struct UIFrame { viewport:vec4f, clip:vec4f }
@group(0) @binding(0) var<uniform> uiFrame:UIFrame;
@group(0) @binding(1) var uiSampler:sampler;
@group(0) @binding(2) var uiGlyph:texture_2d<f32>;
@group(0) @binding(3) var uiSwash:texture_2d<f32>;
@group(0) @binding(4) var uiSeal:texture_2d<f32>;
@group(0) @binding(5) var uiGroup:texture_2d<f32>;
struct UIVertex { @builtin(position) position:vec4f,@location(0) point:vec2f,@location(1) uv:vec2f,@location(2) colour:vec4f,@location(3) colour2:vec4f,@location(4) params:vec4f,@location(5) aux:vec4f,@location(6) shape:vec4f }
@vertex fn uiVertex(@builtin(vertex_index) i:u32,@location(0) rect:vec4f,@location(1) uv:vec4f,@location(2) colour:vec4f,@location(3) colour2:vec4f,@location(4) params:vec4f,@location(5) aux:vec4f,@location(6) shape:vec4f)->UIVertex {
 let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));let point=rect.xy+corners[i]*rect.zw;
 var o:UIVertex;o.position=vec4f((point.x-uiFrame.viewport.z)/uiFrame.viewport.x*2.0-1.0,1.0-(point.y-uiFrame.viewport.w)/uiFrame.viewport.y*2.0,0,1);o.point=point;o.uv=uv.xy+corners[i]*uv.zw;o.colour=colour;o.colour2=colour2;o.params=params;o.aux=aux;o.shape=shape;return o;
}
fn uiDistance(p:vec2f,b:vec4f,r:f32)->f32 {let q=abs(p-b.xy-b.zw*.5)-(b.zw*.5-vec2f(r));return length(max(q,vec2f(0)))+min(max(q.x,q.y),0.0)-r;}
fn uiErf(v:f32)->f32 {let x=abs(v);let t=1.0/(1.0+.3275911*x);let q=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t;return sign(v)*(1.0-q*exp(-x*x));}
fn uiCDF(v:f32)->f32{return .5+.5*uiErf(v*.7071067811865476);}
@fragment fn uiFragment(i:UIVertex)->@location(0) vec4f {
 let kind=u32(i.params.x);var a=1.0;var rgb=i.colour.rgb;var pixel=vec4f(0);let aa=max(.0001,i.aux.w);
 let uvPerCss=vec2f(dpdx(i.uv.x),dpdy(i.uv.y))/vec2f(dpdx(i.point.x),dpdy(i.point.y));
 if(kind==0u){let m=textureSampleLevel(uiGlyph,uiSampler,i.uv,0.0);a=mix(m.r,m.g,i.params.z);
  if(i.params.w>0.0&&m.g>.008){
   let reach=i.params.w*uvPerCss;var far=0.0;var rim=m.r;
   for(var k=0;k<12;k++){let turn=f32(k)*.5235988;let dir=vec2f(cos(turn),sin(turn))*reach;
    far=max(far,textureSampleLevel(uiGlyph,uiSampler,i.uv+dir,0.0).r);
    if(k%2==0){rim=max(rim,.62*textureSampleLevel(uiGlyph,uiSampler,i.uv+dir*.45,0.0).r);}}
   if(max(rim,far)>.002){
    for(var k=0;k<12;k++){let turn=f32(k)*.5235988;let dir=vec2f(cos(turn),sin(turn))*reach;let skew=vec2f(dir.x*.9659258-dir.y*.2588190,dir.x*.2588190+dir.y*.9659258);
     rim=max(rim,textureSampleLevel(uiGlyph,uiSampler,i.uv+skew*.26,0.0).r);
     rim=max(rim,.62*textureSampleLevel(uiGlyph,uiSampler,i.uv+skew*.45,0.0).r);
     rim=max(rim,.36*textureSampleLevel(uiGlyph,uiSampler,i.uv+dir*.62,0.0).r);
     rim=max(rim,.15*textureSampleLevel(uiGlyph,uiSampler,i.uv+skew*.8,0.0).r);}
   }
   rim=max(rim,.03*far);
   let inkA=a*i.colour.a*i.params.y;let rimA=rim*i.colour2.x*i.params.y*(1.0-i.params.z);
   if(max(inkA,rimA)<.00001){discard;}
   let paper=mix(textPaperAt(i.point-uiFrame.viewport.zw,uiFrame.viewport.xy,i.colour2.z),vec3f(1),i.colour2.y);
   return vec4f(rgb*inkA+paper*rimA*(1.0-inkA),inkA+rimA*(1.0-inkA));
  }
 }
 else if(kind==3u){a=textureSampleLevel(uiSwash,uiSampler,i.uv,0.0).a;}
 else if(kind==4u){pixel=textureSampleLevel(uiSeal,uiSampler,i.uv,0.0);return pixel*i.params.y;}
 else if(kind==5u){let m=clamp(.5-uiDistance(i.point,i.shape,i.params.w)/aa,0.0,1.0);return textureSampleLevel(uiGroup,uiSampler,i.uv,0.0)*(m*i.params.y);}
 else if(kind==6u){let lo=(i.point-i.shape.xy)/i.params.z;let hi=(i.point-i.shape.xy-i.shape.zw)/i.params.z;a=max(0.0,(uiCDF(lo.x)-uiCDF(hi.x))*(uiCDF(lo.y)-uiCDF(hi.y)));if(i.aux.z<0.0){let boxMask=clamp(.5-uiDistance(i.point,i.colour2,i.params.w)/aa,0.0,1.0);a*=1.0-boxMask;}}
 else {let d=uiDistance(i.point,i.shape,min(i.params.w,min(i.shape.z,i.shape.w)*.5));a=clamp(.5-d/aa,0.0,1.0);if(i.aux.z>0.0){a*=clamp(.5+(d+i.aux.z)/aa,0.0,1.0);}if(kind==2u){let t=clamp((i.point.x-i.shape.x)/max(.0001,i.shape.z),0.0,1.0);let mixv=clamp((t-i.aux.x)/max(.0001,i.aux.y-i.aux.x),0.0,1.0);let c=mix(i.colour,i.colour2,mixv);rgb=c.rgb;a*=c.a;} }
 if(kind!=2u){a*=i.colour.a;}a*=i.params.y;if(a<.00001){discard;}return vec4f(rgb*a,a);
}`,
      );
      const instanceVertex = {
        module: drawShader,
        entryPoint: 'uiVertex',
        buffers: [
          {
            arrayStride: 112,
            stepMode: 'instance',
            attributes: Array.from({ length: 7 }, (_, i) => ({
              shaderLocation: i,
              offset: i * 16,
              format: 'float32x4',
            })),
          },
        ],
      };
      compile(
        device.createRenderPipelineAsync({
          label: 'UI instances',
          layout: device.createPipelineLayout({ bindGroupLayouts: [drawLayout, shared.paperLayout] }),
          vertex: instanceVertex,
          fragment: {
            module: drawShader,
            entryPoint: 'uiFragment',
            targets: [{ format: canvasFormat, blend: premul }],
          },
          primitive: { topology: 'triangle-list' },
        }),
        value => {
          drawPipeline = value;
        },
      );
      filterLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: SS.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
          },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const filterShader = await module(
        'UI local backdrop Gaussian',
        fullscreen +
          `
struct UIFilter { extent:vec4f, region:vec4f, screen:vec4f, control:vec4f }
@group(0) @binding(0) var<uniform> uiFilter:UIFilter;
@group(0) @binding(1) var uiBlurSampler:sampler;
@group(0) @binding(2) var uiSource:texture_2d<f32>;
fn uiBlurSample(p:vec2f)->vec4f{return textureSampleLevel(uiSource,uiBlurSampler,clamp(p,vec2f(.5),uiFilter.extent.xy-vec2f(.5))/uiFilter.extent.zw,0.0);}
@group(0) @binding(3) var uiTarget:texture_storage_2d<rgba8unorm,write>;
fn uiFilterAt(xy:vec2f)->vec4f {
 if(uiFilter.control.x<.5){let css=uiFilter.region.xy+xy/uiFilter.extent.xy*uiFilter.region.zw;return textureSampleLevel(uiSource,uiBlurSampler,css/uiFilter.screen.xy,0.0);}
 let axis=select(vec2f(1,0),vec2f(0,1),uiFilter.control.x>1.5);let sigma=uiFilter.control.y;let extent=i32(ceil(3.0*sigma));let inv=.5/(sigma*sigma);var sum=uiBlurSample(xy);var weight=1.0;
 for(var j=1;j<=extent;j=j+2){let a=exp(-f32(j*j)*inv);var b=0.0;if(j+1<=extent){b=exp(-f32((j+1)*(j+1))*inv);}let w=a+b;let off=f32(j)+b/max(w,1e-20);sum+=(uiBlurSample(xy+axis*off)+uiBlurSample(xy-axis*off))*w;weight+=2.0*w;}return sum/weight;
}
@fragment fn uiFilterFragment(@builtin(position) pos:vec4f)->@location(0) vec4f { return uiFilterAt(pos.xy); }
@compute @workgroup_size(8,8) fn uiFilterCompute(@builtin(global_invocation_id) id:vec3u) {
 if(f32(id.x)>=uiFilter.extent.x||f32(id.y)>=uiFilter.extent.y){return;}
 textureStore(uiTarget,vec2i(id.xy),uiFilterAt(vec2f(id.xy)+vec2f(.5)));
}`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'UI ROI filter',
          layout: device.createPipelineLayout({ bindGroupLayouts: [filterLayout] }),
          vertex: { module: filterShader, entryPoint: 'uiFull' },
          fragment: { module: filterShader, entryPoint: 'uiFilterFragment', targets: [{ format: 'rgba8unorm' }] },
        }),
        value => {
          filterPipeline = value;
        },
      );
      try {
        filterComputeLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: SS.COMPUTE,
              buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
            },
            { binding: 1, visibility: SS.COMPUTE, sampler: { type: 'filtering' } },
            { binding: 2, visibility: SS.COMPUTE, texture: { sampleType: 'float' } },
            { binding: 3, visibility: SS.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
          ],
        });
        filterComputePipeline =
          typeof param === 'function' && param('uibackdrop') === 'render'
            ? null
            : await device.createComputePipelineAsync({
                label: 'UI ROI filter compute',
                layout: device.createPipelineLayout({ bindGroupLayouts: [filterComputeLayout] }),
                compute: { module: filterShader, entryPoint: 'uiFilterCompute' },
              });
      } catch (error) {
        filterComputePipeline = null;
      }
      metadata.backdropFilter = filterComputePipeline ? 'compute' : 'render';
      boxLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SS.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 4, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const boxShader = await module(
        'UI candidate glass and tint',
        fullscreen +
          `
struct UIBox { extent:vec4f, screen:vec4f, region:vec4f, roi:vec4f, glass:vec4f, outside:vec4f, inside:vec4f, tint:vec4f, edge:vec4f }
@group(0) @binding(0) var<uniform> uiBox:UIBox;
@group(0) @binding(1) var uiGlassSampler:sampler;
@group(0) @binding(2) var uiGlass:texture_2d<f32>;
@group(0) @binding(3) var uiGrainSampler:sampler;
@group(0) @binding(4) var uiGrain:texture_2d<f32>;
fn uiOver(f:vec4f,b:vec4f)->vec4f{return f+b*(1.0-f.a);}
fn uiBoxDistance(p:vec2f)->f32{let radius=uiBox.screen.w;let q=abs(p-uiBox.extent.xy*.5)-(uiBox.extent.xy*.5-vec2f(radius));return length(max(q,vec2f(0)))+min(max(q.x,q.y),0.0)-radius;}
fn uiBoxCoverage(p:vec2f)->f32{return clamp(.5-uiBoxDistance(p)/max(.0001,uiBox.tint.w),0.0,1.0);}
@fragment fn uiBoxFragment(@builtin(position) pos:vec4f)->@location(0) vec4f {
 let local=pos.xy/uiBox.extent.zw*uiBox.extent.xy;var pixel=vec4f(0);
 if(uiBox.tint.z>.5){let css=uiBox.screen.xy+(local-uiBox.extent.xy*.5)*uiBox.screen.z;let uv=(css-uiBox.region.xy)/uiBox.region.zw*uiBox.roi.xy/uiBox.roi.zw;pixel=textureSampleLevel(uiGlass,uiGlassSampler,uv,0.0);let l=dot(pixel.rgb,vec3f(.213,.715,.072));pixel=vec4f(mix(vec3f(l),pixel.rgb,1.16),pixel.a);}
 pixel=uiOver(vec4f(uiBox.glass.rgb*uiBox.glass.a,uiBox.glass.a),pixel);
 let edgeA=clamp(.5+(uiBoxDistance(local)+1.0)/max(.0001,uiBox.tint.w),0.0,1.0)*uiBox.edge.a;pixel=uiOver(vec4f(uiBox.edge.rgb*edgeA,edgeA),pixel);
 let topA=(1.0-uiBoxCoverage(local-vec2f(0,1)))*.75;pixel=uiOver(vec4f(vec3f(topA),topA),pixel);
 let t=clamp((local.x/max(.0001,uiBox.extent.x)-uiBox.tint.x)/max(.0001,uiBox.tint.y-uiBox.tint.x),0.0,1.0);let c=mix(uiBox.outside,uiBox.inside,t);pixel=uiOver(vec4f(c.rgb*c.a*.84,c.a*.84),pixel);
 let grain=textureSampleLevel(uiGrain,uiGrainSampler,local/220.0,0.0).rgb;
 return vec4f(pixel.rgb*mix(vec3f(1),grain,.55)+grain*.55*(1.0-pixel.a),.55+pixel.a*.45);
}`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'UI candidate background',
          layout: device.createPipelineLayout({ bindGroupLayouts: [boxLayout] }),
          vertex: { module: boxShader, entryPoint: 'uiFull' },
          fragment: { module: boxShader, entryPoint: 'uiBoxFragment', targets: [{ format: canvasFormat }] },
        }),
        value => {
          boxPipeline = value;
        },
      );
      glyphLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: SS.VERTEX | SS.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 },
          },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const glyphShader = await module(
        'UI glyph masks and local Gaussian',
        `
struct UIGlyphSize { extent:vec4f, control:vec4f }
@group(0) @binding(0) var<uniform> uiGlyphSize:UIGlyphSize;
@group(0) @binding(1) var uiGlyphSampler:sampler;
@group(0) @binding(2) var uiGlyphSource:texture_2d<f32>;
@group(0) @binding(3) var uiGlyphClear:texture_2d<f32>;
struct UIGlyphOut{@builtin(position) position:vec4f,@location(0) box:vec4f,@location(1) sigma:f32}
@vertex fn uiGlyphVertex(@builtin(vertex_index) i:u32,@location(0) box:vec4f,@location(1) config:vec4f)->UIGlyphOut{let p=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));let q=box.xy+p[i]*box.zw;var o:UIGlyphOut;o.position=vec4f(q.x/uiGlyphSize.extent.x*2.0-1.0,1.0-q.y/uiGlyphSize.extent.y*2.0,0,1);o.box=box;o.sigma=config.x;return o;}
fn uiGlyphSample(p:vec2f,b:vec4f)->f32{return textureSampleLevel(uiGlyphSource,uiGlyphSampler,clamp(p,vec2f(.5),b.zw-vec2f(.5))/uiGlyphSize.extent.zw,0.0).a;}
@fragment fn uiGlyphFragment(i:UIGlyphOut)->@location(0) vec4f {let point=i.position.xy-uiGlyphSize.control.yz;let clear=textureSampleLevel(uiGlyphClear,uiGlyphSampler,point/uiGlyphSize.extent.zw,0.0).a;var sum=uiGlyphSample(point,i.box);var weight=1.0;
 if(i.sigma>.08){let axis=select(vec2f(1,0),vec2f(0,1),uiGlyphSize.control.x>.5);let extent=i32(ceil(3.0*i.sigma));let inv=.5/(i.sigma*i.sigma);for(var j=1;j<=extent;j=j+2){let a=exp(-f32(j*j)*inv);var b=0.0;if(j+1<=extent){b=exp(-f32((j+1)*(j+1))*inv);}let w=a+b;let off=f32(j)+b/max(w,1e-20);sum+=(uiGlyphSample(point+axis*off,i.box)+uiGlyphSample(point-axis*off,i.box))*w;weight+=2.0*w;}}
 let blurred=sum/weight;return vec4f(clear,blurred,0,blurred);
}`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'UI glyph blur packing',
          layout: device.createPipelineLayout({ bindGroupLayouts: [glyphLayout] }),
          vertex: {
            module: glyphShader,
            entryPoint: 'uiGlyphVertex',
            buffers: [
              {
                arrayStride: 32,
                stepMode: 'instance',
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x4' },
                  { shaderLocation: 1, offset: 16, format: 'float32x4' },
                ],
              },
            ],
          },
          fragment: { module: glyphShader, entryPoint: 'uiGlyphFragment', targets: [{ format: 'rgba8unorm' }] },
        }),
        value => {
          glyphPipeline = value;
        },
      );
      await createAssetPipelines();
    });
    assets = await buildAssets();
  } catch (error) {
    await Promise.allSettled(pipelineJobs);
    dispose();
    throw error;
  }

  function pack(items) {
    const limit = device.limits.maxTextureDimension2D;
    const widest = Math.max(4, ...items.map(g => g.w + 4));
    let w = Math.min(
      limit,
      Math.max(
        64,
        2 ** Math.ceil(Math.log2(Math.max(widest, Math.sqrt(items.reduce((n, g) => n + (g.w + 4) * (g.h + 4), 0))))),
      ),
    );
    if (widest > limit) throw Error('UI glyph is too large');
    for (;;) {
      let x = 2,
        y = 2,
        row = 0;
      for (const g of items) {
        if (x + g.w + 2 > w) {
          x = 2;
          y += row + 4;
          row = 0;
        }
        g.ax = x;
        g.ay = y;
        x += g.w + 4;
        row = Math.max(row, g.h);
      }
      const h = y + row + 2;
      if (h <= limit) return { w, h };
      if (w === limit) throw Error('UI glyph atlas exceeds device limits');
      w = Math.min(limit, w * 2);
    }
  }
  function getGlyph(spec, text, settings, measure) {
    const dpr = finite(spec.dpr, finite(settings.dpr, 1)),
      blur = Math.max(0, finite(spec.blurMax, 0)),
      key = JSON.stringify([settings.fontGeneration || 0, spec.font, dpr, text, blur]);
    if (glyphCache.has(key)) return glyphCache.get(key);
    measure.font = spec.font;
    measure.textBaseline = 'alphabetic';
    const m = measure.measureText(text),
      left = -finite(m.actualBoundingBoxLeft, 0),
      top = -finite(m.actualBoundingBoxAscent, spec.fontSize),
      right = finite(m.actualBoundingBoxRight, m.width),
      bottom = finite(m.actualBoundingBoxDescent, spec.fontSize * 0.25),
      pad = 2 + Math.ceil(blur * dpr * 3),
      w = Math.max(1, Math.ceil((right - left) * dpr) + pad * 2),
      h = Math.max(1, Math.ceil((bottom - top) * dpr) + pad * 2);
    if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D)
      throw Error('UI glyph exceeds device dimension limit');
    const canvas = new OffscreenCanvas(w, h),
      ctx = canvas.getContext('2d');
    if (!ctx) throw Error('UI glyph Canvas2D unavailable');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = spec.font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, pad / dpr - left, pad / dpr - top);
    const g = { key, canvas, w, h, dpr, blur, left: left - pad / dpr, top: top - pad / dpr, advance: m.width };
    glyphCache.set(key, g);
    metadata.glyphRasterizations++;
    return g;
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
    const temp = [];
    let next, prepared;
    try {
      if (glyphClient) {
        prepared = await glyphClient.prepare(specs, settings, {
          limit: device.limits.maxTextureDimension2D,
          alignment: device.limits.minUniformBufferOffsetAlignment,
        });
        metadata.glyphRasterizations += prepared.rasterizations;
      }
      alive();
      next = await uiValidationScope(device, async () => {
        let runs, glyphs, size;
        if (prepared) {
          ({ runs, glyphs, size } = prepared);
        } else {
          const measure = new OffscreenCanvas(1, 1).getContext('2d');
          if (!measure) throw Error('UI glyph measurement unavailable');
          runs = new Map();
          const unique = new Map();
          for (const spec of specs) {
            const items = [];
            for (const p of spec.glyphs || [{ text: spec.text, x: 0 }]) {
              const g = getGlyph(spec, p.text, settings, measure);
              unique.set(g.key, g);
              items.push({ glyph: g, x: finite(p.x), y: finite(p.y) });
            }
            runs.set(spec.key, { ...spec, glyphs: items });
          }
          glyphs = [...unique.values()].map(g => ({ ...g }));
          const positions = new Map(glyphs.map(g => [g.key, g]));
          for (const run of runs.values()) for (const p of run.glyphs) p.glyph = positions.get(p.glyph.key);
          size = pack(glyphs);
        }
        const atlas = texture('UI glyph atlas', size.w, size.h, 'rgba8unorm', 'atlas', TU.COPY_DST | TU.COPY_SRC);
        temp.push(atlas);
        for (const g of glyphs) {
          device.queue.copyExternalImageToTexture(
            { source: g.bitmap || g.canvas },
            { texture: atlas, origin: [g.ax, g.ay], premultipliedAlpha: true },
            [g.w, g.h],
          );
          if (g.bitmap) prepared.closeGlyph(g);
          metadata.glyphUploads++;
        }
        prepared?.closeBitmaps?.();
        const blurred = prepared?.blurred || glyphs.filter(g => g.blur > 0.08),
          encoder = device.createCommandEncoder({ label: 'UI glyph prewarm' });
        let scratchBytes = 0;
        if (blurred.length) {
          const maxW = prepared?.maxW || Math.max(...blurred.map(g => g.w)),
            maxH = prepared?.maxH || Math.max(...blurred.map(g => g.h));
          const source = texture('UI one-glyph filter input', maxW, maxH, 'rgba8unorm', 'temporary', TU.COPY_DST);
          temp.push(source);
          const ping = texture('UI one-glyph horizontal Gaussian', maxW, maxH);
          temp.push(ping);
          scratchBytes = maxW * maxH * 8;
          const alignment = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
          const ub = buffer(
            'UI glyph bake params',
            alignment * blurred.length * 2,
            BU.UNIFORM | BU.COPY_DST,
            'temporary',
          );
          temp.push(ub);
          const vb = buffer('UI glyph bake instances', blurred.length * 64, BU.VERTEX | BU.COPY_DST, 'temporary');
          temp.push(vb);
          const params = prepared?.parameters || new Float32Array((alignment * blurred.length * 2) / 4),
            data = prepared?.vertices || new Float32Array(blurred.length * 16);
          const horizontal = device.createBindGroup({
            layout: glyphLayout,
            entries: [
              { binding: 0, resource: { buffer: ub, size: 32 } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: source.createView() },
              { binding: 3, resource: source.createView() },
            ],
          });
          const vertical = device.createBindGroup({
            layout: glyphLayout,
            entries: [
              { binding: 0, resource: { buffer: ub, size: 32 } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: ping.createView() },
              { binding: 3, resource: source.createView() },
            ],
          });
          for (let i = 0; i < blurred.length; i++) {
            const g = blurred[i];
            if (!prepared) {
              params.set([maxW, maxH, maxW, maxH, 0, 0, 0, 0], (i * 2 * alignment) / 4);
              params.set([size.w, size.h, maxW, maxH, 1, g.ax, g.ay, 0], ((i * 2 + 1) * alignment) / 4);
              data.set(
                [0, 0, g.w, g.h, g.blur * g.dpr, 0, 0, 0, g.ax, g.ay, g.w, g.h, g.blur * g.dpr, 0, 0, 0],
                i * 16,
              );
            }
            encoder.copyTextureToTexture({ texture: atlas, origin: [g.ax, g.ay] }, { texture: source }, [g.w, g.h]);
            let pass = encoder.beginRenderPass({
              label: 'UI slogan horizontal Gaussian',
              colorAttachments: attachment(ping),
            });
            pass.setPipeline(glyphPipeline);
            pass.setBindGroup(0, horizontal, [i * 2 * alignment]);
            pass.setVertexBuffer(0, vb);
            pass.draw(6, 1, 0, i * 2);
            pass.end();
            pass = encoder.beginRenderPass({
              label: 'UI slogan vertical Gaussian',
              colorAttachments: attachment(atlas, 'load'),
            });
            pass.setScissorRect(g.ax, g.ay, g.w, g.h);
            pass.setPipeline(glyphPipeline);
            pass.setBindGroup(0, vertical, [(i * 2 + 1) * alignment]);
            pass.setVertexBuffer(0, vb);
            pass.draw(6, 1, 0, i * 2 + 1);
            pass.end();
          }
          device.queue.writeBuffer(ub, 0, params);
          device.queue.writeBuffer(vb, 0, data);
        }
        prepared?.releaseData?.();
        alive();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        alive();
        metadata.lastPrepareScratchBytes = scratchBytes;
        metadata.lastPrepareBlurGlyphs = blurred.length;
        metadata.lastPrepareAtlasBytes = size.w * size.h * 4;
        return { atlas, runs, glyphs, size, view: atlas.createView() };
      });
      alive();
      const previous = installed;
      if (handoff) {
        handoff.complete(record, next);
        if (!installed) installed = next;
      } else {
        installed = next;
        for (const slot of slots.values()) slot.bind = null;
      }
      metadata.generation++;
      metadata.prepareCompleted++;
      metadata.ready = true;
      metadata.glyphCount = next.glyphs.length;
      metadata.runCount = next.runs.size;
      metadata.atlasWidth = next.size.w;
      metadata.atlasHeight = next.size.h;
      const keys = new Set(next.glyphs.map(g => g.key));
      for (const [key, g] of glyphCache)
        if (!keys.has(key)) {
          g.canvas.width = g.canvas.height = 1;
          glyphCache.delete(key);
        }
      metadata.cpuGlyphBytes =
        prepared?.cpuGlyphBytes ?? [...glyphCache.values()].reduce((n, g) => n + g.w * g.h * 4, 0);
      if (!handoff) release(previous?.atlas);
      return {
        generation: metadata.generation,
        ...(handoff ? handoff.result(record) : {}),
        byteCount: metadata.byteCount,
        glyphCount: metadata.glyphCount,
      };
    } finally {
      if (record && !record.data) handoff.fail(record);
      prepared?.dispose();
      for (const r of temp)
        if (r !== installed?.atlas && r !== handoff?.active?.data?.atlas && r !== handoff?.ready?.data?.atlas)
          release(r);
      metadata.preparing = false;
      recount();
    }
  }
  function prepare(specs, settings = {}) {
    if (disposed) return Promise.reject(Error('GPU UI renderer was disposed'));
    const copy = specs.map(s => ({ ...s, glyphs: s.glyphs?.map(g => ({ ...g })) }));
    const p = prepareQueue.then(() => buildAtlas(copy, { ...settings }));
    prepareQueue = p.catch(() => {});
    return p;
  }

  function makeSlot(name, count) {
    let slot = slots.get(name);
    const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    if (!slot || slot.capacity < capacity) {
      if (slot) {
        release(slot.uniform);
        release(slot.vertex);
      }
      slot = {
        capacity,
        uniform: buffer('UI ' + name + ' uniform', 32, BU.UNIFORM | BU.COPY_DST),
        vertex: buffer('UI ' + name + ' instances', capacity * 112, BU.VERTEX | BU.COPY_DST),
        data: new Float32Array(capacity * 28),
        uniformData: new Float32Array(8),
        bind: null,
      };
      slots.set(name, slot);
    }
    return slot;
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
    aux = [0, 1, 0, 1],
    shape = rect,
    color2 = color,
  ) {
    if (!(rect[2] > 0 && rect[3] > 0) || opacity <= 0.00001) return;
    list.push([...rect, ...uv, ...color, ...color2, kind, opacity, blur, radius, ...aux, ...shape]);
  }
  function primitive(list, obj, type = 1, dpr = 1) {
    if (!obj) return;
    const c = obj.color || [26 / 255, 31 / 255, 27 / 255, 1],
      opacity = clamp(finite(obj.opacity, finite(obj.alpha, 1))),
      rect = [obj.x, obj.y, obj.width, obj.height],
      pad = 1 / dpr;
    instance(
      list,
      [rect[0] - pad, rect[1] - pad, rect[2] + pad * 2, rect[3] + pad * 2],
      [0, 0, 1, 1],
      obj.color0 || c,
      type,
      opacity,
      0,
      finite(obj.radius),
      [finite(obj.start, 0), finite(obj.end, 1), finite(obj.borderWidth), pad],
      rect,
      obj.color1 || c,
    );
  }
  function addRuns(list, runs, dpr, rim) {
    for (const item of runs || []) {
      const run = installed.runs.get(item.key);
      if (!run)
        throw Error('GPU UI glyph is missing from prepared atlas: ' + String(item.text || item.key).slice(0, 80));
      const opacity = clamp(finite(item.opacity, 1));
      if (opacity <= 0.00001) continue;
      const sx = finite(item.width, run.width) / Math.max(0.0001, run.width),
        sy = finite(item.height, run.height) / Math.max(0.0001, run.height),
        scale = finite(item.scale, 1),
        cx = item.x + finite(item.width, run.width) * 0.5,
        cy = item.y + finite(item.translateY) + finite(item.height, run.height) * 0.5,
        colour = item.inkColor || [26 / 255, 31 / 255, 27 / 255, 1];
      for (const p of run.glyphs) {
        const g = p.glyph;
        let x = item.x + (p.x + g.left) * sx,
          y = item.y + finite(item.translateY) + (finite(run.baseline) + p.y + g.top) * sy;
        x = cx + (x - cx) * scale;
        y = cy + (y - cy) * scale;
        const quad = [x, y, (g.w / g.dpr) * sx * scale, (g.h / g.dpr) * sy * scale];
        instance(
          list,
          quad,
          [g.ax / installed.size.w, g.ay / installed.size.h, g.w / installed.size.w, g.h / installed.size.h],
          colour,
          0,
          opacity,
          g.blur ? clamp(finite(item.blur) / g.blur) : 0,
          rim ? rim.reach * finite(run.fontSize, finite(item.height, run.height)) * scale : 0,
          [0, 1, 0, 1 / dpr],
          quad,
          rim ? [rim.alpha, rim.lift, rim.paper, 0] : colour,
        );
      }
    }
  }
  function paintInstances(pass, list, W, H, originX, originY, name) {
    if (!list.length) return 0;
    const slot = makeSlot(name, list.length);
    if (!slot.bind)
      slot.bind = device.createBindGroup({
        layout: drawLayout,
        entries: [
          { binding: 0, resource: { buffer: slot.uniform } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: installed.view },
          { binding: 3, resource: assets.swash.createView() },
          { binding: 4, resource: assets.seal.createView() },
          { binding: 5, resource: (name === 'box' ? assets.blank : group?.texture || assets.blank).createView() },
        ],
      });
    slot.uniformData.set([W, H, originX, originY, 0, 0, 0, 0]);
    for (let i = 0; i < list.length; i++) slot.data.set(list[i], i * 28);
    device.queue.writeBuffer(slot.uniform, 0, slot.uniformData);
    device.queue.writeBuffer(slot.vertex, 0, slot.data.subarray(0, list.length * 28));
    pass.setPipeline(drawPipeline);
    pass.setBindGroup(0, slot.bind);
    pass.setBindGroup(1, shared.paperBindGroup());
    pass.setVertexBuffer(0, slot.vertex);
    pass.draw(6, list.length);
    return list.length;
  }
  function ensureGroup(w, h, dpr) {
    const pw = Math.max(1, Math.ceil(w * dpr)),
      ph = Math.max(1, Math.ceil(h * dpr));
    if (!group || pw > group.w || ph > group.h || group.dpr !== dpr) {
      release(group?.texture);
      release(group?.uniform);
      const gw = Math.max(group?.dpr === dpr ? group.w : 0, Math.ceil(pw / 64) * 64),
        gh = Math.max(group?.dpr === dpr ? group.h : 0, Math.ceil(ph / 64) * 64);
      group = {
        texture: texture('UI candidate group', gw, gh, canvasFormat, 'group'),
        uniform: buffer('UI candidate uniform', 144, BU.UNIFORM | BU.COPY_DST),
        uniformData: new Float32Array(36),
        w: gw,
        h: gh,
        dpr,
      };
      for (const slot of slots.values()) slot.bind = null;
    }
    metadata.groupWidth = group.w;
    metadata.groupHeight = group.h;
    return { pw, ph };
  }
  function ensureROI(w, h) {
    if (!roi || w > roi.w || h > roi.h) {
      if (roi) for (const t of roi.textures) release(t);
      release(roi?.uniform);
      const rw = Math.max(roi?.w || 0, Math.ceil(w / 32) * 32),
        rh = Math.max(roi?.h || 0, Math.ceil(h / 32) * 32);
      roi = {
        textures: [0, 1, 2].map(i => texture('UI backdrop ROI ' + i, rw, rh, 'rgba8unorm', 'roi', TU.STORAGE_BINDING)),
        w: rw,
        h: rh,
        alignment: Math.max(256, device.limits.minUniformBufferOffsetAlignment),
      };
      roi.uniform = buffer('UI backdrop uniforms', roi.alignment * 3, BU.UNIFORM | BU.COPY_DST);
      roi.uniformData = new Float32Array((roi.alignment * 3) / 4);
    }
    metadata.roiWidth = roi.w;
    metadata.roiHeight = roi.h;
  }
  let textureBinding;
  function filterBinding(source, direct) {
    roi.bindings ||= new WeakMap();
    let bind = roi.bindings.get(source);
    if (!bind) {
      const make = resource =>
        device.createBindGroup({
          layout: filterLayout,
          entries: [
            { binding: 0, resource: { buffer: roi.uniform, size: 64 } },
            { binding: 1, resource: sampler },
            { binding: 2, resource },
          ],
        });
      if (direct && textureBinding !== false) {
        try {
          bind = make(source);
          textureBinding = true;
        } catch (error) {
          textureBinding = false;
        }
      }
      if (!bind) bind = make(source.createView());
      roi.bindings.set(source, bind);
      metadata.runtimeBindingsCreated = (metadata.runtimeBindingsCreated || 0) + 1;
    } else metadata.runtimeBindingsReused = (metadata.runtimeBindingsReused || 0) + 1;
    return bind;
  }
  function filterComputeBinding(i, source, direct) {
    roi.computeBindings ||= new WeakMap();
    let bind = roi.computeBindings.get(source);
    if (!bind) {
      const make = resource =>
        device.createBindGroup({
          layout: filterComputeLayout,
          entries: [
            { binding: 0, resource: { buffer: roi.uniform, size: 64 } },
            { binding: 1, resource: sampler },
            { binding: 2, resource },
            { binding: 3, resource: roi.textures[i].createView() },
          ],
        });
      if (direct && textureBinding !== false) {
        try {
          bind = make(source);
          textureBinding = true;
        } catch (error) {
          textureBinding = false;
        }
      }
      if (!bind) bind = make(source.createView());
      roi.computeBindings.set(source, bind);
      metadata.runtimeBindingsCreated = (metadata.runtimeBindingsCreated || 0) + 1;
    } else metadata.runtimeBindingsReused = (metadata.runtimeBindingsReused || 0) + 1;
    return bind;
  }
  function candidateBinding(source) {
    group.bindings ||= new WeakMap();
    let bind = group.bindings.get(source);
    if (!bind) {
      bind = device.createBindGroup({
        layout: boxLayout,
        entries: [
          { binding: 0, resource: { buffer: group.uniform } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: source.createView() },
          { binding: 3, resource: repeatSampler },
          { binding: 4, resource: assets.grain.createView() },
        ],
      });
      group.bindings.set(source, bind);
      metadata.runtimeBindingsCreated = (metadata.runtimeBindingsCreated || 0) + 1;
    } else metadata.runtimeBindingsReused = (metadata.runtimeBindingsReused || 0) + 1;
    return bind;
  }
  function encode(encoder, frame, resources = {}) {
    alive();
    const atlasRecord = selectAtlas(frame);
    if (!installed) throw Error('GPU UI encode before prepare');
    const box = frame.box,
      W = frame.W,
      H = frame.H,
      dpr = finite(frame.dpr, 1);
    encoded = { generation: frame.generation, frameTimeMs: frame.frameTimeMs, atlasRecord, visible: false };
    if (!box || finite(box.opacity) <= 0.003 || box.width <= 0 || box.height <= 0) return encoded;
    const scale = Math.max(0.001, finite(box.scale, 1)),
      w = box.width,
      h = box.height,
      { pw, ph } = ensureGroup(w, h, dpr),
      glass = box.glass !== false;
    let region = [0, 0, 1, 1],
      rw = 1,
      rh = 1;
    if (glass) {
      if (!resources.sceneTexture) throw Error('GPU UI glass requires the completed scene texture');
      region = [box.x - w * scale * 0.5 - 48, box.y - h * scale * 0.5 - 48, w * scale + 96, h * scale + 96];
      rw = Math.max(1, Math.ceil(region[2] * 0.5));
      rh = Math.max(1, Math.ceil(region[3] * 0.5));
      ensureROI(rw, rh);
      const data = roi.uniformData;
      for (let i = 0; i < 3; i++) {
        const o = (i * roi.alignment) / 4;
        data[o] = rw;
        data[o + 1] = rh;
        data[o + 2] = roi.w;
        data[o + 3] = roi.h;
        data.set(region, o + 4);
        data[o + 8] = W;
        data[o + 9] = H;
        data[o + 10] = 0;
        data[o + 11] = 0;
        data[o + 12] = i;
        data[o + 13] = i === 1 ? (16 * rw) / region[2] : (16 * rh) / region[3];
        data[o + 14] = 0;
        data[o + 15] = 0;
      }
      device.queue.writeBuffer(roi.uniform, 0, data);
      if (filterComputePipeline) {
        const pass = encoder.beginComputePass({ label: 'UI backdrop' });
        pass.setPipeline(filterComputePipeline);
        for (let i = 0; i < 3; i++) {
          pass.setBindGroup(
            0,
            filterComputeBinding(i, i ? roi.textures[i - 1] : resources.sceneTexture, !i && resources.textureAsView),
            [i * roi.alignment],
          );
          pass.dispatchWorkgroups(Math.ceil(rw / 8), Math.ceil(rh / 8));
        }
        pass.end();
      } else
        for (let i = 0; i < 3; i++) {
          const source = i ? roi.textures[i - 1] : resources.sceneTexture,
            bind = filterBinding(source, !i && resources.textureAsView);
          const pass = encoder.beginRenderPass({
            label: 'UI backdrop ' + ['downsample', 'horizontal', 'vertical'][i],
            colorAttachments: attachment(roi.textures[i]),
          });
          pass.setViewport(0, 0, rw, rh, 0, 1);
          pass.setScissorRect(0, 0, rw, rh);
          pass.setPipeline(filterPipeline);
          pass.setBindGroup(0, bind, [i * roi.alignment]);
          pass.draw(3);
          pass.end();
        }
    }
    const tint = box.tint || {},
      edge = box.edge || [52 / 255, 72 / 255, 54 / 255, 0.15],
      glassColor = box.ground || box.glassColor || [252 / 255, 252 / 255, 249 / 255, 0.6],
      data = group.uniformData;
    data[0] = w;
    data[1] = h;
    data[2] = pw;
    data[3] = ph;
    data[4] = box.x;
    data[5] = box.y;
    data[6] = scale;
    data[7] = finite(box.radius, 18);
    data.set(region, 8);
    data[12] = rw;
    data[13] = rh;
    data[14] = glass ? roi.w : 1;
    data[15] = glass ? roi.h : 1;
    data.set(glassColor, 16);
    data.set(tint.out || [214 / 255, 231 / 255, 204 / 255, 0.74], 20);
    data.set(tint.in || [248 / 255, 220 / 255, 228 / 255, 0.78], 24);
    data[28] = finite(tint.start);
    data[29] = finite(tint.end, 1);
    data[30] = glass ? 1 : 0;
    data[31] = (w / pw + h / ph) * 0.5;
    data.set(edge, 32);
    device.queue.writeBuffer(group.uniform, 0, data);
    const bind = candidateBinding(glass ? roi.textures[2] : assets.blank);
    const pass = encoder.beginRenderPass({
      label: 'UI isolated candidate group',
      colorAttachments: attachment(group.texture),
    });
    pass.setViewport(0, 0, pw, ph, 0, 1);
    pass.setScissorRect(0, 0, pw, ph);
    pass.setPipeline(boxPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    if (resources.drawBoxParticles)
      resources.drawBoxParticles(pass, {
        W: w,
        H: h,
        offsetX: w / 2 - 400,
        offsetY: h / 2 - 160,
        fade: clamp(finite(box.opacity, 1)) * 0.95,
        key: 'box',
      });
    const list = [];
    for (const s of frame.swashes || []) {
      const sx = finite(s.scaleX, 1),
        sy = finite(s.scaleY, 1);
      instance(
        list,
        [s.x + (s.width * (1 - sx)) / 2, s.y + (s.height * (1 - sy)) / 2, s.width * sx, s.height * sy],
        [0, 0, 1, 1],
        s.color || [111 / 255, 154 / 255, 104 / 255, 1],
        3,
        finite(s.opacity, 0.5),
      );
    }
    addRuns(list, frame.boxRuns, dpr);
    const rule = frame.rule;
    if (rule) {
      const rect = [rule.x, rule.y, rule.width, rule.height],
        c = rule.color || [26 / 255, 31 / 255, 27 / 255, 0.34],
        a = finite(rule.opacity, 0.5),
        pad = 1 / dpr;
      instance(
        list,
        [rect[0], rect[1] - pad, rect[2] * 0.16, rect[3] + 2 * pad],
        [0, 0, 1, 1],
        [...c.slice(0, 3), 0],
        2,
        a,
        0,
        0,
        [0, 1, 0, pad],
        [rect[0], rect[1], rect[2] * 0.16, rect[3]],
        c,
      );
      primitive(
        list,
        { ...rule, x: rule.x + rule.width * 0.16, width: rule.width * 0.68, color: c, opacity: a },
        1,
        dpr,
      );
      instance(
        list,
        [rect[0] + rect[2] * 0.84, rect[1] - pad, rect[2] * 0.16, rect[3] + 2 * pad],
        [0, 0, 1, 1],
        c,
        2,
        a,
        0,
        0,
        [0, 1, 0, pad],
        [rect[0] + rect[2] * 0.84, rect[1], rect[2] * 0.16, rect[3]],
        [...c.slice(0, 3), 0],
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
    primitive(
      list,
      {
        x: -w / 2 + 5,
        y: -h / 2 + 5,
        width: Math.max(0, w - 10),
        height: Math.max(0, h - 10),
        radius: 14,
        borderWidth: 1,
        color: edge,
        opacity: 0.55,
      },
      1,
      dpr,
    );
    paintInstances(pass, list, w, h, -w / 2, -h / 2, 'box');
    pass.end();
    encoded = { generation: frame.generation, frameTimeMs: frame.frameTimeMs, atlasRecord, visible: true, pw, ph };
    return encoded;
  }
  function draw(pass, frame) {
    alive();
    if (handoff) {
      const record = handoff.select(frame);
      if (record !== encoded?.atlasRecord) throw Error('GPU UI draw needs encode of the same atlas generation');
      selectAtlas(frame, record);
    }
    if (!installed) throw Error('GPU UI draw before prepare');
    if (!encoded || encoded.generation !== frame.generation || encoded.frameTimeMs !== frame.frameTimeMs)
      throw Error('GPU UI draw requires encode of the same frame');
    const list = [],
      dpr = finite(frame.dpr, 1),
      box = frame.box;
    if (encoded.visible) {
      const s = finite(box.scale, 1),
        w = box.width * s,
        h = box.height * s,
        x = box.x - w / 2,
        y = box.y - h / 2,
        op = clamp(finite(box.opacity, 1)),
        colour = box.shade || [34 / 255, 52 / 255, 38 / 255, 0.4];
      for (const [offset, blur, spread] of [
        [30, 70, -30],
        [4, 14, -6],
      ]) {
        const sigma = blur * 0.5 * s,
          shape = [
            x - spread * s,
            y + (offset - spread) * s,
            Math.max(0.001, w + spread * 2 * s),
            Math.max(0.001, h + spread * 2 * s),
          ],
          p = sigma * 3;
        instance(
          list,
          [shape[0] - p, shape[1] - p, shape[2] + p * 2, shape[3] + p * 2],
          [0, 0, 1, 1],
          colour,
          6,
          op,
          sigma,
          finite(box.radius, 18) * s,
          [0, 1, -1, 1 / dpr],
          shape,
          [x, y, w, h],
        );
      }
      instance(
        list,
        [x, y, w, h],
        [0, 0, encoded.pw / group.w, encoded.ph / group.h],
        [1, 1, 1, 1],
        5,
        op,
        0,
        finite(box.radius, 18) * s,
        [0, 1, 0, 1 / dpr],
        [x, y, w, h],
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
      const s = finite(seal.scale, 1);
      instance(
        list,
        [seal.x + (seal.width * (1 - s)) / 2, seal.y + (seal.height * (1 - s)) / 2, seal.width * s, seal.height * s],
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
    metadata.instances = paintInstances(pass, list, frame.W, frame.H, 0, 0, 'overlay');
    return metadata.instances;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    handoff?.dispose();
    installed = null;
    encoded = null;
    glyphClient?.release();
    sealClient?.release();
    for (const r of [...owned.keys()]) release(r);
    for (const g of glyphCache.values()) g.canvas.width = g.canvas.height = 1;
    glyphCache.clear();
    slots.clear();
    metadata.ready = false;
    metadata.cpuGlyphBytes = 0;
    metadata.glyphCount = metadata.runCount = 0;
  }

  async function createAssetPipelines() {
    pathLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: SS.VERTEX | SS.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 336 },
        },
      ],
    });
    const pathShader = await module(
      'UI seeded brush paths',
      `
struct UIPaint { extent:vec4f,gradient:vec4f,stops:array<vec4f,9>,colours:array<vec4f,9>,control:vec4f }
@group(0) @binding(0) var<uniform> uiPaint:UIPaint;
struct UIPathOut{@builtin(position) position:vec4f,@location(0) pixel:vec2f}
@vertex fn uiPathVertex(@location(0) p:vec2f)->UIPathOut{var o:UIPathOut;o.position=vec4f(p.x/uiPaint.extent.x*2.0-1.0,1.0-p.y/uiPaint.extent.y*2.0,0,1);o.pixel=p;return o;}
@fragment fn uiPathFragment(i:UIPathOut)->@location(0) vec4f{let delta=uiPaint.gradient.zw-uiPaint.gradient.xy;let t=clamp(dot(i.pixel-uiPaint.gradient.xy,delta)/max(.00001,dot(delta,delta)),0.0,1.0);var c=uiPaint.colours[0];let n=u32(uiPaint.control.x);for(var k=1u;k<9u;k=k+1u){if(k>=n){break;}let lo=uiPaint.stops[k-1u].x;let hi=uiPaint.stops[k].x;c=mix(c,uiPaint.colours[k],clamp((t-lo)/max(.00001,hi-lo),0.0,1.0));}return vec4f(c.rgb*c.a,c.a);}
`,
    );
    const base = {
      layout: device.createPipelineLayout({ bindGroupLayouts: [pathLayout] }),
      vertex: {
        module: pathShader,
        entryPoint: 'uiPathVertex',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: 4 },
    };
    compile(
      device.createRenderPipelineAsync({
        ...base,
        label: 'UI winding stencil',
        fragment: {
          module: pathShader,
          entryPoint: 'uiPathFragment',
          targets: [{ format: 'rgba8unorm', writeMask: 0 }],
        },
        depthStencil: {
          format: 'depth24plus-stencil8',
          depthWriteEnabled: false,
          depthCompare: 'always',
          stencilFront: { compare: 'always', passOp: 'increment-wrap' },
          stencilBack: { compare: 'always', passOp: 'decrement-wrap' },
          stencilReadMask: 255,
          stencilWriteMask: 255,
        },
      }),
      value => {
        pathStencil = value;
      },
    );
    compile(
      device.createRenderPipelineAsync({
        ...base,
        label: 'UI brush fill',
        fragment: {
          module: pathShader,
          entryPoint: 'uiPathFragment',
          targets: [{ format: 'rgba8unorm', blend: premul }],
        },
        depthStencil: {
          format: 'depth24plus-stencil8',
          depthWriteEnabled: false,
          depthCompare: 'always',
          stencilFront: { compare: 'not-equal', passOp: 'zero' },
          stencilBack: { compare: 'not-equal', passOp: 'zero' },
          stencilReadMask: 255,
          stencilWriteMask: 255,
        },
      }),
      value => {
        pathFill = value;
      },
    );
    assetShapeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const shapeShader = await module(
      'UI asset analytic details',
      `
@group(0) @binding(0) var<uniform> uiAssetSize:vec4f;
@group(0) @binding(1) var uiAssetSampler:sampler;
@group(0) @binding(2) var uiAssetGlyph:texture_2d<f32>;
struct UIAssetOut{@builtin(position) position:vec4f,@location(0) point:vec2f,@location(1) shape:vec4f,@location(2) colour:vec4f,@location(3) config:vec4f,@location(4) uv:vec2f}
@vertex fn uiAssetVertex(@builtin(vertex_index)i:u32,@location(0)rect:vec4f,@location(1)shape:vec4f,@location(2)colour:vec4f,@location(3)config:vec4f)->UIAssetOut{let p=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));let q=rect.xy+p[i]*rect.zw;var o:UIAssetOut;o.position=vec4f(q.x/uiAssetSize.x*2.0-1.0,1.0-q.y/uiAssetSize.y*2.0,0,1);o.point=q;o.shape=shape;o.colour=colour;o.config=config;o.uv=p[i];return o;}
@fragment fn uiAssetFragment(i:UIAssetOut)->@location(0)vec4f{var a=1.0;if(i.config.x<.5){a=textureSampleLevel(uiAssetGlyph,uiAssetSampler,i.uv,0.0).a;}else if(i.config.x<1.5){let d=length(i.point-i.shape.xy)-i.shape.z;a=clamp(.5-d*uiAssetSize.z,0.0,1.0);}else{let delta=i.shape.zw-i.shape.xy;let t=clamp(dot(i.point-i.shape.xy,delta)/max(.00001,dot(delta,delta)),0.0,1.0);let d=length(i.point-(i.shape.xy+delta*t))-i.config.y*.5;a=clamp(.5-d*uiAssetSize.z,0.0,1.0);}a*=i.colour.a;return vec4f(i.colour.rgb*a,a);}
`,
    );
    const shapeBase = {
      layout: device.createPipelineLayout({ bindGroupLayouts: [assetShapeLayout] }),
      vertex: {
        module: shapeShader,
        entryPoint: 'uiAssetVertex',
        buffers: [
          {
            arrayStride: 64,
            stepMode: 'instance',
            attributes: Array.from({ length: 4 }, (_, i) => ({
              shaderLocation: i,
              offset: i * 16,
              format: 'float32x4',
            })),
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    };
    compile(
      device.createRenderPipelineAsync({
        ...shapeBase,
        label: 'UI asset detail',
        fragment: {
          module: shapeShader,
          entryPoint: 'uiAssetFragment',
          targets: [{ format: 'rgba8unorm', blend: premul }],
        },
      }),
      value => {
        assetShapePipeline = value;
      },
    );
    compile(
      device.createRenderPipelineAsync({
        ...shapeBase,
        label: 'UI seal carving',
        fragment: {
          module: shapeShader,
          entryPoint: 'uiAssetFragment',
          targets: [
            {
              format: 'rgba8unorm',
              blend: {
                color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
      }),
      value => {
        assetErasePipeline = value;
      },
    );
    grainLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: SS.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const grainShader = await module(
      'UI seeded paper grain',
      fullscreen +
        `
@group(0) @binding(0) var<storage,read> uiNoise:array<f32>;
@group(0) @binding(1) var uiGrainBase:texture_2d<f32>;
@group(0) @binding(2) var<uniform> uiGrainOp:vec4u;
fn uiNoiseAt(p:vec2f,period:u32,offset:u32)->f32{let base=vec2u(floor(p));let f=fract(p);let s=f*f*(vec2f(3)-2.0*f);let x0=base.x%period;let y0=base.y%period;let x1=(x0+1u)%period;let y1=(y0+1u)%period;return mix(mix(uiNoise[offset+y0*period+x0],uiNoise[offset+y0*period+x1],s.x),mix(uiNoise[offset+y1*period+x0],uiNoise[offset+y1*period+x1],s.x),s.y);}
@fragment fn uiGrainFragment(@builtin(position) pos:vec4f)->@location(0)vec4f{let p=vec2u(pos.xy);if(uiGrainOp.x==1u){let b=textureLoad(uiGrainBase,vec2i(p),0).r*255.0;let v=round(232.0+(b-128.0)*.32)/255.0;return vec4f(v,v,round(230.0+(b-128.0)*.32)/255.0,1);}
 let uv=vec2f(p)/220.0;let value=.5+(uiNoiseAt(uv*13.0,13u,0u)-.5)*.26+(uiNoiseAt(uv*55.0,55u,169u)-.5)*.2+(uiNoiseAt(uv*220.0,220u,3194u)-.5)*.16+(uiNoise[51594u+p.y*220u+p.x]-.5)*.13;let c=round(clamp(value,0.0,1.0)*255.0)/255.0;return vec4f(c,c,c,1);}
`,
    );
    compile(
      device.createRenderPipelineAsync({
        label: 'UI procedural paper',
        layout: device.createPipelineLayout({ bindGroupLayouts: [grainLayout] }),
        vertex: { module: grainShader, entryPoint: 'uiFull' },
        fragment: { module: grainShader, entryPoint: 'uiGrainFragment', targets: [{ format: 'rgba8unorm' }] },
      }),
      value => {
        grainPipeline = value;
      },
    );
    await pipelinesReady();
  }
  async function buildAssets() {
    alive();
    const temp = [],
      keep = [];
    let sealPrepared;
    try {
      const grainPacket = shared.startup?.uiGrain ? await shared.startup.uiGrain() : null;
      alive();
      if (sealClient) {
        sealPrepared = await sealClient.prepare(
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
          { limit: device.limits.maxTextureDimension2D, alignment: device.limits.minUniformBufferOffsetAlignment },
        );
        metadata.glyphRasterizations += sealPrepared.rasterizations;
      }
      alive();
      return await creationValidation(async () => {
        const swash = texture('UI brush swash', 240, 60, 'rgba8unorm', 'asset'),
          seal = texture('UI engraved seal', 72, 176, 'rgba8unorm', 'asset'),
          grain = texture('UI paper grain', 220, 220, 'rgba8unorm', 'asset'),
          blank = texture('UI transparent fallback', 1, 1, 'rgba8unorm', 'asset');
        keep.push(swash, seal, grain, blank);
        const encoder = device.createCommandEncoder({ label: 'UI GPU asset bake' });
        let clear = encoder.beginRenderPass({ colorAttachments: attachment(blank) });
        clear.end();
        const rec = uiRecordBrush();
        const P = shared.samplePath(
          s => [
            10 + s * 220,
            31 - Math.sin(s * Math.PI) * 2.5 + (s - 0.5) * 4,
            21 * (0.78 + 0.22 * Math.sin(Math.PI * Math.min(1, s * 1.5))) * (1 - 0.18 * s * s),
          ],
          90,
        );
        shared.brush(rec.ctx, P, {
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
        bakePaths(encoder, swash, 240, 60, rec.calls, temp);
        const r = shared.rng(99),
          rr = shared.rr,
          pts = [];
        for (let i = 0; i < 160; i++) {
          const t = i / 40,
            s = t % 1,
            p = t < 1 ? [s * 18, 0] : t < 2 ? [18, s * 44] : t < 3 ? [18 - s * 18, 44] : [0, 44 - s * 44],
            j = (r() - 0.5) * 0.9;
          pts.push([clamp(p[0] + j, 0, 18) * 4, clamp(p[1] + j, 0, 44) * 4]);
        }
        bakePaths(
          encoder,
          seal,
          72,
          176,
          [
            {
              polygons: [pts],
              paint: { gradient: [0, 0, 1, 0], stops: [0], colours: [[179 / 255, 57 / 255, 45 / 255, 1]] },
            },
          ],
          temp,
        );
        const sealUB = buffer('UI seal dimensions', 16, BU.UNIFORM | BU.COPY_DST, 'temporary');
        temp.push(sealUB);
        device.queue.writeBuffer(sealUB, 0, new Float32Array([18, 44, 4, 0]));
        for (const [text, y] of [
          ['字', 44 * 0.29],
          ['在', 44 * 0.73],
        ]) {
          let cv, g;
          if (sealPrepared) {
            g = sealPrepared.runs.get(text).glyphs[0].glyph;
            cv = g.bitmap || g.canvas;
          } else {
            cv = new OffscreenCanvas(72, 176);
            const ctx = cv.getContext('2d');
            if (!ctx) throw Error('UI seal glyph raster unavailable');
            ctx.scale(4, 4);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '600 18px "Noto Serif SC", "Songti SC", serif';
            ctx.fillStyle = '#fff';
            ctx.fillText(text, 9, y);
            metadata.glyphRasterizations++;
          }
          const tex = texture('UI seal glyph ' + text, 72, 176, 'rgba8unorm', 'temporary', TU.COPY_DST);
          temp.push(tex);
          device.queue.copyExternalImageToTexture(
            { source: cv },
            { texture: tex, premultipliedAlpha: true },
            [72, 176],
          );
          if (g?.bitmap) sealPrepared.closeGlyph(g);
          metadata.glyphUploads++;
          paintAsset(
            encoder,
            seal,
            18,
            44,
            sealUB,
            tex,
            [[0, 0, 18, 44, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0]],
            true,
            temp,
          );
        }
        sealPrepared?.dispose();
        const marks = [];
        for (let i = 0; i < 120; i++) {
          const a = rr(r, 0.15, 0.85),
            x = r() * 18,
            y = r() * 44,
            radius = rr(r, 0.12, 0.55),
            p = radius + 0.25;
          marks.push([x - p, y - p, p * 2, p * 2, x, y, radius, 0, 1, 1, 1, a, 1, 0, 0, 0]);
        }
        for (let i = 0; i < 6; i++) {
          const a = rr(r, 0.1, 0.3),
            width = rr(r, 0.3, 0.8),
            y0 = r() * 44,
            y1 = y0 + rr(r, -4, 4),
            pad = width * 0.5 + 0.25;
          marks.push([
            -2 - pad,
            Math.min(y0, y1) - pad,
            22 + 2 * pad,
            Math.abs(y1 - y0) + 2 * pad,
            -2,
            y0,
            20,
            y1,
            1,
            1,
            1,
            a,
            2,
            width,
            0,
            0,
          ]);
        }
        paintAsset(encoder, seal, 18, 44, sealUB, blank, marks, true, temp);
        bakeGrain(encoder, grain, blank, temp, grainPacket);
        alive();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        alive();
        return { swash, seal, grain, blank };
      });
    } catch (error) {
      for (const r of keep) release(r);
      throw error;
    } finally {
      sealPrepared?.dispose();
      sealClient?.release();
      for (const r of temp) release(r);
    }
  }
  function bakePaths(encoder, destination, w, h, calls, temp) {
    const msaa = own(
        device.createTexture({
          label: 'UI brush 4x AA',
          size: [w, h],
          format: 'rgba8unorm',
          sampleCount: 4,
          usage: TU.RENDER_ATTACHMENT,
        }),
        w * h * 16,
      ),
      stencil = own(
        device.createTexture({
          label: 'UI brush winding',
          size: [w, h],
          format: 'depth24plus-stencil8',
          sampleCount: 4,
          usage: TU.RENDER_ATTACHMENT,
        }),
        w * h * 16,
      );
    temp.push(msaa, stencil);
    const align =
        Math.ceil(336 / device.limits.minUniformBufferOffsetAlignment) * device.limits.minUniformBufferOffsetAlignment,
      ub = buffer('UI path paints', Math.max(align, align * calls.length), BU.UNIFORM | BU.COPY_DST, 'temporary'),
      data = new Float32Array(Math.max(align, align * calls.length) / 4),
      vertices = [],
      segments = [];
    temp.push(ub);
    calls.forEach((call, i) => {
      const first = vertices.length / 2;
      for (const p of call.polygons)
        for (let j = 1; j < p.length - 1; j++) for (const q of [p[0], p[j], p[j + 1]]) vertices.push(...q);
      const count = vertices.length / 2 - first;
      vertices.push(0, 0, w, 0, 0, h, 0, h, w, 0, w, h);
      segments.push({ first, count, offset: i * align });
      const p = call.paint,
        o = (i * align) / 4;
      data.set([w, h, 0, 0, ...p.gradient], o);
      for (let k = 0; k < 9; k++) {
        data[o + 8 + k * 4] = finite(p.stops[k], 1);
        data.set(p.colours[Math.min(k, p.colours.length - 1)], o + 44 + k * 4);
      }
      data[o + 80] = p.stops.length;
    });
    const vb = buffer('UI brush triangles', Math.max(8, vertices.length * 4), BU.VERTEX | BU.COPY_DST, 'temporary');
    temp.push(vb);
    device.queue.writeBuffer(ub, 0, data);
    if (vertices.length) device.queue.writeBuffer(vb, 0, new Float32Array(vertices));
    const bind = device.createBindGroup({
      layout: pathLayout,
      entries: [{ binding: 0, resource: { buffer: ub, size: 336 } }],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: msaa.createView(),
          resolveTarget: destination.createView(),
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
    pass.setVertexBuffer(0, vb);
    for (const s of segments) {
      if (!s.count) continue;
      pass.setBindGroup(0, bind, [s.offset]);
      pass.setPipeline(pathStencil);
      pass.draw(s.count, 1, s.first);
      pass.setPipeline(pathFill);
      pass.draw(6, 1, s.first + s.count);
    }
    pass.end();
  }
  function paintAsset(encoder, destination, w, h, uniform, glyph, data, erase, temp) {
    if (!data.length) return;
    const values = data instanceof Float32Array ? data : new Float32Array(data.flat());
    if (values.length % 16) throw Error('Invalid UI asset instance packet');
    const count = values.length / 16,
      vb = buffer('UI asset details', values.byteLength, BU.VERTEX | BU.COPY_DST, 'temporary');
    temp.push(vb);
    device.queue.writeBuffer(vb, 0, values);
    const bind = device.createBindGroup({
      layout: assetShapeLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: glyph.createView() },
      ],
    });
    const pass = encoder.beginRenderPass({ colorAttachments: attachment(destination, 'load') });
    pass.setPipeline(erase ? assetErasePipeline : assetShapePipeline);
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, vb);
    pass.draw(6, count);
    pass.end();
  }
  function bakeGrain(encoder, destination, blank, temp, packet) {
    let values, fibres;
    if (packet) {
      values = packet.values;
      fibres = packet.fibres;
      if (
        !(values instanceof Float32Array) ||
        values.length !== 13 * 13 + 55 * 55 + 220 * 220 * 2 ||
        !(fibres instanceof Float32Array) ||
        fibres.length % 16
      )
        throw Error('Invalid UI grain Worker packet');
    } else {
      const list = [];
      for (const [seed, period] of [
        [9, 13],
        [10, 55],
        [11, 220],
      ]) {
        const n = shared.periodicNoise(seed, period);
        for (let y = 0; y < period; y++) for (let x = 0; x < period; x++) list.push(n(x, y));
      }
      const r = shared.rng(12),
        rr = shared.rr;
      for (let i = 0; i < 220 * 220; i++) list.push(r());
      values = new Float32Array(list);
      fibres = [];
      for (let k = 0; k < (((220 * 220) / 380) | 0); k++) {
        const x = r() * 220,
          y = r() * 220,
          len = rr(r, 5, 30),
          a0 = r() * Math.PI * 2,
          curv = rr(r, -0.12, 0.12),
          light = r() < 0.55,
          alpha = +(light ? rr(r, 0.1, 0.3) : rr(r, 0.04, 0.12)).toFixed(3),
          width = rr(r, 0.4, 1.1);
        for (const ox of [-220, 0, 220])
          for (const oy of [-220, 0, 220]) {
            let px = x + ox,
              py = y + oy,
              a = a0;
            if (px < -40 || px > 260 || py < -40 || py > 260) continue;
            for (let s = 0; s < 6; s++) {
              a += curv;
              const nx = px + (Math.cos(a) * len) / 6,
                ny = py + (Math.sin(a) * len) / 6,
                pad = width * 0.5 + 0.5,
                c = light ? 1 : 0;
              fibres.push([
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
              ]);
              px = nx;
              py = ny;
            }
          }
      }
    }
    metadata.grainPreparation = packet ? 'startup-worker-packet' : 'main';
    const storage = buffer('UI seeded noise lattice', values.byteLength, BU.STORAGE | BU.COPY_DST, 'temporary'),
      op0 = buffer('UI grain generate op', 16, BU.UNIFORM | BU.COPY_DST, 'temporary'),
      op1 = buffer('UI grain remap op', 16, BU.UNIFORM | BU.COPY_DST, 'temporary'),
      base = texture('UI paper before light remap', 220, 220);
    temp.push(storage, op0, op1, base);
    device.queue.writeBuffer(storage, 0, values);
    device.queue.writeBuffer(op0, 0, new Uint32Array([0, 0, 0, 0]));
    device.queue.writeBuffer(op1, 0, new Uint32Array([1, 0, 0, 0]));
    const bind = (source, ub) =>
      device.createBindGroup({
        layout: grainLayout,
        entries: [
          { binding: 0, resource: { buffer: storage } },
          { binding: 1, resource: source.createView() },
          { binding: 2, resource: { buffer: ub } },
        ],
      });
    let pass = encoder.beginRenderPass({ colorAttachments: attachment(base) });
    pass.setPipeline(grainPipeline);
    pass.setBindGroup(0, bind(blank, op0));
    pass.draw(3);
    pass.end();
    const ub = buffer('UI grain geometry dimensions', 16, BU.UNIFORM | BU.COPY_DST, 'temporary');
    temp.push(ub);
    device.queue.writeBuffer(ub, 0, new Float32Array([220, 220, 1, 0]));
    paintAsset(encoder, base, 220, 220, ub, blank, fibres, false, temp);
    pass = encoder.beginRenderPass({ colorAttachments: attachment(destination) });
    pass.setPipeline(grainPipeline);
    pass.setBindGroup(0, bind(base, op1));
    pass.draw(3);
    pass.end();
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
    setAtlasReferences: (frames, project) => handoff?.references(frames, project),
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

function uiRecordBrush() {
  let polygons = [],
    current = null,
    fillStyle = 'rgba(0,0,0,1)';
  const calls = [];
  const parse = text => {
    const match = String(text)
      .match(/[\d.]+/g)
      ?.map(Number);
    if (!match || match.length < 3) throw Error('Unsupported UI brush colour: ' + text);
    return [match[0] / 255, match[1] / 255, match[2] / 255, finiteUI(match[3], 1)];
  };
  const ctx = {
    beginPath() {
      polygons = [];
      current = null;
    },
    moveTo(x, y) {
      current = [[x, y]];
      polygons.push(current);
    },
    lineTo(x, y) {
      if (!current) this.moveTo(x, y);
      else current.push([x, y]);
    },
    closePath() {},
    createLinearGradient(x0, y0, x1, y1) {
      return {
        gradient: [x0, y0, x1, y1],
        stops: [],
        colours: [],
        addColorStop(stop, colour) {
          this.stops.push(stop);
          this.colours.push(parse(colour));
        },
      };
    },
    fill() {
      const paint =
        typeof fillStyle === 'string' ? { gradient: [0, 0, 1, 0], stops: [0], colours: [parse(fillStyle)] } : fillStyle;
      calls.push({ polygons: polygons.map(p => p.slice()), paint });
    },
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value) {
      fillStyle = value;
    },
  };
  return { ctx, calls };
}
function finiteUI(x, fallback) {
  return Number.isFinite(x) ? x : fallback;
}
async function uiValidationScope(device, operation) {
  device.pushErrorScope('validation');
  let result, failure;
  try {
    result = await operation();
  } catch (error) {
    failure = error;
  }
  let validation;
  try {
    validation = await device.popErrorScope();
  } catch (error) {
    if (!failure) failure = error;
  }
  if (failure) throw failure;
  if (validation) throw Error('WebGPU UI validation: ' + validation.message);
  return result;
}
