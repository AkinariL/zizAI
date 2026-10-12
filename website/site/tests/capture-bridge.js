if (SITE_CONFIG.debug && window.__zzTest) {
  window.__zzTestBridge = {
    get initialized() {
      return !!(comp && world.geo && window.__zzTest.fontsLoaded);
    },
    get ready() {
      return !!(comp && world.geo && (OPENING.ready || STATIC !== null));
    },
    get idle() {
      return worldIdle();
    },
    async flush() {
      await comp.captureDrain();
    },
    async stepRender() {
      if (comp.remoteWorker) await comp.captureFrame(window.__zzTest.now, true);
    },
    async finish() {
      await comp.finish?.();
    },
    async prime() {
      const cam = springs.cam.x;
      const f = {
        time: st.time,
        t: st.page.t,
        D: st.page.D,
        veil: st.veil,
        sway: reduceMotion || STILL ? 0 : 0.0022,
        mx: st.mouse[0],
        my: st.mouse[1],
        dpr: dprGL,
        cam,
        view: worldView(cam),
      };
      comp.render(f);
      if (comp.remoteWorker) await comp.captureFrame(window.__zzTest.now, false);
      await comp.finish?.();
      await window.__zzTest.present();
      return {
        renderer: comp.kind,
        valid: comp.valid ?? true,
        virtualTime: window.__zzTest.now,
        time: st.time,
        clock: st.clock,
      };
    },
    async ringHashes() {
      const out = {};
      for (const sc of ['zh', 'ja'])
        for (let li = 0; li < world.geo.length; li++) out[sc + '/' + li] = await comp.ringHash(sc, li);
      return out;
    },
    async ringDiagnostics() {
      const hashes = {},
        stats = {};

      for (const sc of ['zh', 'ja'])
        for (let li = 0; li < world.geo.length; li++) {
          const key = sc + '/' + li,
            g = world.geo[li];
          const bytes = await comp.ringPixels(sc, li);
          hashes[key] = hashBytes(bytes);
          let nonzeroAlphaPixels = 0,
            maxAlpha = 0,
            nonzeroChannelPixels = 0;
          for (let i = 0; i < bytes.length; i += 4) {
            if (bytes[i + 3]) nonzeroAlphaPixels++;
            if (bytes[i] || bytes[i + 1] || bytes[i + 2] || bytes[i + 3]) nonzeroChannelPixels++;
            if (bytes[i + 3] > maxAlpha) maxAlpha = bytes[i + 3];
          }
          stats[key] = {
            width: g.R,
            height: g.Ht,
            bytes: bytes.length,
            nonzeroAlphaPixels,
            nonzeroChannelPixels,
            maxAlpha,
            readbackError: null,
          };
        }
      return { hashes, stats };
    },
    async redraw() {
      if (typeof GPU_LINE !== 'undefined' && typeof GPU_LINE.frame === 'function' && comp.setTextFrame) {
        await GPU_LINE.flush?.();
        const packet = GPU_LINE.frame(performance.now(), Number(springs.track.x.toFixed(2)));
        comp.setTextFrame(packet);
      }
      if (typeof GPU_UI !== 'undefined' && typeof GPU_UI.frame === 'function' && comp.setUIFrame) {
        await GPU_UI.flush?.();
        const packet = GPU_UI.frame(performance.now(), {
          w: springs.w.x,
          h: springs.h.x,
          vis: springs.vis.x,
          meter: st.meter.x,
          boxD: st.box.D,
          boxT: st.box.t,
          boxP: st.box.p,
        });
        comp.setUIFrame(packet);
      }
      if (window.__zzTest.lastFrame) comp.render(window.__zzTest.lastFrame);
      if (comp.remoteWorker) await comp.captureFrame(window.__zzTest.now, false);
      await comp.finish?.();
    },
    lineSnapshot() {
      return typeof GPU_LINE !== 'undefined' && typeof GPU_LINE.debugSnapshot === 'function'
        ? GPU_LINE.debugSnapshot(window.__zzTest.now)
        : null;
    },
    uiSnapshot() {
      return typeof GPU_UI !== 'undefined' && typeof GPU_UI.debugSnapshot === 'function'
        ? GPU_UI.debugSnapshot()
        : null;
    },
    renderEvents() {
      return [
        ...(this.lineSnapshot()?.events || []).map(e => ({ ...e, provider: 'gpu-line-logical-event' })),
        ...(this.uiSnapshot()?.events || []).map(e => ({ ...e, provider: 'gpu-ui-logical-event' })),
      ];
    },
    snapshot(glyphs = false) {
      const rect = el => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const gpuLine = this.lineSnapshot();
      const gpuUI = this.uiSnapshot();
      const gpuUIExpected =
        ['webgpu', 'webgl2'].includes(comp.kind) &&
        typeof GPU_UI !== 'undefined' &&
        param('nogpuui') === null &&
        param('nogputext') === null &&
        param('gpunoparticles') === null;
      const out = {
        virtualTime: window.__zzTest.now,
        motion: {
          cam: springs.cam.x,
          camTarget: st.camT,
          camLead: st.camLead,
          track: springs.track.x,
          boxWidth: springs.w.x,
          boxHeight: springs.h.x,
          boxOpacity: clamp(springs.vis.x, 0, 1),
          boxVis: springs.vis.x,
          pageD: st.page.D,
          pageT: st.page.t,
          boxD: st.box.D,
          boxT: st.box.t,
          meter: st.meter.x,
          clock: st.clock,
          time: st.time,
        },
        text: {
          raw: rawEl.textContent,
          candidates: curList?.textContent || '',
          track: track.textContent,
          verse: [...st.verse],
        },
        opening: { up: OPENING.up, ready: OPENING.ready, lift: window.__zz?.opening?.lift ?? null },
        crops: { line: rect($('line')), candidate: rect(box), slogan: rect(mark) },
        randomCalls: window.__zzTest.randomCalls,
        renderer: comp.kind,
        tiles: {
          pending: comp.uploading || 0,
          workers: comp.meshPending || 0,
          inbox: 0,
          uploading: comp.uploading || 0,
        },
        renderEvents: this.renderEvents().filter(e => Math.abs(e.time - window.__zzTest.now) < 1e-6),
      };
      if (glyphs) {
        out.gpuLine = gpuLine;
        out.gpuUI = gpuUI;
        out.gpuUIExpected = gpuUIExpected;
        out.glyphObservation = {
          trackProvider: gpuLine?.active ? 'submitted-webgpu-state' : 'dom-range',
          failures: [],
        };
        for (const id of ['raw', 'cwrap', 'mark'])
          out.glyphObservation[id + 'Provider'] =
            gpuUIExpected || gpuUI?.active ? 'submitted-webgpu-ui-state' : 'dom-range';
        if (gpuLine?.active && gpuLine.lineRect) out.crops.line = gpuLine.lineRect;
        if (gpuUI?.active)
          for (const name of ['candidate', 'slogan']) if (gpuUI.crops?.[name]) out.crops[name] = gpuUI.crops[name];
        out.glyphs = {};
        for (const id of ['track', 'raw', 'cwrap', 'mark']) {
          const walker = document.createTreeWalker($(id), NodeFilter.SHOW_TEXT);
          let node,
            n = 0;
          while ((node = walker.nextNode())) {
            if (!node.textContent.trim()) continue;
            for (let i = 0; i < node.textContent.length; i++) {
              const key = `${id}/${n}/${i}/${node.textContent[i]}`;
              if (id === 'track' && gpuLine?.active) {
                if (gpuLine.glyphs?.[key]) out.glyphs[key] = gpuLine.glyphs[key];
                else out.glyphObservation.failures.push('Submitted GPU glyph identity is missing: ' + key);
                continue;
              }
              if (id !== 'track' && (gpuUIExpected || gpuUI?.active)) {
                if (gpuUI?.glyphs?.[key]) out.glyphs[key] = gpuUI.glyphs[key];
                else out.glyphObservation.failures.push('Submitted GPU UI glyph identity is missing: ' + key);
                continue;
              }
              const range = document.createRange();
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              const r = range.getBoundingClientRect();
              out.glyphs[key] = { x: r.x, y: r.y, width: r.width, height: r.height };
            }
            n++;
          }
        }
        if (gpuLine?.active)
          for (const key of Object.keys(gpuLine.glyphs || {})) {
            if (!(key in out.glyphs))
              out.glyphObservation.failures.push(
                'Submitted GPU glyph identity is not in the current DOM layout tree: ' + key,
              );
          }
        if (gpuUI?.active)
          for (const key of Object.keys(gpuUI.glyphs || {})) {
            if (!(key in out.glyphs))
              out.glyphObservation.failures.push(
                'Submitted GPU UI glyph identity is not in the current DOM layout tree: ' + key,
              );
          }
      }
      return out;
    },
  };
}
