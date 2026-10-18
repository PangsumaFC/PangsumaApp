(function (root, factory) {
  'use strict';
  const api = factory();
  if (root) root.BoundedHistory = api;
  if (typeof globalThis !== 'undefined') globalThis.BoundedHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : undefined), function () {
  'use strict';

  const configs = {
    submissions: { endpoint: 'submissions', responseKey: 'submissions' },
    cashLedger: { endpoint: 'cash-ledger', responseKey: 'cashLedger' },
    auditEvents: { endpoint: 'audit-events', responseKey: 'auditEvents' }
  };
  const MAX_TRAIL = 200;
  let options = {};
  let generation = 0;
  const busy = new Map();
  const states = new Map();

  const stateFor = collection => {
    if (!states.has(collection)) states.set(collection, {
      trail: [{ cursor: '', pageNumber: 1, nextCursor: null, hasMore: false, total: 0 }],
      index: 0, rows: [], metadata: null
    });
    return states.get(collection);
  };
  const epoch = () => typeof options.getEpoch === 'function' ? options.getEpoch() : undefined;
  const owner = () => {
    const user = typeof options.getUser === 'function' ? options.getUser() : null;
    return user && (user.id ?? user.userId ?? user.email ?? user);
  };
  const allowed = collection => {
    if (collection !== 'cashLedger' && collection !== 'auditEvents') return true;
    const user = typeof options.getUser === 'function' ? options.getUser() : null;
    return user?.role === 'manager';
  };
  const requestRows = (rows, key) => {
    const seen = new Set();
    return rows.filter(row => {
      const id = row && (row.id ?? row._id);
      if (id === undefined || id === null || id === '') return true;
      const marker = String(id);
      if (seen.has(marker)) return false;
      seen.add(marker);
      return true;
    });
  };
  const metadata = (s, rows) => {
    const current = s.trail[s.index];
    return {
      pageNumber: current.pageNumber,
      hasPrevious: s.index > 0,
      canFirst: current.pageNumber > 1,
      hasFirst: current.pageNumber > 1,
      windowCount: rows.length,
      cursorHistoryTruncated: s.trail.length >= MAX_TRAIL && s.trail[0].pageNumber > 1,
      loaded: rows.length,
      total: Number(current.total || 0),
      nextCursor: current.nextCursor || null,
      hasMore: Boolean(current.hasMore),
      busy: busy.has(s.collection)
    };
  };
  const publish = (collection, rows, s) => {
    s.rows = rows;
    s.metadata = metadata(s, rows);
    if (typeof options.setRows === 'function') options.setRows(collection, rows);
    if (typeof options.setPage === 'function') options.setPage(collection, s.metadata);
    if (typeof options.onChange === 'function') options.onChange(collection, rows, s.metadata);
  };
  const setBusy = (collection, value) => {
    if (typeof options.onBusy === 'function') options.onBusy(collection, value);
  };
  const request = async (path, requestOptions) => {
    const result = await options.api(path, requestOptions);
    return result && typeof result.json === 'function' ? result.json() : result;
  };

  function configure(next) {
    options = { ...(next || {}) };
    for (const collection of Object.keys(configs)) {
      const s = stateFor(collection);
      s.collection = collection;
      const suppliedRows = typeof options.getRows === 'function' ? options.getRows(collection) : null;
      const suppliedPage = typeof options.getPage === 'function' ? options.getPage(collection) : null;
      if (Array.isArray(suppliedRows)) s.rows = suppliedRows;
      if (suppliedPage && typeof suppliedPage === 'object') {
        const suppliedNumber = Number(suppliedPage.pageNumber || 1);
        if (s.trail[s.index].pageNumber !== suppliedNumber) {
          s.trail = [{ cursor: '', pageNumber: 1, nextCursor: null, hasMore: false, total: 0 }];
          s.index = 0;
        }
        s.trail[s.index] = { ...s.trail[s.index], nextCursor: suppliedPage.nextCursor || null, hasMore: Boolean(suppliedPage.hasMore), total: Number(suppliedPage.total || 0) };
      }
      s.metadata = metadata(s, s.rows);
    }
    return controller;
  }

  function load(collection, direction = 'next') {
    if (!configs[collection] || !['next', 'previous', 'first', 'refresh'].includes(direction)) return Promise.resolve(undefined);
    if (!options.api || !allowed(collection)) return Promise.resolve(undefined);
    if (busy.has(collection)) return busy.get(collection);
    const s = stateFor(collection);
    s.collection = collection;
    const requestedGeneration = generation;
    const requestedEpoch = epoch();
    const requestedOwner = owner();
    const current = s.trail[s.index];
    let cursor = '';
    let pageNumber = 1;
    let targetIndex = s.index;
    if (direction === 'next') {
      if (!current.hasMore || !current.nextCursor) return Promise.resolve(undefined);
      cursor = String(current.nextCursor);
      pageNumber = current.pageNumber + 1;
    } else if (direction === 'refresh') {
      cursor = current.cursor;
      pageNumber = current.pageNumber;
    } else if (direction === 'previous') {
      if (s.index <= 0) return Promise.resolve(undefined);
      targetIndex = s.index - 1;
      cursor = s.trail[targetIndex].cursor;
      pageNumber = s.trail[targetIndex].pageNumber;
    }
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const requestPromise = (async () => {
      setBusy(collection, true);
      try {
        const result = await request(`/history/${configs[collection].endpoint}${query}`, { signal: typeof AbortController !== 'undefined' ? undefined : undefined });
        const stillCurrent = requestedGeneration === generation && requestedEpoch === epoch() && requestedOwner === owner();
        if (!stillCurrent) return undefined;
        const rows = requestRows(Array.isArray(result?.[configs[collection].responseKey]) ? result[configs[collection].responseKey] : [], collection);
        if (direction === 'first') {
          s.trail = [{ cursor: '', pageNumber: 1, nextCursor: result?.nextCursor || null, hasMore: Boolean(result?.hasMore), total: Number(result?.total || 0) }];
          s.index = 0;
        } else if (direction === 'previous' || direction === 'refresh') {
          s.index = targetIndex;
          s.trail[s.index] = { ...s.trail[s.index], nextCursor: result?.nextCursor || null, hasMore: Boolean(result?.hasMore), total: Number(result?.total || 0) };
        } else {
          s.trail = s.trail.slice(0, s.index + 1);
          s.trail.push({ cursor, pageNumber, nextCursor: result?.nextCursor || null, hasMore: Boolean(result?.hasMore), total: Number(result?.total || 0) });
          s.index++;
          if (s.trail.length > MAX_TRAIL) { s.trail.shift(); s.index--; }
        }
        publish(collection, rows, s);
        return { rows, metadata: s.metadata };
      } catch (error) {
        if (requestedGeneration === generation && requestedEpoch === epoch() && requestedOwner === owner() && typeof options.onError === 'function') options.onError(error, collection);
        return undefined;
      } finally {
        // A reset or a newer request may have replaced this promise. Never let
        // an old response clear the busy state belonging to that newer request.
        if (busy.get(collection) === requestPromise) {
          busy.delete(collection);
          setBusy(collection, false);
        }
      }
    })();
    busy.set(collection, requestPromise);
    return requestPromise;
  }

  function reset() {
    generation++;
    for (const promise of busy.values()) void promise;
    busy.clear();
    states.clear();
    if (typeof options.onBusy === 'function') for (const collection of Object.keys(configs)) options.onBusy(collection, false);
  }

  function controlsMeta(collection) {
    const s = stateFor(collection);
    return s.metadata ? { ...s.metadata, busy: busy.has(collection) } : metadata(s, s.rows);
  }

  const controller = { configure, load, reset, clear: reset, controlsMeta, __teststateCount: () => Math.max(0, ...[...states.values()].map(s => s.trail.length)) };
  return controller;
});
