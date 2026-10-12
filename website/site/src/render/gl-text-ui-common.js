const GLTextUICommon = (() => {
  const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
  const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  const fullscreenVAOs = new WeakMap();
  const trackedStates = new WeakMap();
  const textureLimits = new WeakMap();
  const different4 = (a, b) => a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];
  function maxTextureSize(gl) {
    if (!textureLimits.has(gl)) textureLimits.set(gl, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    return textureLimits.get(gl);
  }
  const canvas = (width, height) => {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    const node = document.createElement('canvas');
    node.width = width;
    node.height = height;
    return node;
  };
  function shader(gl, type, source, label) {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(value) || 'unknown shader error';
      gl.deleteShader(value);
      throw Error(`${label}: ${message}`);
    }
    return value;
  }
  function program(gl, vertexSource, fragmentSource, label) {
    const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource, label + ' vertex');
    const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource, label + ' fragment');
    const result = gl.createProgram();
    gl.attachShader(result, vertex);
    gl.attachShader(result, fragment);
    gl.linkProgram(result);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(result) || 'unknown link error';
      gl.deleteProgram(result);
      throw Error(`${label}: ${message}`);
    }
    return result;
  }
  function texture(gl, width, height, data = null, label = 'WebGL2 retained atlas') {
    const value = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, value);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    value.width = width;
    value.height = height;
    value.label = label;
    return value;
  }
  function upload(gl, value, width, height, data) {
    gl.bindTexture(gl.TEXTURE_2D, value);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    value.width = width;
    value.height = height;
  }
  function framebuffer(gl, value) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, value, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      throw Error('WebGL2 RGBA8 framebuffer is incomplete: ' + status);
    }
    return fbo;
  }
  function resizeTexture(gl, resource, width, height, label) {
    if (resource && resource.texture.width === width && resource.texture.height === height) return resource;
    if (resource) {
      gl.deleteFramebuffer(resource.fbo);
      gl.deleteTexture(resource.texture);
    }
    const value = texture(gl, width, height, null, label);
    return { texture: value, fbo: framebuffer(gl, value), width, height };
  }
  function locations(gl, programValue, names) {
    return glUniformLocations(gl, programValue, names);
  }
  function set1f(gl, location, value) {
    if (location !== null && location !== undefined) gl.uniform1f(location, value);
  }
  function set2f(gl, location, x, y) {
    if (location !== null && location !== undefined) gl.uniform2f(location, x, y);
  }
  function set4f(gl, location, x, y, z, w) {
    if (location !== null && location !== undefined) gl.uniform4f(location, x, y, z, w);
  }
  function set4fv(gl, location, value) {
    if (location !== null && location !== undefined) gl.uniform4fv(location, value);
  }
  function set3fv(gl, location, value) {
    if (location !== null && location !== undefined) gl.uniform3fv(location, value);
  }
  function textureUnit(gl, programValue, name, unit, value) {
    if (!value) return;
    const location = glUniformLocation(gl, programValue, name);
    if (location !== null) gl.uniform1i(location, unit);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, value);
  }
  function fullScreenProgram(gl, fragment, label) {
    const vertex = `#version 300 es
precision highp float;
out vec2 vUv;
void main(){ vec2 p=gl_VertexID==0?vec2(-1.0,-1.0):(gl_VertexID==1?vec2(3.0,-1.0):vec2(-1.0,3.0)); vUv=p*.5+.5; gl_Position=vec4(p,0.0,1.0); }`;
    return program(gl, vertex, fragment, label);
  }
  function beginState(gl) {
    const retained = trackedStates.get(gl);
    if (retained)
      return {
        ...retained,
        viewport: retained.viewport.slice(),
        textures: retained.textures.slice(),
        colorMask: retained.colorMask.slice(),
        scissorBox: retained.scissorBox.slice(),
      };
    const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE),
      textures = [];
    for (let unit = 0; unit < 14; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      textures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
    }
    gl.activeTexture(activeTexture);
    return {
      framebuffer: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT),
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      activeTexture,
      textures,
      blend: gl.isEnabled(gl.BLEND),
      depth: gl.isEnabled(gl.DEPTH_TEST),
      cull: gl.isEnabled(gl.CULL_FACE),
      stencil: gl.isEnabled(gl.STENCIL_TEST),
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
      blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
      blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
      blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
      blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
      blendEqRGB: gl.getParameter(gl.BLEND_EQUATION_RGB),
      blendEqAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
      scissor: gl.isEnabled(gl.SCISSOR_TEST),
      scissorBox: gl.getParameter(gl.SCISSOR_BOX),
      unpackFlipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
      unpackPremultiply: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
      unpackAlignment: gl.getParameter(gl.UNPACK_ALIGNMENT),
    };
  }
  function trackState(gl) {
    if (trackedStates.has(gl)) return;
    const state = beginState(gl);
    trackedStates.set(gl, state);
    const wrap = (name, record) => {
      const original = gl[name];
      gl[name] = function (...args) {
        const result = original.apply(this, args);
        record(...args);
        return result;
      };
    };
    wrap('bindFramebuffer', (target, value) => {
      if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) state.framebuffer = value;
      if (target === gl.FRAMEBUFFER || target === gl.READ_FRAMEBUFFER) state.readFramebuffer = value;
    });
    wrap('viewport', (...values) => {
      state.viewport = values;
    });
    wrap('useProgram', value => {
      state.program = value;
    });
    wrap('bindVertexArray', value => {
      state.vao = value;
    });
    wrap('bindBuffer', (target, value) => {
      if (target === gl.ARRAY_BUFFER) state.arrayBuffer = value;
    });
    wrap('activeTexture', value => {
      state.activeTexture = value;
    });
    wrap('bindTexture', (target, value) => {
      if (target === gl.TEXTURE_2D) state.textures[state.activeTexture - gl.TEXTURE0] = value;
    });
    const flags = new Map([
      [gl.BLEND, 'blend'],
      [gl.DEPTH_TEST, 'depth'],
      [gl.CULL_FACE, 'cull'],
      [gl.STENCIL_TEST, 'stencil'],
      [gl.SCISSOR_TEST, 'scissor'],
    ]);
    wrap('enable', value => {
      const key = flags.get(value);
      if (key) state[key] = true;
    });
    wrap('disable', value => {
      const key = flags.get(value);
      if (key) state[key] = false;
    });
    wrap('colorMask', (...values) => {
      state.colorMask = values;
    });
    const blendFunc = (srcRGB, dstRGB, srcAlpha, dstAlpha) => {
      Object.assign(state, {
        blendSrcRGB: srcRGB,
        blendDstRGB: dstRGB,
        blendSrcAlpha: srcAlpha,
        blendDstAlpha: dstAlpha,
      });
    };
    wrap('blendFuncSeparate', blendFunc);
    wrap('blendFunc', (src, dst) => {
      blendFunc(src, dst, src, dst);
    });
    wrap('blendEquationSeparate', (rgb, alpha) => {
      state.blendEqRGB = rgb;
      state.blendEqAlpha = alpha;
    });
    wrap('blendEquation', value => {
      state.blendEqRGB = state.blendEqAlpha = value;
    });
    wrap('scissor', (...values) => {
      state.scissorBox = values;
    });
    wrap('pixelStorei', (name, value) => {
      if (name === gl.UNPACK_FLIP_Y_WEBGL) state.unpackFlipY = !!value;
      else if (name === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) state.unpackPremultiply = !!value;
      else if (name === gl.UNPACK_ALIGNMENT) state.unpackAlignment = value;
    });
    wrap('deleteTexture', value => {
      for (let unit = 0; unit < state.textures.length; unit++)
        if (state.textures[unit] === value) state.textures[unit] = null;
    });
    wrap('deleteFramebuffer', value => {
      if (state.framebuffer === value) state.framebuffer = null;
      if (state.readFramebuffer === value) state.readFramebuffer = null;
    });
    wrap('deleteBuffer', value => {
      if (state.arrayBuffer === value) state.arrayBuffer = null;
    });
    wrap('deleteVertexArray', value => {
      if (state.vao === value) state.vao = null;
    });
  }
  function endState(gl, state) {
    const current = trackedStates.get(gl);
    if (current) {
      if (current.framebuffer !== state.framebuffer) gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.framebuffer);
      if (current.readFramebuffer !== state.readFramebuffer)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
      if (different4(current.viewport, state.viewport)) gl.viewport(...state.viewport);
      if (current.program !== state.program) gl.useProgram(state.program);
      if (current.vao !== state.vao) gl.bindVertexArray(state.vao);
      if (current.arrayBuffer !== state.arrayBuffer) gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
      for (let unit = 0; unit < state.textures.length; unit++) {
        if (current.textures[unit] === state.textures[unit]) continue;
        if (current.activeTexture !== gl.TEXTURE0 + unit) gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, state.textures[unit]);
      }
      if (current.activeTexture !== state.activeTexture) gl.activeTexture(state.activeTexture);
      if (current.blend !== state.blend) {
        if (state.blend) gl.enable(gl.BLEND);
        else gl.disable(gl.BLEND);
      }
      if (current.scissor !== state.scissor) {
        if (state.scissor) gl.enable(gl.SCISSOR_TEST);
        else gl.disable(gl.SCISSOR_TEST);
      }
      if (current.depth !== state.depth) {
        if (state.depth) gl.enable(gl.DEPTH_TEST);
        else gl.disable(gl.DEPTH_TEST);
      }
      if (current.cull !== state.cull) {
        if (state.cull) gl.enable(gl.CULL_FACE);
        else gl.disable(gl.CULL_FACE);
      }
      if (current.stencil !== state.stencil) {
        if (state.stencil) gl.enable(gl.STENCIL_TEST);
        else gl.disable(gl.STENCIL_TEST);
      }
      if (
        current.blendSrcRGB !== state.blendSrcRGB ||
        current.blendDstRGB !== state.blendDstRGB ||
        current.blendSrcAlpha !== state.blendSrcAlpha ||
        current.blendDstAlpha !== state.blendDstAlpha
      )
        gl.blendFuncSeparate(state.blendSrcRGB, state.blendDstRGB, state.blendSrcAlpha, state.blendDstAlpha);
      if (current.blendEqRGB !== state.blendEqRGB || current.blendEqAlpha !== state.blendEqAlpha)
        gl.blendEquationSeparate(state.blendEqRGB, state.blendEqAlpha);
      if (different4(current.colorMask, state.colorMask)) gl.colorMask(...state.colorMask);
      if (different4(current.scissorBox, state.scissorBox)) gl.scissor(...state.scissorBox);
      if (current.unpackFlipY !== state.unpackFlipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, state.unpackFlipY);
      if (current.unpackPremultiply !== state.unpackPremultiply)
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, state.unpackPremultiply);
      if (current.unpackAlignment !== state.unpackAlignment) gl.pixelStorei(gl.UNPACK_ALIGNMENT, state.unpackAlignment);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
    gl.viewport(...state.viewport);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
    gl.useProgram(state.program);
    gl.bindVertexArray(state.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
    gl.activeTexture(state.activeTexture);
    for (let unit = 0; unit < state.textures.length; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, state.textures[unit]);
    }
    gl.activeTexture(state.activeTexture);
    if (state.blend) gl.enable(gl.BLEND);
    else gl.disable(gl.BLEND);
    gl.blendFuncSeparate(state.blendSrcRGB, state.blendDstRGB, state.blendSrcAlpha, state.blendDstAlpha);
    gl.blendEquationSeparate(state.blendEqRGB, state.blendEqAlpha);
    if (state.scissor) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    if (state.depth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (state.cull) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);
    if (state.stencil) gl.enable(gl.STENCIL_TEST);
    else gl.disable(gl.STENCIL_TEST);
    gl.colorMask(...state.colorMask);
    gl.scissor(...state.scissorBox);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, state.unpackFlipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, state.unpackPremultiply);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, state.unpackAlignment);
  }
  function prepare2D(gl) {
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
  }
  function vao(gl, strideFloats = 28) {
    const value = gl.createVertexArray(),
      buffer = gl.createBuffer();
    gl.bindVertexArray(value);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let i = 0; i < 7; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, strideFloats * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    return { vao: value, buffer, capacity: 0 };
  }
  function drawInstances(gl, slot, values, count) {
    if (!count) return 0;
    const floats = count * 28;
    if (slot.capacity < floats) {
      slot.capacity = Math.max(floats, Math.max(16, slot.capacity * 2));
      gl.bindBuffer(gl.ARRAY_BUFFER, slot.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, slot.capacity * 4, gl.DYNAMIC_DRAW);
    }
    gl.bindVertexArray(slot.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, values.subarray ? values.subarray(0, floats) : values);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    return count;
  }
  function instanceData(slot, floats) {
    if (!slot.data || slot.data.length < floats)
      slot.data = new Float32Array(Math.max(16 * 28, floats, (slot.data?.length || 0) * 2));
    return slot.data;
  }
  function usePremultipliedBlend(gl, enabled = true) {
    if (enabled) {
      gl.enable(gl.BLEND);
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
  }
  function bindTarget(gl, target, width, height) {
    const fbo = target?.fbo ?? target?.framebuffer ?? target ?? null;
    const w = Math.max(1, target?.width || width || 1),
      h = Math.max(1, target?.height || height || 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    prepare2D(gl);
    return { fbo, width: w, height: h };
  }
  function bindPaper(gl, programValue, shared, frame, locations = null) {
    const binder = shared?.bindPaperUniforms || shared?.paperUniforms;
    if (typeof binder === 'function') {
      binder(gl, programValue, frame, locations);
      return;
    }
    const values = typeof shared?.getPaperUniforms === 'function' ? shared.getPaperUniforms(frame) : binder;
    if (!values || typeof values !== 'object') return;
    for (const [name, value] of Object.entries(values)) {
      if (name === 'textures') {
        for (const [index, item] of value.entries())
          textureUnit(gl, programValue, item.name, item.unit ?? 8 + index, item.texture);
        continue;
      }
      if (name === 'uMtn' || name === 'uPN') {
        const textureValue = value?.texture || value;
        textureUnit(gl, programValue, name, value?.unit ?? (name === 'uMtn' ? 8 : 9), textureValue);
        continue;
      }
      const location = glUniformLocation(gl, programValue, name);
      if (location === null || value == null) continue;
      if (typeof value === 'number') gl.uniform1f(location, value);
      else if (value.length === 2) gl.uniform2fv(location, value);
      else if (value.length === 3) gl.uniform3fv(location, value);
      else if (value.length === 4) gl.uniform4fv(location, value);
      else if (value.length === 9) gl.uniformMatrix3fv(location, false, value);
      else if (value.length === 16) gl.uniformMatrix4fv(location, false, value);
    }
  }
  function canvasPixels(source, width, height) {
    const copy = canvas(width, height),
      ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, width, height);
    if (source) ctx.drawImage(source, 0, 0, width, height);
    return { canvas: copy, context: ctx, pixels: ctx.getImageData(0, 0, width, height) };
  }
  function blurredAlpha(alpha, width, height, sigma) {
    if (!(sigma > 0.08)) return alpha.slice();
    const src = canvas(width, height),
      sc = src.getContext('2d', { willReadFrequently: true }),
      image = sc.createImageData(width, height);
    for (let i = 0; i < alpha.length; i++) {
      const p = i * 4;
      image.data[p] = image.data[p + 1] = image.data[p + 2] = 255;
      image.data[p + 3] = alpha[i];
    }
    sc.putImageData(image, 0, 0);
    const dst = canvas(width, height),
      dc = dst.getContext('2d', { willReadFrequently: true });
    dc.clearRect(0, 0, width, height);
    dc.filter = `blur(${sigma}px)`;
    dc.drawImage(src, 0, 0);
    dc.filter = 'none';
    const data = dc.getImageData(0, 0, width, height).data,
      result = new Uint8Array(width * height);
    for (let i = 0; i < result.length; i++) result[i] = data[i * 4 + 3];
    src.width = src.height = dst.width = dst.height = 1;
    return result;
  }
  function dilateAlpha(alpha, width, height, radius) {
    if (!(radius > 0.08)) return alpha.slice();
    const extent = Math.ceil(radius),
      horizontal = new Uint8Array(alpha.length),
      output = new Uint8Array(alpha.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let max = 0;
        for (let dx = -extent; dx <= extent; dx++)
          max = Math.max(
            max,
            alpha[
              y * width + Math.max(0, Math.min(width - 1, x + Math.round(Math.max(-radius, Math.min(radius, dx)))))
            ],
          );
        horizontal[y * width + x] = max;
      }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let max = 0;
        for (let dy = -extent; dy <= extent; dy++)
          max = Math.max(
            max,
            horizontal[
              Math.max(0, Math.min(height - 1, y + Math.round(Math.max(-radius, Math.min(radius, dy))))) * width + x
            ],
          );
        output[y * width + x] = max;
      }
    return output;
  }
  function setImageSource(image, source, width, height) {
    image.data.fill(0);
    const temp = canvas(width, height),
      ctx = temp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, width, height);
    const src = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < width * height; i++) {
      const p = i * 4,
        a = src[p + 3];
      image.data[p] = image.data[p + 1] = image.data[p + 2] = 255;
      image.data[p + 3] = a;
    }
    temp.width = temp.height = 1;
  }
  function textureFromCanvas(gl, source, label) {
    const value = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, value);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    value.width = source.width;
    value.height = source.height;
    value.label = label;
    return value;
  }
  function fullScreenQuad(gl, fbo, width, height, programValue, uniforms, textures = []) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(programValue);
    prepare2D(gl);
    gl.disable(gl.BLEND);
    let screenVao = fullscreenVAOs.get(gl);
    if (!screenVao) {
      screenVao = gl.createVertexArray();
      fullscreenVAOs.set(gl, screenVao);
    }
    gl.bindVertexArray(screenVao);
    for (const [name, unit, value] of textures) textureUnit(gl, programValue, name, unit, value);
    if (uniforms)
      for (const [name, value] of Object.entries(uniforms)) {
        const loc = glUniformLocation(gl, programValue, name);
        if (loc === null) continue;
        if (typeof value === 'number') gl.uniform1f(loc, value);
        else if (value.length === 2) gl.uniform2fv(loc, value);
        else if (value.length === 4) gl.uniform4fv(loc, value);
      }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function dropTexture(gl, value) {
    if (value) gl.deleteTexture(value);
  }
  function dropSlot(gl, value) {
    if (!value) return;
    gl.deleteBuffer(value.buffer);
    gl.deleteVertexArray(value.vao);
    value.data = null;
  }
  function dropFramebuffer(gl, value) {
    if (!value) return;
    gl.deleteFramebuffer(value.fbo);
    gl.deleteTexture(value.texture);
  }
  function statsForTextures(entries) {
    return entries.reduce((bytes, value) => bytes + (value?.width || 0) * (value?.height || 0) * 4, 0);
  }
  return {
    clamp,
    finite,
    canvas,
    shader,
    program,
    texture,
    upload,
    framebuffer,
    resizeTexture,
    locations,
    set1f,
    set2f,
    set4f,
    set4fv,
    set3fv,
    textureUnit,
    fullScreenProgram,
    maxTextureSize,
    trackState,
    beginState,
    endState,
    vao,
    drawInstances,
    instanceData,
    usePremultipliedBlend,
    bindTarget,
    bindPaper,
    prepare2D,
    canvasPixels,
    blurredAlpha,
    dilateAlpha,
    setImageSource,
    textureFromCanvas,
    fullScreenQuad,
    dropTexture,
    dropSlot,
    dropFramebuffer,
    statsForTextures,
  };
})();
