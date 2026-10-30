/**
 * Zone Mileage - D1 sync layer.
 *
 * localStorage stays the fast local cache. Every ledger write is mirrored to
 * /api/ledger with a short debounce, and the D1 copy is pulled when the page
 * opens, regains focus, or becomes visible again.
 *
 * If the Pages Function or the D1 binding is missing, the site keeps working
 * from localStorage and the masthead reports "Local only".
 *
 * Interface with the views:
 *   - localStorage key "mileage-receipt.v1" is the single ledger
 *   - mileageTable.reload()  re-reads the ledger into the table view
 *   - mileageReceipt.syncView() re-reads the ledger into the receipt view
 *   - mileageReceipt.notify() shows the shared toast
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'mileage-receipt.v1';
  const DIRTY_KEY = 'mileage-receipt.cloud-dirty.v1';
  const API_URL = '/api/ledger';
  const SAVE_DELAY = 500;
  const RETRY_DELAY = 15000;
  const POLL_MS = 20000;
  const FETCH_TIMEOUT = 4000;
  const MAX_PAYLOAD_BYTES = 500000;

  const nativeSetItem = Storage.prototype.setItem;
  const nativeGetItem = Storage.prototype.getItem;

  let booting = true;
  let booted = false;
  let initializing = false;
  let apiPresent = null; // true | false | unknown
  let mode = 'local'; // 'd1' | 'local'
  let version = 0;
  let updatedAt = 0;
  let lastPushed = '';
  let pendingRaw = '';
  let saveTimer = 0;
  let retryTimer = 0;
  let pushing = false;
  let refreshing = false;
  let applyingRemote = false;

  let statusState = 'checking';
  let statusLabel = 'Checking';
  let statusNote = 'Looking for the D1 ledger.';
  let statusEl = null;
  let statusTextEl = null;
  let persistNoteEl = null;

  function isValidLedger(data) {
    return Boolean(
      data
      && typeof data === 'object'
      && !Array.isArray(data)
      && Array.isArray(data.vehicles)
      && Array.isArray(data.entries)
    );
  }

  function parseLedger(raw) {
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return isValidLedger(data) ? data : null;
    } catch {
      return null;
    }
  }

  function readLocal() {
    try {
      return nativeGetItem.call(window.localStorage, STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function writeLocal(raw) {
    nativeSetItem.call(window.localStorage, STORAGE_KEY, raw);
  }

  function readDirty() {
    try {
      return nativeGetItem.call(window.localStorage, DIRTY_KEY) === '1';
    } catch {
      return false;
    }
  }

  function markDirty(dirty) {
    try {
      if (dirty) {
        nativeSetItem.call(window.localStorage, DIRTY_KEY, '1');
      } else if (nativeGetItem.call(window.localStorage, DIRTY_KEY) !== null) {
        window.localStorage.removeItem(DIRTY_KEY);
      }
    } catch {
      /* A full storage quota should not break syncing. */
    }
  }

  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    window.setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  function isApiResponse(response) {
    return (response.headers.get('x-zone-mileage-api') || '').startsWith('ledger/');
  }

  function paintStatus() {
    if (!statusEl) {
      statusEl = document.getElementById('cloudStatus');
      statusTextEl = document.getElementById('cloudStatusText');
    }
    if (!persistNoteEl) persistNoteEl = document.getElementById('persistNote');

    if (statusEl) {
      statusEl.dataset.state = statusState;
      statusEl.title = statusNote;
      statusEl.setAttribute('aria-label', `D1 sync: ${statusLabel}. ${statusNote}`);
    }
    if (statusTextEl) statusTextEl.textContent = statusLabel;
    if (persistNoteEl) {
      persistNoteEl.textContent = mode === 'd1'
        ? 'Saved in this browser + D1'
        : 'Saved in this browser';
    }
  }

  function setStatus(state, label, note) {
    statusState = state;
    statusLabel = label;
    statusNote = note || label;
    paintStatus();
  }

  function isEditing() {
    if (document.querySelector('[data-cell-editor], [data-draft-editor]')) return true;
    const active = document.activeElement;
    return Boolean(active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName));
  }

  function applyRemote(serialized, nextVersion, nextUpdatedAt, notify) {
    applyingRemote = true;
    try {
      if (readLocal() !== serialized) writeLocal(serialized);
      version = nextVersion;
      updatedAt = nextUpdatedAt;
      lastPushed = serialized;
      markDirty(false);

      if (window.mileageTable && typeof window.mileageTable.reload === 'function') {
        window.mileageTable.reload();
      }
      if (window.mileageReceipt && typeof window.mileageReceipt.syncView === 'function') {
        window.mileageReceipt.syncView();
      }
    } finally {
      applyingRemote = false;
    }

    setStatus('synced', 'D1 synced', 'Ledger is up to date with D1.');

    if (notify && window.mileageReceipt && typeof window.mileageReceipt.notify === 'function') {
      window.mileageReceipt.notify('Ledger updated from D1.');
    }
  }

  async function send(raw, keepalive) {
    const data = parseLedger(raw);
    if (!data) return { ok: false, message: 'The local ledger is not valid JSON.' };

    const payload = JSON.stringify(data);
    if (payload.length > MAX_PAYLOAD_BYTES) {
      return { ok: false, message: 'The ledger is larger than the 500 KB D1 limit.' };
    }

    try {
      const response = await fetch(API_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ data }),
        cache: 'no-store',
        keepalive: Boolean(keepalive),
        signal: timeoutSignal(10000),
      });

      if (!isApiResponse(response)) {
        return { ok: false, message: 'The D1 API is not deployed on this host.' };
      }

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          message: (body && body.error) || `D1 returned HTTP ${response.status}.`,
        };
      }

      version = Number(body && body.version) || version + 1;
      updatedAt = Number(body && body.updatedAt) || Date.now();
      lastPushed = payload;
      return { ok: true };
    } catch {
      return { ok: false, message: 'Could not reach D1. Changes are still in this browser.' };
    }
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
  }

  function scheduleRetry() {
    clearRetry();
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      if (mode === 'd1') push();
    }, RETRY_DELAY);
  }

  function queuePush(raw) {
    if (mode !== 'd1' || booting || !raw) return;
    const data = parseLedger(raw);
    if (!data) return;

    clearRetry();
    pendingRaw = JSON.stringify(data);
    markDirty(true);

    if (pushing) return;

    clearTimeout(saveTimer);
    setStatus('saving', 'Saving', 'Saving to D1...');
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      push();
    }, SAVE_DELAY);
  }

  async function push() {
    if (mode !== 'd1' || pushing) return;

    const raw = pendingRaw || readLocal();
    pendingRaw = '';
    if (!raw) {
      setStatus('synced', 'D1 synced', 'Ledger is up to date with D1.');
      return;
    }

    const data = parseLedger(raw);
    if (!data) return;

    const payload = JSON.stringify(data);
    if (payload === lastPushed) {
      markDirty(false);
      setStatus('synced', 'D1 synced', 'Ledger is up to date with D1.');
      return;
    }

    pushing = true;
    setStatus('saving', 'Saving', 'Saving to D1...');

    const result = await send(payload);
    pushing = false;

    if (result.ok) {
      const current = readLocal();
      const currentData = parseLedger(current);
      if (!pendingRaw && (!currentData || JSON.stringify(currentData) === lastPushed)) {
        markDirty(false);
      }
      setStatus('synced', 'D1 synced', 'Saved to D1.');
    } else {
      setStatus('offline', 'D1 offline', result.message || 'D1 save failed; changes stay in this browser.');
      scheduleRetry();
    }

    if (pendingRaw) {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = 0;
        push();
      }, 250);
    }
  }

  function flushPending() {
    if (mode !== 'd1' || booting) return;
    const current = readLocal();
    const data = parseLedger(current);
    if (!data) return;
    const serialized = JSON.stringify(data);
    if (serialized !== lastPushed) queuePush(serialized);
  }

  function pushKeepalive() {
    if (mode !== 'd1' || booting || pushing) return;
    const raw = pendingRaw || readLocal();
    const data = parseLedger(raw);
    if (!data) return;
    const payload = JSON.stringify(data);
    if (payload === lastPushed) return;
    send(payload, true);
  }

  async function refreshFromD1() {
    if (mode !== 'd1' || booting || pushing || refreshing) return;
    if (saveTimer || retryTimer) return;
    if (readDirty()) return;
    if (document.visibilityState === 'hidden') return;
    if (isEditing()) return;

    refreshing = true;
    try {
      const response = await fetch(API_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: timeoutSignal(FETCH_TIMEOUT),
      });

      if (!isApiResponse(response) || response.status === 404 || !response.ok) return;

      const body = await response.json().catch(() => null);
      if (!isValidLedger(body && body.data)) return;

      const nextVersion = Number(body.version) || 0;
      if (nextVersion <= version) return;

      const serialized = JSON.stringify(body.data);
      if (serialized === readLocal()) {
        version = nextVersion;
        updatedAt = Number(body.updatedAt) || updatedAt;
        setStatus('synced', 'D1 synced', 'Ledger is up to date with D1.');
        return;
      }

      applyRemote(serialized, nextVersion, Number(body.updatedAt) || 0, true);
    } catch {
      /* Keep the current local view; the next poll will retry. */
    } finally {
      refreshing = false;
    }
  }

  function finishBoot() {
    initializing = false;
    booting = false;
    booted = true;
    paintStatus();

    if (mode === 'd1') {
      const current = readLocal();
      const data = parseLedger(current);
      if (data) {
        const serialized = JSON.stringify(data);
        if (serialized !== lastPushed) queuePush(serialized);
      }
    }
  }

  async function initialLoad() {
    if (initializing) return;
    initializing = true;

    const localRaw = readLocal();
    const localData = parseLedger(localRaw);
    const localDirty = readDirty();

    setStatus('checking', 'Checking', 'Looking for the D1 ledger.');

    let response;
    try {
      response = await fetch(API_URL, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: timeoutSignal(FETCH_TIMEOUT),
      });
    } catch {
      mode = 'local';
      setStatus('local', 'Local only', 'D1 is unreachable, so the page is using local storage.');
      finishBoot();
      return;
    }

    if (!isApiResponse(response)) {
      apiPresent = false;
      mode = 'local';
      setStatus('local', 'Local only', 'This host has no D1 API. Data stays in this browser.');
      finishBoot();
      return;
    }

    apiPresent = true;

    if (response.status === 404) {
      mode = 'd1';

      if (localData) {
        setStatus('saving', 'Saving', 'Copying the local ledger to D1...');
        const result = await send(JSON.stringify(localData));
        if (result.ok) {
          markDirty(false);
          setStatus('synced', 'D1 synced', 'The local ledger was copied to D1.');
        } else {
          setStatus('offline', 'D1 offline', result.message);
          markDirty(true);
        }
      } else {
        setStatus('synced', 'D1 ready', 'D1 is connected; the first save will create the ledger.');
      }

      finishBoot();
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      mode = 'd1';
      setStatus(
        'offline',
        'D1 error',
        (body && body.error) || `D1 returned HTTP ${response.status}.`
      );
      finishBoot();
      return;
    }

    const body = await response.json().catch(() => null);
    if (!isValidLedger(body && body.data)) {
      mode = 'd1';
      setStatus('offline', 'D1 error', 'D1 did not return a valid ledger.');
      finishBoot();
      return;
    }

    mode = 'd1';

    const remoteEmpty = !body.data.vehicles.length && !body.data.entries.length;
    const remoteHasEntries = body.data.entries.length > 0;
    const localHasData = Boolean(
      localData && (localData.vehicles.length || localData.entries.length)
    );
    const localHasEntries = Boolean(localData && localData.entries.length);

    // Never overwrite edits that failed to upload from a previous session,
    // and never let a blank D1 row wipe a populated local ledger.
    // Also never let a local ledger with no entries replace a D1 ledger that
    // still has entries: that is the signature of a cleared browser, not an
    // intentional delete (those sync immediately while the page is open).
    const mayReplaceRemote = !remoteHasEntries || localHasEntries;
    if (localData && mayReplaceRemote && (localDirty || (remoteEmpty && localHasData))) {
      setStatus(
        'saving',
        'Saving',
        localDirty ? 'Uploading unsynced local changes...' : 'Copying the local ledger to D1...'
      );
      const result = await send(JSON.stringify(localData));
      if (result.ok) {
        markDirty(false);
        setStatus(
          'synced',
          'D1 synced',
          localDirty
            ? 'Unsynced local changes were uploaded to D1.'
            : 'The local ledger replaced the empty D1 copy.'
        );
      } else {
        setStatus('offline', 'D1 offline', result.message);
      }
      finishBoot();
      return;
    }

    applyRemote(
      JSON.stringify(body.data),
      Number(body.version) || 1,
      Number(body.updatedAt) || 0,
      false
    );

    finishBoot();
  }

  function onWake() {
    // The first check may have failed because the network was down; retry
    // detection on wake instead of staying local-only for the whole session.
    if (mode === 'local' && apiPresent !== false) {
      initialLoad();
      return;
    }
    flushPending();
    refreshFromD1();
  }

  // Mirror every ledger write made by either view (and by import/undo).
  Storage.prototype.setItem = function patchedSetItem(key, value) {
    const result = nativeSetItem.call(this, key, value);
    if (
      booted
      && !applyingRemote
      && this === window.localStorage
      && key === STORAGE_KEY
    ) {
      // A failed D1 API is not the same as a host without one: keep edits
      // marked so a later online visit uploads them instead of losing them.
      if (apiPresent !== false) markDirty(true);
      queuePush(String(value));
    }
    return result;
  };

  window.mileageCloud = {
    get mode() { return mode; },
    get version() { return version; },
    get updatedAt() { return updatedAt; },
    sync: refreshFromD1,
    save: flushPending,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintStatus, { once: true });
  } else {
    paintStatus();
  }

  window.addEventListener('online', onWake);
  window.addEventListener('focus', refreshFromD1);
  window.addEventListener('pagehide', pushKeepalive);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) onWake();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') onWake();
  });
  window.setInterval(refreshFromD1, POLL_MS);

  // Wait for the views to initialize before touching the ledger, otherwise
  // their DOMContentLoaded init would run after (and duplicate) a remote reload.
  if (document.readyState === 'complete') {
    window.setTimeout(initialLoad, 0);
  } else {
    window.addEventListener('load', () => window.setTimeout(initialLoad, 0), { once: true });
  }
})();
