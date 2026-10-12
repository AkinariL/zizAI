function createUIAtlasHandoff({ destroy, afterSubmit = fn => fn(), changed = () => {} }) {
  let active = null,
    ready = null,
    waiting = null,
    disposed = false,
    promotionQueued = false;
  const future = new Set();
  const error = (message, code = 'UI_ATLAS_PROTOCOL') => Object.assign(Error(message), { code });
  function token(value) {
    const atlasEpoch = value?.atlasEpoch ?? value?.epoch ?? value?._epoch,
      atlasGeneration = value?.atlasGeneration;
    if (
      !Number.isSafeInteger(atlasEpoch) ||
      atlasEpoch < 0 ||
      !Number.isSafeInteger(atlasGeneration) ||
      atlasGeneration < 1
    )
      throw error('UI atlas needs an epoch and a positive generation');
    return { atlasEpoch, atlasGeneration, key: atlasEpoch + '/' + atlasGeneration };
  }
  const find = key => (active?.key === key ? active : ready?.key === key ? ready : null);
  function frameRecord(value) {
    const epoch = value.atlasEpoch ?? value.epoch ?? value._epoch,
      generation = value.atlasGeneration;
    return active?.atlasEpoch === epoch && active.atlasGeneration === generation
      ? active
      : ready?.atlasEpoch === epoch && ready.atlasGeneration === generation
        ? ready
        : null;
  }
  const result = record => ({
    atlasEpoch: record.atlasEpoch,
    atlasGeneration: record.atlasGeneration,
    role: record === active ? 'active' : 'ready',
    prepared: !!record.data,
  });
  const alive = () => {
    if (disposed) throw error('UI atlas owner was disposed', 'UI_ATLAS_OWNER_DISPOSED');
  };
  function drop(record) {
    if (record?.data) {
      destroy(record.data);
      record.data = null;
    }
  }
  function pump() {
    if (disposed || !waiting || ready) return;
    const pending = waiting;
    waiting = null;
    ready = { ...pending.token, state: 'reserved', published: false, data: null, specs: null, settings: null };
    changed();
    pending.resolve(result(ready));
  }
  function settle() {
    if (disposed) return;
    if (active && ready?.data && ready.published && !future.has(active.key) && !promotionQueued) {
      const old = active,
        next = ready;
      promotionQueued = true;
      afterSubmit(() => {
        promotionQueued = false;
        if (disposed) return;
        if (active === old && ready === next && next.published && !future.has(old.key)) {
          active = next;
          ready = null;
          drop(old);
          changed();
        }
        pump();
      });
    }
    pump();
  }
  function acquire(settings) {
    try {
      alive();
      const wanted = token(settings),
        existing = find(wanted.key);
      if (existing) return Promise.resolve(result(existing));
      if (settings.revokeReady) {
        const revoked = token(settings.revokeReady);
        if (
          !ready ||
          ready.key !== revoked.key ||
          ready.published ||
          future.has(revoked.key) ||
          ready.state === 'building'
        )
          throw error('UI ready atlas cannot be revoked after publication or while referenced');
        drop(ready);
        ready = null;
        changed();
      }
      if (waiting) throw error('Only one UI atlas room request may wait', 'UI_ATLAS_BUSY');
      return new Promise((resolve, reject) => {
        waiting = { token: wanted, resolve, reject };
        settle();
      });
    } catch (failure) {
      return Promise.reject(failure);
    }
  }
  function cancel(revokeReady, cancelWaiting = true) {
    alive();
    if (cancelWaiting && waiting) {
      const pending = waiting;
      waiting = null;
      pending.reject(error('UI atlas room request was cancelled', 'UI_ATLAS_CANCELLED'));
      changed();
    }
    if (!revokeReady) return false;
    const revoked = token(revokeReady);
    if (!ready || ready.key !== revoked.key || ready.published || future.has(revoked.key) || ready.state === 'building')
      return false;
    const old = ready;
    ready = null;
    drop(old);
    changed();
    settle();
    return true;
  }
  function begin(specs, settings) {
    alive();
    const wanted = token(settings),
      record = find(wanted.key);
    if (record?.data) return record;
    if (!record || record !== ready || record.state !== 'reserved')
      throw error('UI atlas room must be acquired before prepare', 'UI_ATLAS_ROOM_REQUIRED');
    record.state = 'building';
    record.specs = specs;
    record.settings = { ...settings };
    delete record.settings.revokeReady;
    changed();
    return record;
  }
  function complete(record, data) {
    alive();
    if (record !== ready || record.state !== 'building') throw error('UI atlas build owner changed');
    record.data = data;
    record.state = 'ready';
    if (!active) {
      active = record;
      ready = null;
    }
    changed();
    settle();
    return result(record);
  }
  function fail(record) {
    if (ready === record) {
      drop(ready);
      ready = null;
      changed();
      pump();
    }
  }
  function publish(frame) {
    if (!frame) return;
    alive();
    const record = frameRecord(frame);
    if (!record?.data) throw error('Published UI atlas is not prepared');
    if (record.published) return;
    record.published = true;
    changed();
  }
  function references(frames, project) {
    alive();
    future.clear();
    for (const value of frames) {
      const frame = project ? project(value) : value;
      if (frame) {
        const record = frameRecord(frame);
        if (!record?.data) throw error('Future UI frame has no atlas');
        future.add(record.key);
      }
    }
    settle();
  }
  function select(frame) {
    alive();
    const record = frameRecord(frame);
    if (!record?.data) throw error('UI frame has no matching atlas');
    return record;
  }
  function snapshot() {
    return [active, ready]
      .filter(record => record?.specs)
      .map(record => ({
        role: record === active ? 'active' : 'ready',
        atlasEpoch: record.atlasEpoch,
        atlasGeneration: record.atlasGeneration,
        published: record.published,
        specs: record.specs,
        settings: { ...record.settings },
      }));
  }
  function restorePublication(record, published) {
    record.published = published === true;
    changed();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    waiting?.reject(error('UI atlas owner was disposed', 'UI_ATLAS_OWNER_DISPOSED'));
    waiting = null;
    drop(active);
    drop(ready);
    active = ready = null;
    future.clear();
    changed();
  }
  return {
    acquire,
    cancel,
    begin,
    complete,
    fail,
    publish,
    references,
    select,
    snapshot,
    restorePublication,
    dispose,
    result,
    get active() {
      return active;
    },
    get ready() {
      return ready;
    },
    inspect() {
      return {
        activeAtlasEpoch: active?.atlasEpoch ?? null,
        activeAtlasGeneration: active?.atlasGeneration ?? null,
        readyAtlasEpoch: ready?.atlasEpoch ?? null,
        readyAtlasGeneration: ready?.atlasGeneration ?? null,
        ownedAtlasCount: Number(!!active) + Number(!!ready),
        waitingForAtlasRoom: !!waiting,
      };
    },
  };
}
