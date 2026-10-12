async function createGPUText(device, canvasFormat, shared) {
  if (!shared?.paperWGSL || !shared.paperLayout || !shared.paperBindGroup)
    throw Error('GPU text requires shared paper shader and bindings');
  const BU = GPUBufferUsage,
    TU = GPUTextureUsage,
    SS = GPUShaderStage;
  const metadata = {
    backend: 'webgpu-text-runs',
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
    atlasFormat: 'rgba8unorm',
    atlasBytes: 0,
    glyphAtlasBytes: 0,
    bufferBytes: 0,
    temporaryBytes: 0,
    byteCount: 0,
    peakBytes: 0,
    cpuGlyphBytes: 0,
    warnings: [],
    filters: {
      entrySigmaCss: 6,
      drySigmaEm: 0.2,
      gaussianExtent: 3,
      morphology: 'separable square; fractional endpoints',
      runChannels: ['clear / halo / dry / unused', 'entry clear / entry halo / unused / unused'],
    },
  };
  const owned = new Map(),
    glyphCache = new Map(),
    slots = new Map();
  const glyphClient = shared.glyphPreparation?.acquire('text');
  if (glyphClient) metadata.preparation = glyphClient.metadata;
  let disposed = false,
    installed = null,
    prepareQueue = Promise.resolve();
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  function recount() {
    metadata.byteCount = 0;
    metadata.bufferBytes = 0;
    metadata.temporaryBytes = 0;
    for (const { bytes, kind } of owned.values()) {
      metadata.byteCount += bytes;
      if (kind === 'buffer') metadata.bufferBytes += bytes;
      if (kind === 'temporary') metadata.temporaryBytes += bytes;
    }
    metadata.peakBytes = Math.max(metadata.peakBytes, metadata.byteCount);
  }
  function own(resource, bytes, kind = 'temporary') {
    owned.set(resource, { bytes, kind });
    recount();
    return resource;
  }
  function release(resource) {
    if (resource && owned.delete(resource)) {
      resource.destroy();
      recount();
    }
  }
  function alive() {
    if (disposed) throw Error('GPU text renderer was disposed');
  }
  async function checkedModule(label, code) {
    const shader = device.createShaderModule({ label, code });
    const info = await shader.getCompilationInfo(),
      errors = info.messages.filter(m => m.type === 'error');
    if (errors.length) throw Error(label + ': ' + errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    metadata.warnings.push(...info.messages.filter(m => m.type === 'warning').map(m => label + ': ' + m.message));
    return shader;
  }
  const premul = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  let drawPipeline,
    glyphPipeline,
    processPipeline,
    packPipeline,
    ownLayout,
    sampler,
    processLayout,
    glyphLayout,
    packLayout;
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
    shared.constructionScope?.active ? operation() : textValidationScope(device, operation);
  try {
    await creationValidation(async () => {
      ownLayout = device.createBindGroupLayout({
        label: 'text draw resources',
        entries: [
          { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        ],
      });
      sampler = device.createSampler({
        label: 'text linear clamp',
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
      const shader = await checkedModule(
        'text draw shader',
        shared.paperWGSL +
          `
struct TextUniforms { viewport:vec4f, clip:vec4f, config:vec4f, flags:vec4f }
@group(0) @binding(0) var<uniform> textFrame:TextUniforms;
@group(0) @binding(1) var textSampler:sampler;
@group(0) @binding(2) var textAtlas:texture_2d_array<f32>;
struct TextVertex {
 @builtin(position) position:vec4f, @location(0) css:vec2f, @location(1) uv:vec2f,
 @location(2) colour:vec4f, @location(3) effect:vec4f,
 @location(4) underline:vec4f, @location(5) underlineColour:vec4f, @location(6) box:vec4f
}
@vertex fn textVertex(@builtin(vertex_index) i:u32, @location(0) box:vec4f, @location(1) uv:vec4f,
 @location(2) colour:vec4f, @location(3) effect:vec4f, @location(4) underline:vec4f,
 @location(5) underlineColour:vec4f, @location(6) extra:vec4f) -> TextVertex {
 let textCorners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let point=box.xy+textCorners[i]*box.zw;
 var result:TextVertex; result.position=vec4f(point.x/textFrame.viewport.x*2.0-1.0,1.0-point.y/textFrame.viewport.y*2.0,0,1);
 result.css=point;result.uv=uv.xy+textCorners[i]*uv.zw;result.colour=colour;result.effect=effect;
 result.underline=underline;result.underlineColour=underlineColour;result.box=vec4f(box.xy+extra.xy,extra.zw);return result;
}
fn textOver(front:vec4f,back:vec4f)->vec4f { return front+back*(1.0-front.a); }
fn textErf(value:f32)->f32 {
 let x=abs(value);let t=1.0/(1.0+0.3275911*x);
 let polynomial=(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t;
 return sign(value)*(1.0-polynomial*exp(-x*x));
}
fn textCDF(value:f32)->f32 { return 0.5+0.5*textErf(value*0.7071067811865476); }
fn textRectangle(point:vec2f,box:vec4f,sigma:f32)->f32 {
 if(box.z<=0.0 || box.w<=0.0){return 0.0;}
 if(sigma>0.0){let a=(point-box.xy)/sigma;let b=(point-box.xy-box.zw)/sigma;return max(0.0,(textCDF(a.x)-textCDF(b.x))*(textCDF(a.y)-textCDF(b.y)));}
 let halfSize=box.zw*0.5;let distance=abs(point-box.xy-halfSize)-halfSize;
 let aa=0.5/max(1.0,textFrame.viewport.z);return clamp(0.5-max(distance.x,distance.y)/(2.0*aa),0.0,1.0);
}
@fragment fn textFragment(input:TextVertex)->@location(0) vec4f {
 let point=input.css;let line=textFrame.clip;
 if(point.x<line.x||point.x>line.x+line.z||point.y<line.y||point.y>line.y+line.w){discard;}
 let fadeWidth=max(0.0001,line.z*(textFrame.config.y-textFrame.config.x));
 let fade=clamp((point.x-line.x-line.z*textFrame.config.x)/fadeWidth,0.0,1.0);
 if(fade<=0.0){discard;}
 var pixel=vec4f(0);
 if(input.effect.w>0.5){
   let radius=min(input.effect.y,min(input.box.z,input.box.w)*0.5);
   let q=abs(point-input.box.xy-input.box.zw*0.5)-(input.box.zw*0.5-vec2f(radius));
   let distance=length(max(q,vec2f(0)))+min(max(q.x,q.y),0.0)-radius;
   let alpha=clamp(0.5-distance*textFrame.viewport.z,0.0,1.0)*input.colour.a;
   pixel=vec4f(input.colour.rgb*alpha,alpha);
 }else{
   let clear=textureSampleLevel(textAtlas,textSampler,input.uv,0,0.0);
   var coverage=clear.rg;
   if(input.effect.y>0.0001){let blurred=textureSampleLevel(textAtlas,textSampler,input.uv,1,0.0);coverage=mix(clear.rg,blurred.rg,input.effect.y);}
   let inkAlpha=coverage.r*input.colour.a;
   let haloAlpha=coverage.g*textFrame.viewport.w*textFrame.flags.x;
   let dryAlpha=clear.b*input.effect.z;
   var underMask=0.0;
   if(input.underlineColour.a>0.0001&&input.underline.z>0.0&&input.underline.w>0.0){
     underMask=textRectangle(point,input.underline,0.0);
     if(input.effect.y>0.0001){underMask=mix(underMask,textRectangle(point,input.underline,6.0),input.effect.y);}
   }
   let underAlpha=underMask*input.underlineColour.a;
   if(max(max(inkAlpha,haloAlpha),max(dryAlpha,underAlpha))<0.0001){discard;}
   var halo=vec4f(0);
   if(haloAlpha>0.0001){let paper=mix(textPaperAt(point,textFrame.viewport.xy,textFrame.config.w),vec3f(1),textFrame.config.z);halo=vec4f(paper*haloAlpha,haloAlpha);}
   pixel=textOver(vec4f(input.colour.rgb*inkAlpha,inkAlpha),halo);
   pixel=textOver(pixel,vec4f(input.colour.rgb*dryAlpha,dryAlpha));
   pixel=textOver(pixel,vec4f(input.underlineColour.rgb*underAlpha,underAlpha));
 }
 return pixel*(input.effect.x*fade);
}
`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'text instanced compositing',
          layout: device.createPipelineLayout({ bindGroupLayouts: [ownLayout, shared.paperLayout] }),
          vertex: {
            module: shader,
            entryPoint: 'textVertex',
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
          },
          fragment: { module: shader, entryPoint: 'textFragment', targets: [{ format: canvasFormat, blend: premul }] },
          primitive: { topology: 'triangle-list' },
        }),
        value => {
          drawPipeline = value;
        },
      );
      glyphLayout = device.createBindGroupLayout({
        label: 'text glyph resources',
        entries: [
          {
            binding: 0,
            visibility: SS.VERTEX,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
          },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const glyphShader = await checkedModule(
        'text glyph mask shader',
        `
@group(0) @binding(0) var<uniform> textSize:vec4f;
@group(0) @binding(1) var textGlyphSampler:sampler;
@group(0) @binding(2) var textGlyphAtlas:texture_2d<f32>;
struct TextGlyphVertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn textGlyphVertex(@builtin(vertex_index) i:u32,@location(0) box:vec4f,@location(1) uv:vec4f)->TextGlyphVertex {
 let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let point=box.xy+corners[i]*box.zw;var result:TextGlyphVertex;
 result.position=vec4f(point.x/textSize.x*2.0-1.0,1.0-point.y/textSize.y*2.0,0,1);result.uv=uv.xy+corners[i]*uv.zw;return result;
}
@fragment fn textGlyphFragment(input:TextGlyphVertex)->@location(0) vec4f {
 let alpha=textureSampleLevel(textGlyphAtlas,textGlyphSampler,input.uv,0.0).a;return vec4f(alpha,0,0,alpha);
}
`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'text glyphs to run mask',
          layout: device.createPipelineLayout({ bindGroupLayouts: [glyphLayout] }),
          vertex: {
            module: glyphShader,
            entryPoint: 'textGlyphVertex',
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
          fragment: {
            module: glyphShader,
            entryPoint: 'textGlyphFragment',
            targets: [{ format: 'rgba8unorm', blend: premul }],
          },
          primitive: { topology: 'triangle-list' },
        }),
        value => {
          glyphPipeline = value;
        },
      );
      processLayout = device.createBindGroupLayout({
        label: 'text local filter resources',
        entries: [
          {
            binding: 0,
            visibility: SS.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 },
          },
          { binding: 1, visibility: SS.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const fullscreen = `
@vertex fn textLocalVertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let positions=array<vec2f,3>(vec2f(-1,1),vec2f(3,1),vec2f(-1,-3));return vec4f(positions[i],0,1);
}
`;
      const processShader = await checkedModule(
        'text local filter shader',
        fullscreen +
          `
struct TextFilter { extent:vec4f, control:vec4f }
@group(0) @binding(0) var<uniform> textFilter:TextFilter;
@group(0) @binding(1) var textLocalSampler:sampler;
@group(0) @binding(2) var textSource:texture_2d<f32>;
@group(0) @binding(3) var textOther:texture_2d<f32>;
fn textSample(point:vec2f)->vec4f { return textureSampleLevel(textSource,textLocalSampler,point/textFilter.extent.xy,0.0); }
@fragment fn textLocalFragment(@builtin(position) position:vec4f)->@location(0) vec4f {
 let point=position.xy;let op=u32(textFilter.control.x);let amount=textFilter.control.y;
 if(op==4u){return vec4f(textSample(point).r,textureSampleLevel(textOther,textLocalSampler,point/textFilter.extent.xy,0.0).r,0,0);}
 let axis=select(vec2f(1,0),vec2f(0,1),op==1u||op==3u);
 if(op<2u){
   let radius=i32(ceil(amount));var maximum=0.0;
   for(var i=-radius;i<=radius;i=i+1){let offset=clamp(f32(i),-amount,amount);var alpha=textSample(point+axis*offset).r;if(op==0u){alpha=clamp(2.5*alpha-0.5,0.0,1.0);}maximum=max(maximum,alpha);}
   return vec4f(maximum,0,0,0);
 }
 if(amount<0.08){return textSample(point);}
 let extent=i32(ceil(3.0*amount));let inverse=0.5/(amount*amount);var total=textSample(point);var weight=1.0;
 for(var i=1;i<=extent;i=i+2){
   let first=exp(-f32(i*i)*inverse);var second=0.0;
   if(i+1<=extent){second=exp(-f32((i+1)*(i+1))*inverse);}
   let combined=first+second;let offset=f32(i)+second/max(combined,1e-20);
   total+=(textSample(point+axis*offset)+textSample(point-axis*offset))*combined;weight+=2.0*combined;
 }
 return total/weight;
}
`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'text local separable filter',
          layout: device.createPipelineLayout({ bindGroupLayouts: [processLayout] }),
          vertex: { module: processShader, entryPoint: 'textLocalVertex' },
          fragment: { module: processShader, entryPoint: 'textLocalFragment', targets: [{ format: 'rgba16float' }] },
          primitive: { topology: 'triangle-list' },
        }),
        value => {
          processPipeline = value;
        },
      );
      packLayout = device.createBindGroupLayout({
        label: 'text run pack resources',
        entries: [
          {
            binding: 0,
            visibility: SS.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 },
          },
          ...[1, 2, 3, 4].map(binding => ({ binding, visibility: SS.FRAGMENT, texture: { sampleType: 'float' } })),
        ],
      });
      const packShader = await checkedModule(
        'text run atlas pack shader',
        fullscreen +
          `
struct TextPack { region:vec4f, extra:vec4f }
@group(0) @binding(0) var<uniform> textPack:TextPack;
@group(0) @binding(1) var textClear:texture_2d<f32>;
@group(0) @binding(2) var textHalo:texture_2d<f32>;
@group(0) @binding(3) var textDry:texture_2d<f32>;
@group(0) @binding(4) var textEntry:texture_2d<f32>;
struct TextPacked { @location(0) steady:vec4f, @location(1) entrance:vec4f }
@fragment fn textPackFragment(@builtin(position) position:vec4f)->TextPacked {
 let point=vec2i(position.xy-textPack.region.xy);var result:TextPacked;
 result.steady=vec4f(textureLoad(textClear,point,0).r,textureLoad(textHalo,point,0).r,textureLoad(textDry,point,0).r,0);
 result.entrance=vec4f(textureLoad(textEntry,point,0).rg,0,0);return result;
}
`,
      );
      compile(
        device.createRenderPipelineAsync({
          label: 'text run atlas packing',
          layout: device.createPipelineLayout({ bindGroupLayouts: [packLayout] }),
          vertex: { module: packShader, entryPoint: 'textLocalVertex' },
          fragment: {
            module: packShader,
            entryPoint: 'textPackFragment',
            targets: [{ format: 'rgba8unorm' }, { format: 'rgba8unorm' }],
          },
          primitive: { topology: 'triangle-list' },
        }),
        value => {
          packPipeline = value;
        },
      );
      await pipelinesReady();
    });
  } catch (error) {
    await Promise.allSettled(pipelineJobs);
    glyphClient?.release();
    for (const resource of [...owned.keys()]) release(resource);
    throw error;
  }

  function packRectangles(rectangles, gutter = 2) {
    const limit = device.limits.maxTextureDimension2D;
    const widest = Math.max(1, ...rectangles.map(r => r.w + gutter * 2));
    const area = rectangles.reduce((sum, r) => sum + (r.w + gutter * 2) * (r.h + gutter * 2), 0);
    let width = Math.min(limit, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(widest, Math.sqrt(area))))));
    if (widest > limit) throw Error('GPU text run exceeds texture dimension limit');
    for (;;) {
      let x = gutter,
        y = gutter,
        rowHeight = 0,
        usedWidth = 1;
      for (const rect of rectangles) {
        if (x + rect.w + gutter > width) {
          x = gutter;
          y += rowHeight + gutter * 2;
          rowHeight = 0;
        }
        rect.atlasX = x;
        rect.atlasY = y;
        x += rect.w + gutter * 2;
        rowHeight = Math.max(rowHeight, rect.h);
        usedWidth = Math.max(usedWidth, x);
      }
      const height = Math.max(1, y + rowHeight + gutter);
      if (height <= limit) return { width: Math.min(width, usedWidth), height };
      if (width >= limit) throw Error('GPU text atlas exceeds texture dimension limit');
      width = Math.min(limit, width * 2);
    }
  }
  function glyphIdentity(spec, text, settings) {
    return JSON.stringify([settings.fontGeneration || 0, spec.font, spec.dpr, spec.direction || 'ltr', text]);
  }
  function getGlyph(spec, text, settings, measure) {
    const key = glyphIdentity(spec, text, settings);
    if (glyphCache.has(key)) return glyphCache.get(key);
    measure.font = spec.font;
    measure.textBaseline = 'alphabetic';
    measure.direction = spec.direction || 'ltr';
    const metrics = measure.measureText(text),
      dpr = spec.dpr;
    const left = -finite(metrics.actualBoundingBoxLeft, 0),
      top = -finite(metrics.actualBoundingBoxAscent, spec.fontSize);
    const right = finite(metrics.actualBoundingBoxRight, metrics.width),
      bottom = finite(metrics.actualBoundingBoxDescent, spec.fontSize * 0.25);
    const w = Math.max(1, Math.ceil((right - left) * dpr) + 4),
      h = Math.max(1, Math.ceil((bottom - top) * dpr) + 4);
    if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D)
      throw Error('GPU text glyph exceeds texture dimension limit');
    const canvas = new OffscreenCanvas(w, h),
      context = canvas.getContext('2d');
    if (!context) throw Error('Canvas2D glyph rasterization is unavailable');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = spec.font;
    context.textBaseline = 'alphabetic';
    context.direction = spec.direction || 'ltr';
    context.fillStyle = '#fff';
    context.fillText(text, 2 / dpr - left, 2 / dpr - top);
    const glyph = { key, canvas, w, h, left: left - 2 / dpr, top: top - 2 / dpr, advance: metrics.width };
    glyphCache.set(key, glyph);
    metadata.glyphRasterizations++;
    return glyph;
  }
  function normalise(specs, settings) {
    const measure = new OffscreenCanvas(1, 1).getContext('2d');
    if (!measure) throw Error('Canvas2D text metrics are unavailable');
    const keys = new Set(),
      glyphs = new Map(),
      runs = [];
    for (const raw of specs) {
      const spec = { ...raw, dpr: finite(raw.dpr, finite(settings.dpr, 1)) };
      if (keys.has(spec.key)) throw Error('Duplicate GPU text run key: ' + spec.key);
      keys.add(spec.key);
      if (
        !(spec.fontSize > 0 && spec.width >= 0 && spec.height > 0 && spec.dpr > 0) ||
        !Number.isFinite(spec.baseline) ||
        !spec.font
      )
        throw Error('Invalid GPU text run metrics: ' + spec.key);
      if (!spec.glyphs) {
        let x = 0;
        spec.glyphs = Array.from(spec.text || '', text => {
          const glyph = getGlyph(spec, text, settings, measure),
            item = { text, x };
          x += glyph.advance + finite(spec.letterSpacing, 0);
          return item;
        });
      }
      const radiusCss = Number(Math.max(0.01, finite(settings.base, 0.085) * spec.fontSize).toFixed(2));
      const sigmaCss = Number(Math.max(0.01, finite(settings.baseSoft, 0.028) * spec.fontSize).toFixed(2));
      const drySigmaCss = spec.fontSize * 0.2;
      const padding = Math.ceil((Math.max(radiusCss + 3 * sigmaCss + 18, 3 * drySigmaCss, 18) + 2) * spec.dpr);
      const run = {
        ...spec,
        padding,
        radius: radiusCss * spec.dpr,
        sigma: sigmaCss * spec.dpr,
        drySigma: drySigmaCss * spec.dpr,
        w: Math.max(1, Math.ceil(spec.width * spec.dpr)) + padding * 2,
        h: Math.max(1, Math.ceil(spec.height * spec.dpr)) + padding * 2,
        glyphs: [],
      };
      if (Math.max(run.radius, run.sigma * 3, run.drySigma * 3, spec.dpr * 18) > 256)
        throw Error('GPU text filter exceeds supported local kernel extent');
      for (const placement of spec.glyphs) {
        const glyph = getGlyph(spec, String(placement.text), settings, measure);
        glyphs.set(glyph.key, glyph);
        run.glyphs.push({ glyph, x: finite(placement.x, 0), y: finite(placement.y, 0) });
      }
      runs.push(run);
    }
    return { runs, glyphs: [...glyphs.values()] };
  }
  async function buildAtlas(specs, settings) {
    alive();
    metadata.preparing = true;
    metadata.prepareCount++;
    const resources = [],
      add = (object, bytes, kind) => {
        resources.push(object);
        return own(object, bytes, kind);
      };
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
      next = await textValidationScope(device, async () => {
        const { runs, glyphs } = prepared || normalise(specs, settings),
          glyphPack = prepared?.glyphPack || packRectangles(glyphs),
          runPack = prepared?.runPack || packRectangles(runs);
        const maxW = prepared?.maxW || Math.max(1, ...runs.map(r => r.w)),
          maxH = prepared?.maxH || Math.max(1, ...runs.map(r => r.h));
        const texture = (label, w, h, format = 'rgba16float', layers = 1, kind = 'temporary') =>
          add(
            device.createTexture({
              label,
              size: [w, h, layers],
              format,
              usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_DST,
            }),
            w * h * layers * (format === 'rgba16float' ? 8 : 4),
            kind,
          );
        const glyphSignature = JSON.stringify(
          glyphs.map(glyph => [glyph.key, glyph.atlasX, glyph.atlasY, glyph.w, glyph.h]),
        );
        const reuseGlyphs = installed?.glyphSignature === glyphSignature;
        const glyphTexture = reuseGlyphs
          ? installed.glyphTexture
          : texture('text cached glyphs', glyphPack.width, glyphPack.height, 'rgba8unorm', 1, 'glyphAtlas');
        if (!reuseGlyphs)
          for (const glyph of glyphs) {
            device.queue.copyExternalImageToTexture(
              { source: glyph.bitmap || glyph.canvas },
              { texture: glyphTexture, origin: [glyph.atlasX, glyph.atlasY], premultipliedAlpha: true },
              [glyph.w, glyph.h],
            );
            if (glyph.bitmap) prepared.closeGlyph(glyph);
            metadata.glyphUploads++;
          }
        prepared?.closeBitmaps?.();
        const atlas = texture('text filtered run atlas', runPack.width, runPack.height, 'rgba8unorm', 2, 'atlas');
        const mask = texture('text local clear mask', maxW, maxH, 'rgba8unorm');
        const a = texture('text local filter A', maxW, maxH),
          b = texture('text local halo', maxW, maxH),
          c = texture('text local dry / combination', maxW, maxH),
          d = texture('text local entry', maxW, maxH);
        const alignment = Math.max(256, device.limits.minUniformBufferOffsetAlignment || 256),
          uniformCount = Math.max(1, runs.length * 12);
        const uniformData = prepared?.uniformData || new Float32Array((uniformCount * alignment) / 4);
        const uniform = add(
          device.createBuffer({
            label: 'text prewarm uniforms',
            size: uniformData.byteLength,
            usage: BU.UNIFORM | BU.COPY_DST,
          }),
          uniformData.byteLength,
          'buffer',
        );
        const glyphCount = runs.reduce((count, run) => count + run.glyphs.length, 0),
          vertices = prepared?.vertices || new Float32Array(Math.max(1, glyphCount) * 8);
        const vertex = add(
          device.createBuffer({
            label: 'text glyph instances',
            size: vertices.byteLength,
            usage: BU.VERTEX | BU.COPY_DST,
          }),
          vertices.byteLength,
          'buffer',
        );
        const views = new Map([mask, a, b, c, d].map(t => [t, t.createView()]));
        const glyphGroup = device.createBindGroup({
          layout: glyphLayout,
          entries: [
            { binding: 0, resource: { buffer: uniform, size: 16 } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: glyphTexture.createView() },
          ],
        });
        const groups = new Map();
        function processGroup(source, other) {
          let inner = groups.get(source);
          if (!inner) {
            inner = new Map();
            groups.set(source, inner);
          }
          if (!inner.has(other))
            inner.set(
              other,
              device.createBindGroup({
                layout: processLayout,
                entries: [
                  { binding: 0, resource: { buffer: uniform, size: 32 } },
                  { binding: 1, resource: sampler },
                  { binding: 2, resource: views.get(source) },
                  { binding: 3, resource: views.get(other) },
                ],
              }),
            );
          return inner.get(other);
        }
        const packGroup = device.createBindGroup({
          layout: packLayout,
          entries: [
            { binding: 0, resource: { buffer: uniform, size: 32 } },
            ...[mask, b, c, d].map((tex, i) => ({ binding: i + 1, resource: views.get(tex) })),
          ],
        });
        const atlasViews = [0, 1].map(baseArrayLayer =>
          atlas.createView({ dimension: '2d', baseArrayLayer, arrayLayerCount: 1 }),
        );
        const encoder = device.createCommandEncoder({ label: 'text run prewarm' });
        let uniformIndex = 0,
          glyphIndex = 0;
        function putUniform(values) {
          const offset = uniformIndex++ * alignment;
          if (!prepared) uniformData.set(values, offset / 4);
          return offset;
        }
        function attachments(view) {
          return [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }];
        }
        function process(run, source, destination, op, amount, other = source) {
          const offset = putUniform([maxW, maxH, run.w, run.h, op, amount, 0, 0]);
          const render = encoder.beginRenderPass({
            label: 'text local filter ' + op,
            colorAttachments: attachments(views.get(destination)),
          });
          render.setViewport(0, 0, run.w, run.h, 0, 1);
          render.setPipeline(processPipeline);
          render.setBindGroup(0, processGroup(source, other), [offset]);
          render.draw(3);
          render.end();
        }
        const clear = encoder.beginRenderPass({
          colorAttachments: atlasViews.map(view => ({
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          })),
        });
        clear.end();
        for (const run of runs) {
          const firstGlyph = glyphIndex;
          if (prepared) glyphIndex += run.glyphs.length;
          else
            for (const placement of run.glyphs) {
              const g = placement.glyph,
                offset = glyphIndex++ * 8;
              vertices.set(
                [
                  run.padding + (placement.x + g.left) * run.dpr,
                  run.padding + (run.baseline + placement.y + g.top) * run.dpr,
                  g.w,
                  g.h,
                  g.atlasX / glyphPack.width,
                  g.atlasY / glyphPack.height,
                  g.w / glyphPack.width,
                  g.h / glyphPack.height,
                ],
                offset,
              );
            }
          const glyphOffset = putUniform([run.w, run.h, 0, 0]);
          const render = encoder.beginRenderPass({
            label: 'text run glyph mask',
            colorAttachments: attachments(views.get(mask)),
          });
          render.setViewport(0, 0, run.w, run.h, 0, 1);
          render.setPipeline(glyphPipeline);
          render.setBindGroup(0, glyphGroup, [glyphOffset]);
          render.setVertexBuffer(0, vertex);
          render.draw(6, run.glyphs.length, 0, firstGlyph);
          render.end();
          process(run, mask, a, 0, run.radius);
          process(run, a, b, 1, run.radius);
          process(run, b, a, 2, run.sigma);
          process(run, a, b, 3, run.sigma);
          process(run, mask, c, 4, 0, b);
          process(run, c, a, 2, 6 * run.dpr);
          process(run, a, d, 3, 6 * run.dpr);
          process(run, mask, a, 2, run.drySigma);
          process(run, a, c, 3, run.drySigma);
          const packOffset = putUniform([run.atlasX, run.atlasY, run.w, run.h, 0, 0, 0, 0]);
          const packed = encoder.beginRenderPass({
            label: 'text store filtered run',
            colorAttachments: atlasViews.map(view => ({ view, loadOp: 'load', storeOp: 'store' })),
          });
          packed.setViewport(run.atlasX, run.atlasY, run.w, run.h, 0, 1);
          packed.setScissorRect(run.atlasX, run.atlasY, run.w, run.h);
          packed.setPipeline(packPipeline);
          packed.setBindGroup(0, packGroup, [packOffset]);
          packed.draw(3);
          packed.end();
        }
        alive();
        device.queue.writeBuffer(uniform, 0, uniformData);
        device.queue.writeBuffer(vertex, 0, vertices);
        prepared?.releaseData?.();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        alive();
        return {
          atlas,
          glyphTexture,
          glyphSignature,
          runs: new Map(runs.map(run => [run.key, run])),
          glyphKeys: new Set(glyphs.map(g => g.key)),
          ...runPack,
          glyphPack,
          glyphCount: glyphs.length,
          view: atlas.createView({ dimension: '2d-array' }),
          settings: { ...settings },
        };
      });
      alive();
      const previous = installed;
      installed = next;
      for (const slot of slots.values()) slot.bindGroup = null;
      metadata.generation++;
      metadata.prepareCompleted++;
      metadata.ready = true;
      metadata.runCount = next.runs.size;
      metadata.glyphCount = next.glyphCount;
      metadata.atlasWidth = next.width;
      metadata.atlasHeight = next.height;
      metadata.atlasBytes = next.width * next.height * 8;
      metadata.glyphAtlasBytes = next.glyphPack.width * next.glyphPack.height * 4;
      for (const [key, glyph] of glyphCache)
        if (!next.glyphKeys.has(key)) {
          glyph.canvas.width = glyph.canvas.height = 1;
          glyphCache.delete(key);
        }
      metadata.cpuGlyphBytes =
        prepared?.cpuGlyphBytes ?? [...glyphCache.values()].reduce((bytes, glyph) => bytes + glyph.w * glyph.h * 4, 0);
      if (previous) {
        release(previous.atlas);
        if (previous.glyphTexture !== next.glyphTexture) release(previous.glyphTexture);
      }
      return {
        generation: metadata.generation,
        runCount: metadata.runCount,
        glyphCount: metadata.glyphCount,
        byteCount: metadata.byteCount,
      };
    } finally {
      prepared?.dispose();
      for (const resource of resources)
        if (resource !== installed?.atlas && resource !== installed?.glyphTexture) release(resource);
      metadata.preparing = false;
      recount();
    }
  }
  function prepare(specs, settings = {}) {
    if (disposed) return Promise.reject(Error('GPU text renderer was disposed'));
    const copy = specs.map(spec => ({ ...spec, glyphs: spec.glyphs?.map(glyph => ({ ...glyph })) }));
    const operation = prepareQueue.then(() => buildAtlas(copy, { ...settings }));
    prepareQueue = operation.catch(() => {});
    return operation;
  }
  function draw(pass, frame) {
    alive();
    if (!installed) throw Error('GPU text draw before its atlas is ready');
    const W = finite(frame.W, frame.viewportCss?.[0]),
      H = finite(frame.H, frame.viewportCss?.[1]);
    if (!(W > 0 && H > 0)) return 0;
    const runs = frame.runs || frame.items || [],
      clip = frame.clip || frame.lineRect || { x: 0, y: 0, width: W, height: H, fadeStart: 0, fadeEnd: 0 };
    const key = frame.drawKey || 'main',
      capacity = Math.max(16, 2 ** Math.ceil(Math.log2(runs.length + 1)));
    let slot = slots.get(key);
    if (!slot || slot.capacity < capacity) {
      if (slot) {
        release(slot.buffer);
        release(slot.uniform);
      }
      slot = {
        capacity,
        data: new Float32Array(capacity * 28),
        buffer: own(
          device.createBuffer({ label: 'text draw instances', size: capacity * 112, usage: BU.VERTEX | BU.COPY_DST }),
          capacity * 112,
          'buffer',
        ),
        uniform: own(
          device.createBuffer({ label: 'text frame uniform', size: 64, usage: BU.UNIFORM | BU.COPY_DST }),
          64,
          'buffer',
        ),
        bindGroup: null,
      };
      slots.set(key, slot);
    }
    const ink = frame.inkColor || [26 / 255, 31 / 255, 27 / 255, 1],
      shift = finite(frame.shiftX, 0);
    let count = 0;
    for (const item of runs) {
      const run = installed.runs.get(item.key),
        opacity = clamp(finite(item.opacity, 1));
      if (!run)
        throw Error('GPU text run is missing from the prepared atlas: ' + String(item.text || item.key).slice(0, 80));
      if (opacity <= 0.0001) continue;
      const scaleX = run.width > 0 ? finite(item.width, run.width) / run.width : 1,
        scaleY = finite(item.height, run.height) / run.height;
      const paddingX = (run.padding / run.dpr) * scaleX,
        paddingY = (run.padding / run.dpr) * scaleY;
      const x = item.x + shift - paddingX,
        y = item.y + finite(item.translateY, 0) - paddingY,
        width = (run.w / run.dpr) * scaleX,
        height = (run.h / run.dpr) * scaleY;
      if (x + width < clip.x || x > clip.x + clip.width || y + height < clip.y || y > clip.y + clip.height) continue;
      const under = item.underline,
        colour = under?.color || [0, 0, 0, 0],
        runInk = item.inkColor || ink;
      const row = count++ * 28;
      slot.data.set(
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
          finite(under?.x, 0) + shift,
          finite(under?.y, 0) + finite(item.translateY, 0),
          Math.max(0, finite(under?.width, 0)),
          Math.max(0, finite(under?.height, 0)),
          colour[0],
          colour[1],
          colour[2],
          finite(colour[3], 1) * clamp(finite(under?.alpha, 1)),
          0,
          0,
          0,
          0,
        ],
        row,
      );
    }
    const caret = frame.caret;
    if (caret && caret.width > 0 && caret.height > 0 && finite(caret.alpha, 1) > 0.0001) {
      const colour = caret.color || ink,
        aa = 1 / finite(frame.dpr, 1),
        row = count++ * 28;
      slot.data.set(
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
        row,
      );
    }
    metadata.instances = count;
    if (!count) return 0;
    const paperGroup = typeof shared.paperBindGroup === 'function' ? shared.paperBindGroup() : shared.paperBindGroup;
    if (!paperGroup) throw Error('GPU text shared paper bind group is unavailable');
    if (!slot.bindGroup)
      slot.bindGroup = device.createBindGroup({
        layout: ownLayout,
        entries: [
          { binding: 0, resource: { buffer: slot.uniform } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: installed.view },
        ],
      });
    device.queue.writeBuffer(slot.buffer, 0, slot.data.buffer, 0, count * 112);
    device.queue.writeBuffer(
      slot.uniform,
      0,
      new Float32Array([
        W,
        H,
        finite(frame.dpr, 1),
        clamp(finite(frame.baseA, 0.95)),
        clip.x,
        clip.y,
        clip.width,
        clip.height,
        finite(clip.fadeStart, 0.03),
        finite(clip.fadeEnd, 0.42),
        clamp(finite(frame.baseLift, 0.12)),
        finite(frame.paperValue, 0),
        frame.groundEnabled === false ? 0 : 1,
        0,
        0,
        0,
      ]),
    );
    pass.setPipeline(drawPipeline);
    pass.setBindGroup(0, slot.bindGroup);
    pass.setBindGroup(1, paperGroup);
    pass.setVertexBuffer(0, slot.buffer);
    pass.draw(6, count);
    return count;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    installed = null;
    glyphClient?.release();
    for (const resource of [...owned.keys()]) release(resource);
    for (const glyph of glyphCache.values()) glyph.canvas.width = glyph.canvas.height = 1;
    glyphCache.clear();
    slots.clear();
    metadata.ready = false;
    metadata.atlasBytes = 0;
    metadata.glyphAtlasBytes = 0;
    metadata.cpuGlyphBytes = 0;
    metadata.runCount = 0;
    metadata.glyphCount = 0;
    recount();
  }
  return {
    prepare,
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

async function textValidationScope(device, operation) {
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
  if (validation) throw Error('WebGPU text validation: ' + validation.message);
  return result;
}
