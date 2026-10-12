globalThis.SITE_DEMO_SCHEDULE = (() => {
  const lead = param('demoLookahead') === '0' ? 0 : 100;
  let session = null,
    activeAt = null;
  const clock = () => performance.now(),
    origin = () => performance.timeOrigin || 0;
  const speed = () => Math.max(0.001, SPEED * TUNE.speed);
  const stopped = gen => gen !== demoGen || (typeof mainStopped === 'boolean' && mainStopped);
  const stats = {
    leadMs: lead,
    events: 0,
    earlyEvents: 0,
    lateEvents: 0,
    maxLateMs: 0,
    preparedEvents: 0,
    cancelledGenerations: 0,
  };
  function check(gen) {
    if (stopped(gen) || session?.generation !== gen) throw STOP;
  }
  function begin(gen) {
    session = { generation: gen, cursor: st.clock, eventId: 0, pending: null, preparing: false, clockShift: 0 };
    activeAt = null;
    comp?.cancelDemoSchedule?.(gen);
  }
  function cancel(gen) {
    session = null;
    activeAt = null;
    stats.cancelledGenerations++;
    comp?.cancelDemoSchedule?.(gen);
  }
  async function pause(ms, gen) {
    check(gen);
    if (!lead) {
      await wait(ms);
      check(gen);
      return;
    }
    session.cursor += ms;
    const remaining = session.cursor - st.clock - lead * speed();
    if (remaining > 0) await wait(remaining);
    check(gen);
  }
  async function event(fn, gen) {
    check(gen);
    if (!lead) {
      fn();
      return;
    }
    const time = clock() + (session.cursor - st.clock) / speed();
    const meta = { generation: gen, eventId: ++session.eventId, scheduledAt: origin() + time };
    session.pending = meta;
    session.preparing = true;
    session.clockShift = time - clock();
    activeAt = time;
    try {
      fn();
    } finally {
      activeAt = null;
    }
    stats.events++;
    const ahead = time - clock();
    if (ahead > 0) stats.earlyEvents++;
    else if (ahead < 0) {
      stats.lateEvents++;
      stats.maxLateMs = Math.max(stats.maxLateMs, -ahead);
    }
    await Promise.all([GPU_LINE.enabled ? GPU_LINE.flush() : null, GPU_UI.enabled ? GPU_UI.flush() : null]);
    check(gen);
    if (typeof comp?.queueDemoEvent !== 'function') throw Error('Scheduled demo transport is unavailable');
    const text = GPU_LINE.enabled ? GPU_LINE.frame(time, Number(springs.track.x.toFixed(2))) : null;
    const ui = GPU_UI.enabled
      ? GPU_UI.frame(time, {
          w: springs.w.x,
          h: springs.h.x,
          vis: springs.vis.x,
          meter: st.meter.x,
          boxD: st.box.D,
          boxT: st.box.t,
          boxP: st.box.p,
        })
      : null;
    comp.queueDemoEvent(meta, text, ui);
    session.preparing = false;
    stats.preparedEvents++;
  }
  function pending() {
    const meta = session?.pending;
    return meta && !stopped(meta.generation) && (session.preparing || meta.scheduledAt > origin() + clock())
      ? meta
      : null;
  }
  const eventNow = () =>
    activeAt ?? (session?.pending && !stopped(session.generation) ? clock() + session.clockShift : clock());
  return { begin, cancel, pause, event, pending, eventNow, snapshot: () => ({ ...stats, pending: pending() }) };
})();
