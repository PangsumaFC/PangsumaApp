'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const money = value => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0
}).format(Number(value) || 0);
const compactMoney = value => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', notation: 'compact', maximumFractionDigits: 1
}).format(Number(value) || 0).replace(/\s/g, '');
const todayISO = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const dateLong = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return 'Tanggal tidak tersedia';
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(`${value}T12:00:00Z`));
};
const dateTimeLong = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Waktu tidak tersedia';
  return new Intl.DateTimeFormat('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
  }).format(date);
};
const monthLabel = key => {
  const [year, month] = String(key).split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
};
const reportTypeLabel = type => type === 'petty_cash' ? 'Petty cash' : 'Request Finance';

const icons = {
  overview: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M13.5 17h7m-3.5-3.5v7" stroke-linecap="round"/></svg>',
  report: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 3.5h8l4 4v13H6z" stroke-linejoin="round"/><path d="M14 3.5v4h4M9 12h6m-6 3.5h6" stroke-linecap="round"/></svg>',
  review: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 4h14v16H5zM8 8h8M8 12h4" stroke-linecap="round" stroke-linejoin="round"/><path d="m13.5 16 1.8 1.8 3.4-3.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  finance: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7.5h16v12H4zM4 7.5l2-3h12l2 3M4 11h16" stroke-linejoin="round"/><path d="M8 15h3" stroke-linecap="round"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-3 2.3-4.5 5.5-4.5s5 1.5 5.5 4.5M17 8h4m-2-2v4m-2 6c2.1.2 3.4 1.2 4 3" stroke-linecap="round"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6.5h15a1.5 1.5 0 0 1 1.5 1.5v11H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h13" stroke-linejoin="round"/><path d="M15 12h5.5v4H15a2 2 0 0 1 0-4Z"/><path d="M16.5 14h.1" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>'
};

const navByRole = {
  manager: [
    { id: 'overview', label: 'Ringkasan', icon: 'overview' },
    { id: 'approvals', label: 'Persetujuan', icon: 'review' },
    { id: 'finance', label: 'Laporan Finance', icon: 'finance' },
    { id: 'users', label: 'Pengguna', icon: 'users' }
  ],
  user: [
    { id: 'overview', label: 'Beranda', icon: 'overview' },
    { id: 'my-reports', label: 'Laporan saya', icon: 'report' },
    { id: 'change-password', label: 'Ganti password', icon: 'users' }
  ]
};

const emptyHistory = () => ({
  submissions: { nextCursor: null, hasMore: false, total: 0, loaded: 0 },
  cashLedger: { nextCursor: null, hasMore: false, total: 0, loaded: 0 },
  auditEvents: { nextCursor: null, hasMore: false, total: 0, loaded: 0 }
});

const state = {
  user: null,
  cashBalanceIdr: 0,
  submissions: [],
  users: [],
  cashLedger: [],
  auditEvents: [],
  summary: {},
  history: emptyHistory(),
  archiveType: 'all',
  archiveSearch: ''
};
let currentPage = 'overview';
let lastRenderedPage = '';
let authEpoch = 0;
let reportTypePreset = 'petty_cash';
let submissionIdempotencyKey = '';
let toastTimer = 0;
let installPrompt = null;
let confirmAction = null;
let resetTargetId = '';
let profileDraft = null;
let profileSelection = 0;
let profileSyncBusy = false;
let managerSyncBusy = false;
let managerSyncLastAt = 0;
let managerSyncRerenderPending = false;
const managerSyncIntervalMs = 20_000;
const managerSyncMinIntervalMs = 15_000;

function profileAvatar(user, className = 'welcome-avatar') {
  const name = user.nickname || user.name || 'Pengguna';
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  return `<span class="${className}" aria-hidden="true"><span>${escapeHTML(initials)}</span>${user.photoUrl ? `<img src="${escapeHTML(user.photoUrl)}" alt="" width="80" height="80">` : ''}</span>`;
}

function welcomeClock(now = new Date()) {
  const hour = now.getHours();
  return {
    greeting: hour < 5 ? 'Selamat malam' : hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 18 ? 'Selamat sore' : 'Selamat malam',
    date: new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)
  };
}

function updateWelcomePanel() {
  const panel = $('.welcome-card');
  if (panel && state.user) panel.outerHTML = welcomePanel();
}

async function refreshProfile() {
  if (!state.user || state.user.mustChangePassword || document.hidden || profileSyncBusy) return;
  const requestedId = state.user.id;
  profileSyncBusy = true;
  try {
    const result = await api('/profile');
    if (!state.user || state.user.id !== requestedId) return;
    if (Number(result.user.profileVersion || 0) < Number(state.user.profileVersion || 0)) return;
    state.user = result.user;
    $('#accountName').textContent = state.user.nickname || state.user.name;
    updateWelcomePanel();
  } catch {
    // Keep the last confirmed profile while offline; API still handles expired sessions.
  } finally {
    profileSyncBusy = false;
  }
}

function managerOverviewSnapshot() {
  return JSON.stringify({
    cashBalanceIdr: state.cashBalanceIdr,
    submissions: state.submissions,
    summary: state.summary,
    cashLedger: state.cashLedger,
    auditEvents: state.auditEvents,
    history: state.history
  });
}

function managerSyncRenderSafe() {
  const active = document.activeElement;
  return !$$('dialog[open]').length
    && !(active && active.matches?.('input, textarea, select, [contenteditable="true"]'));
}

async function refreshManagerOverview({ force = false } = {}) {
  if (managerSyncBusy || document.hidden || navigator.onLine === false) return false;
  if (!state.user || state.user.role !== 'manager' || state.user.mustChangePassword) return false;
  const now = Date.now();
  if (!force && now - managerSyncLastAt < managerSyncMinIntervalMs) return false;
  managerSyncLastAt = now;
  managerSyncBusy = true;
  const before = managerOverviewSnapshot();
  try {
    await refreshOverview();
    const changed = before !== managerOverviewSnapshot();
    if (!changed && !managerSyncRerenderPending) return false;
    if (!['overview', 'approvals', 'finance'].includes(currentPage)) {
      managerSyncRerenderPending = changed || managerSyncRerenderPending;
      return changed;
    }
    if (!managerSyncRenderSafe()) {
      managerSyncRerenderPending = true;
      return changed;
    }
    const shouldRender = changed || managerSyncRerenderPending;
    managerSyncRerenderPending = false;
    if (shouldRender) renderApp();
    return changed;
  } catch (error) {
    if (error?.code !== 'session_changed') return false;
    return false;
  } finally {
    managerSyncBusy = false;
  }
}

function requestManagerOverviewRefresh() {
  return refreshManagerOverview();
}

class ApiFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const requestEpoch = authEpoch;
  const headers = new Headers(options.headers || {});
  let body;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    body
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = payload?.error || {};
    if (response.status === 401 && error.code === 'authentication_required' && state.user && requestEpoch === authEpoch) {
      showLogin('Sesi Anda berakhir. Silakan masuk kembali.');
    }
    if (requestEpoch !== authEpoch) {
      throw new ApiFailure(401, 'session_changed', 'Sesi telah berakhir atau berubah. Masuk kembali untuk melanjutkan.');
    }
    throw new ApiFailure(response.status, error.code || 'request_failed', error.message || 'Layanan tidak dapat menyelesaikan permintaan.');
  }
  if (requestEpoch !== authEpoch) {
    throw new ApiFailure(401, 'session_changed', 'Sesi telah berakhir atau berubah. Masuk kembali untuk melanjutkan.');
  }
  return payload;
}

function webAuthnBuffer(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
}

function webAuthnBase64url(value) {
  const bytes = new Uint8Array(value || new ArrayBuffer(0));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function webAuthnPublicKey(options) {
  const publicKey = { ...options.publicKey, challenge: webAuthnBuffer(options.publicKey.challenge) };
  if (publicKey.user?.id) publicKey.user = { ...publicKey.user, id: webAuthnBuffer(publicKey.user.id) };
  for (const field of ['allowCredentials', 'excludeCredentials']) {
    if (Array.isArray(publicKey[field])) {
      publicKey[field] = publicKey[field].map(credential => ({ ...credential, id: webAuthnBuffer(credential.id) }));
    }
  }
  return publicKey;
}

function webAuthnCredentialPayload(credential) {
  const response = credential.response;
  const payload = {
    id: credential.id,
    rawId: webAuthnBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: webAuthnBase64url(response.clientDataJSON)
    }
  };
  if (response.attestationObject) {
    payload.response.attestationObject = webAuthnBase64url(response.attestationObject);
  } else {
    payload.response.authenticatorData = webAuthnBase64url(response.authenticatorData);
    payload.response.signature = webAuthnBase64url(response.signature);
    payload.response.userHandle = response.userHandle ? webAuthnBase64url(response.userHandle) : null;
  }
  return payload;
}

async function refreshPasskeyControls() {
  const panel = $('#passkeyControls');
  if (!panel) return;
  panel.hidden = true;
  try {
    const response = await fetch('/api/passkeys/status', { credentials: 'same-origin', cache: 'no-store' });
    const status = await response.json();
    if (!response.ok || status.enabled !== true) return;
    panel.hidden = false;
    const supported = typeof window.PublicKeyCredential !== 'undefined'
      && typeof navigator.credentials?.get === 'function'
      && typeof navigator.credentials?.create === 'function';
    $('#passkeyLoginButton').disabled = !supported;
    $$('.passkey-enrollment-form button').forEach(button => { button.disabled = !supported; });
    $('#passkeyAvailabilityMessage').textContent = supported
      ? ''
      : 'Browser ini belum mendukung passkey. Coba browser yang mendukung WebAuthn.';
  } catch {
    panel.hidden = true;
  }
}

function displayPasskeyError(error) {
  const message = error?.name === 'NotAllowedError' || error?.name === 'AbortError'
    ? 'Permintaan passkey dibatalkan atau tidak tersedia. Coba lagi.'
    : error instanceof ApiFailure ? error.message : friendlyError(error);
  $('#loginError').textContent = message;
  $('#loginError').hidden = false;
}

async function completeLogin(result, form = null) {
  state.user = result.user;
  if (state.user.mustChangePassword) {
    state.cashBalanceIdr = 0;
    state.submissions = [];
    state.users = [];
    state.cashLedger = [];
    state.auditEvents = [];
    currentPage = 'change-password';
  } else {
    await refreshOverview();
    currentPage = 'overview';
  }
  $('#loginError').hidden = true;
  if (form) form.reset();
  else $$('form').forEach(item => item.reset());
  renderApp();
  showToast(`Selamat datang, ${state.user.name}.`);
}

async function performPasskeyLogin(button = $('#passkeyLoginButton')) {
  if (!button || button.disabled) return;
  setButtonBusy(button, true, 'Menunggu passkey…');
  try {
    const options = await api('/passkeys/login/options', { method: 'POST', body: {} });
    const credential = await navigator.credentials.get({ publicKey: webAuthnPublicKey(options) });
    if (!credential) throw new Error('Tidak ada passkey yang dipilih.');
    const result = await api('/passkeys/login/verify', {
      method: 'POST',
      body: { challengeId: options.challengeId, credential: webAuthnCredentialPayload(credential) }
    });
    await completeLogin(result);
  } catch (error) {
    displayPasskeyError(error);
    button.focus();
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function registerPasskeyFromForm(event, settings) {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const requestData = settings.readPayload();
  form.reset();
  setButtonBusy(button, true, settings.busyText);
  try {
    const options = await api(settings.optionsPath, { method: 'POST', body: requestData });
    const credential = await navigator.credentials.create({ publicKey: webAuthnPublicKey(options) });
    if (!credential) throw new Error('Pendaftaran passkey dibatalkan.');
    const result = await api(settings.verifyPath, {
      method: 'POST',
      body: { ...requestData, challengeId: options.challengeId, credential: webAuthnCredentialPayload(credential) }
    });
    if (settings.autoLogin) {
      await completeLogin(result);
    } else if (settings.refreshApp === false) {
      $('#loginError').hidden = true;
      $('#passkeyEnrollmentStatus').textContent = settings.successMessage;
      $('#passkeyEnrollmentStatus').hidden = false;
    } else {
      await refreshOverview();
      renderApp();
      showToast(settings.successMessage);
    }
  } catch (error) {
    displayPasskeyError(error);
    form.querySelector('button[type="submit"]')?.focus();
  } finally {
    for (const key of Object.keys(requestData)) requestData[key] = '';
    form.reset();
    if (button?.isConnected) setButtonBusy(button, false);
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

function showLogin(message = '') {
  authEpoch += 1;
  closeDialogs();
  $$('form').forEach(form => form.reset());
  $$('input[type="password"], textarea, input[type="number"]').forEach(input => { input.value = ''; });
  state.user = null;
  state.cashBalanceIdr = 0;
  state.submissions = [];
  state.users = [];
  state.cashLedger = [];
  state.auditEvents = [];
  state.summary = {};
  state.history = emptyHistory();
  state.archiveType = 'all';
  state.archiveSearch = '';
  currentPage = 'overview';
  lastRenderedPage = '';
  reportTypePreset = 'petty_cash';
  submissionIdempotencyKey = '';
  confirmAction = null;
  resetTargetId = '';
  $('#appContent').replaceChildren();
  $('#desktopNav').replaceChildren();
  $('#mobileNav').replaceChildren();
  $('#accountName').textContent = '';
  $('#accountRole').textContent = '';
  document.body.classList.add('logged-out');
  $('#loginGate').hidden = false;
  $('#loginError').textContent = message;
  $('#loginError').hidden = !message;
  $('#loginForm').reset();
  $('#loginIdentifier').focus();
}

function hidePreloader() {
  const preloader = $('#pangsuma-preloader');
  document.body.removeAttribute('aria-busy');
  if (!preloader || preloader.hidden) return;
  const dismiss = () => {
    preloader.classList.add('is-hidden');
    preloader.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => { preloader.hidden = true; }, 620);
  };
  if (document.readyState === 'complete') dismiss();
  else window.addEventListener('load', dismiss, { once: true });
}

async function refreshOverview() {
  const requestedUser = state.user;
  const requestEpoch = authEpoch;
  if (!requestedUser) throw new ApiFailure(401, 'session_changed', 'Sesi tidak aktif. Masuk kembali untuk melanjutkan.');
  const result = await api('/overview');
  if (requestEpoch !== authEpoch || !state.user || state.user.id !== requestedUser.id) {
    throw new ApiFailure(401, 'session_changed', 'Sesi telah berubah. Masuk kembali untuk melanjutkan.');
  }
  state.user = result.user;
  state.cashBalanceIdr = Number(result.cashBalanceIdr) || 0;
  state.submissions = Array.isArray(result.submissions) ? result.submissions : [];
  state.users = Array.isArray(result.users) ? result.users : [];
  state.cashLedger = Array.isArray(result.cashLedger) ? result.cashLedger : [];
  state.auditEvents = Array.isArray(result.auditEvents) ? result.auditEvents : [];
  state.summary = result.summary || {};
  state.history = result.history || emptyHistory();
}

function navButton(item) {
  const current = currentPage === item.id ? 'page' : 'false';
  return `<button class="nav-button" type="button" data-page="${item.id}" aria-current="${current}">${icons[item.icon]}<span>${escapeHTML(item.label)}</span></button>`;
}

function renderNav() {
  const role = state.user?.role || 'user';
  const items = navByRole[role];
  $('#desktopNav').innerHTML = items.map(navButton).join('');
  const mobile = $('#mobileNav');
  if (role === 'manager') {
    mobile.className = 'mobile-nav is-manager';
    mobile.innerHTML = items.map(navButton).join('');
    return;
  }
  mobile.className = 'mobile-nav is-user';
  mobile.innerHTML = `${navButton(items[0])}<button class="mobile-add" type="button" data-action="open-report-choice" aria-label="Buat pengajuan baru">${icons.plus}</button>${navButton(items[1])}`;
}

function pageHeading(title, description = '', action = '') {
  return `<div class="page-heading"><div><h1>${escapeHTML(title)}</h1>${description ? `<p class="page-description">${escapeHTML(description)}</p>` : ''}</div>${action}</div>`;
}

function welcomePanel() {
  const user = state.user;
  const name = user.nickname || (user.name || 'Pengguna').trim().split(/\s+/)[0];
  const clock = welcomeClock();
  const position = user.dashboardPosition ?? user.position;
  return `<section class="welcome-card">${profileAvatar(user)}<div class="welcome-copy"><p class="welcome-date">${escapeHTML(clock.date)}</p><h1>${clock.greeting}, ${escapeHTML(name)}</h1><p class="welcome-role">${escapeHTML(position || (user.role === 'manager' ? 'Manager Pangsuma' : 'User Pangsuma'))}</p>${user.quote ? `<p class="welcome-quote">${escapeHTML(user.quote)}</p>` : ''}</div>${user.role === 'manager' ? '<button class="text-button profile-settings-link" type="button" data-page="users">Pengaturan profil tim</button>' : ''}</section>`;
}
function metricCard(icon, label, value, page = '', detail = '') {
  const content = `<span class="metric-icon" aria-hidden="true">${icons[icon]}</span><span class="metric-copy"><span class="metric-label">${escapeHTML(label)}</span><strong class="metric-value">${escapeHTML(value)}</strong>${detail ? `<span class="metric-detail">${escapeHTML(detail)}</span>` : ''}</span>`;
  const accessibleLabel = `${label}: ${value}`;
  return page
    ? `<button class="metric metric-link" type="button" data-page="${page}" aria-label="${escapeHTML(accessibleLabel)}">${content}</button>`
    : `<article class="metric" aria-label="${escapeHTML(accessibleLabel)}">${content}</article>`;
}

function statusInfo(item) {
  if (item.status === 'approved') return ['Disetujui', 'status-ok'];
  if (item.status === 'sent') return ['Terkirim ke Finance', 'status-ok'];
  if (item.status === 'rejected') return ['Ditolak', 'status-neutral'];
  return ['Menunggu Manager', 'status-wait'];
}

function submissionMeta(item, includeOwner = false) {
  const pieces = [reportTypeLabel(item.type), dateLong(item.date)];
  if (includeOwner && item.createdByName) pieces.unshift(item.createdByName);
  else if (item.createdByPosition) pieces.unshift(item.createdByPosition);
  return pieces.map(escapeHTML).join(' · ');
}

function submissionCard(item, options = {}) {
  const [label, statusClass] = statusInfo(item);
  const owner = options.includeOwner ? `<span class="item-owner">${escapeHTML(item.createdByName || 'Pengguna')}</span>` : '';
  const amount = `<div class="item-amount">${money(item.amountIdr)}</div>`;
  const status = `<span class="status ${statusClass}">${label}</span>`;
  let actions = '';
  if (options.actions && item.status === 'pending') {
    const own = item.createdBy === state.user?.id;
    const enoughCash = item.type !== 'petty_cash' || item.amountIdr <= state.cashBalanceIdr;
    const cannotApprove = own || !enoughCash;
    const approveLabel = item.type === 'petty_cash' ? 'Setujui & kurangi saldo' : 'Setujui request';
    const disableHint = own
      ? 'Manager tidak dapat memutuskan pengajuannya sendiri.'
      : !enoughCash ? 'Saldo petty cash belum mencukupi.' : '';
    actions = `<div class="item-actions"><button class="primary-button" type="button" data-action="approve" data-id="${escapeHTML(item.id)}" ${cannotApprove ? 'disabled' : ''} ${disableHint ? `aria-describedby="hint-${escapeHTML(item.id)}" title="${escapeHTML(disableHint)}"` : ''}>${approveLabel}</button><button class="secondary-button" type="button" data-action="reject" data-id="${escapeHTML(item.id)}" ${own ? 'disabled' : ''}>Tolak</button></div>${disableHint ? `<p class="action-hint" id="hint-${escapeHTML(item.id)}">${escapeHTML(disableHint)}</p>` : ''}`;
  }
  return `<article class="item-row"><div class="item-copy">${owner}<div class="item-title">${escapeHTML(item.description)}</div><div class="item-meta">${submissionMeta(item, false)}</div>${item.note ? `<p class="item-note">${escapeHTML(item.note)}</p>` : ''}</div><div class="item-side">${amount}${options.showStatus !== false ? status : ''}</div>${item.decisionReason ? `<p class="decision-reason"><strong>Alasan:</strong> ${escapeHTML(item.decisionReason)}</p>` : ''}${actions}</article>`;
}

function emptyState(title, message = '') {
  return `<div class="surface empty-state"><strong>${escapeHTML(title)}</strong>${message ? `<span>${escapeHTML(message)}</span>` : ''}</div>`;
}

function historyControls(collection, label) {
  const page = state.history?.[collection];
  if (!page || Number(page.total || 0) === 0) return '';
  const loaded = Number(page.loaded || 0);
  const total = Number(page.total || 0);
  const status = page.hasMore
    ? `Menampilkan ${loaded} dari ${total} ${label}.`
    : `Semua ${total} ${label} telah dimuat.`;
  const remaining = Math.min(100, Math.max(0, total - loaded));
  return `<div class="history-controls" aria-live="polite"><p>${escapeHTML(status)}</p>${page.hasMore ? `<button class="secondary-button" type="button" data-action="load-more-history" data-collection="${escapeHTML(collection)}">Muat ${remaining} ${escapeHTML(label)} berikutnya</button>` : ''}</div>`;
}

function managerOverview() {
  const pending = state.submissions.filter(item => item.status === 'pending');
  const today = todayISO();
  const todayItems = state.submissions.filter(item => item.date === today);
  const recent = state.submissions.slice(0, 3);
  const financeWaiting = state.summary.financeWaiting ?? state.submissions.filter(item => item.type === 'finance_request' && item.status === 'approved').length;
  const pendingCount = state.summary.pending ?? pending.length;
  const todayCount = state.summary.today ?? todayItems.length;
  return `${welcomePanel()}
    <div class="section-row"><div><h2>Pengajuan Anda</h2><p>Pengajuan Manager otomatis disetujui dan digabung dengan pengajuan lain yang sudah disetujui.</p></div><button class="primary-button" type="button" data-action="open-report-choice">Buat pengajuan</button></div>
    <section class="hero-panel balance-panel"><div><span>Saldo petty cash</span><strong>${money(state.cashBalanceIdr)}</strong><p>${state.cashBalanceIdr === 0 ? 'Saldo awal tetap nol sampai pemilik mengonfirmasi angka aktual.' : 'Saldo dikelola melalui keputusan dan ledger.'}</p></div><button class="secondary-button" type="button" data-page="finance">Lihat Finance</button></section>
    <div class="metric-row" aria-label="Ringkasan operasional">${metricCard('review', 'Menunggu persetujuan', String(pendingCount), 'approvals')}${metricCard('finance', 'Menunggu Finance', String(financeWaiting), 'finance')}${metricCard('report', 'Pengajuan hari ini', String(todayCount))}</div>
    <div class="manager-layout"><section class="manager-ledger"><div class="section-row"><div><h2>Aktivitas hari ini</h2><p>${todayCount} pengajuan pada ${dateLong(today)}</p></div><button class="text-button" type="button" data-page="approvals">Lihat persetujuan</button></div>${todayItems.length ? `<div class="list-stack">${todayItems.slice(0, 3).map(item => submissionCard(item, { includeOwner: true })).join('')}</div>` : emptyState('Belum ada pengajuan hari ini', 'Aktivitas akan tampil di sini setelah User mengirim laporan.')}</section><section class="manager-queue"><div class="section-row"><div><h2>Menunggu persetujuan</h2></div><button class="text-button" type="button" data-page="approvals">Lihat semua</button></div>${pending.length ? `<div class="list-stack">${pending.slice(0, 2).map(item => submissionCard(item, { includeOwner: true, actions: true })).join('')}</div>` : emptyState('Antrian kosong', 'Pengajuan baru akan tampil setelah dikirim User.')}</section></div>
    ${recent.length ? `<section class="recent-section"><div class="section-row"><div><h2>Pengajuan terbaru</h2></div></div><div class="list-stack">${recent.map(item => submissionCard(item, { includeOwner: true })).join('')}</div></section>` : ''}`;
}

function userOverview() {
  const own = state.submissions;
  return `${welcomePanel()}
    <div class="metric-row" aria-label="Ringkasan laporan">${metricCard('report', 'Total laporan', String(state.summary.total ?? own.length), 'my-reports')}${metricCard('review', 'Menunggu', String(state.summary.pending ?? own.filter(item => item.status === 'pending').length), 'my-reports')}</div>
    <section class="guide-card" aria-labelledby="guideTitle"><div class="guide-heading"><div><h2 id="guideTitle">Pengajuan operasional</h2><p>Ajukan kebutuhan dan pantau keputusan Manager.</p></div><button class="primary-button home-report-cta" type="button" data-action="open-report-choice">Buat pengajuan</button></div><ol class="guide-steps"><li><span>1</span><strong>Pilih Petty cash atau Finance</strong></li><li><span>2</span><strong>Isi keperluan dan nominal</strong></li><li><span>3</span><strong>Kirim untuk ditinjau Manager</strong></li></ol></section>
    <div class="section-row"><div><h2>Laporan terbaru</h2></div><button class="text-button" type="button" data-page="my-reports">Lihat semua</button></div>${own.length ? `<div class="list-stack">${own.slice(0, 3).map(item => submissionCard(item)).join('')}</div>` : emptyState('Belum ada laporan', 'Gunakan tombol “Buat pengajuan” saat Anda siap mengirim kebutuhan.')}`;
}

function managerApprovals() {
  const pending = state.submissions.filter(item => item.status === 'pending');
  const history = state.submissions.filter(item => item.status !== 'pending');
  const audit = state.auditEvents;
  return `${pageHeading('Persetujuan', 'Tinjau setiap pengajuan. Keputusan petty cash tercatat bersama perubahan saldo.')}
    <div class="metric-row" aria-label="Ringkasan persetujuan">${metricCard('review', 'Menunggu', String(state.summary.pending ?? pending.length))}${metricCard('wallet', 'Saldo petty cash', compactMoney(state.cashBalanceIdr), 'overview', money(state.cashBalanceIdr))}${metricCard('report', 'Masuk hari ini', String(state.summary.today ?? 0))}</div>
    <div class="section-row"><div><h2>Antrian</h2></div></div>${pending.length ? `<div class="list-stack">${pending.map(item => submissionCard(item, { includeOwner: true, actions: true })).join('')}</div>` : emptyState('Belum ada pengajuan menunggu', 'Keputusan Manager yang selesai akan tetap ada di riwayat.')}
    <div class="section-row"><div><h2>Riwayat keputusan</h2></div><span class="archive-total">${Math.max(0, Number(state.summary.total || 0) - Number(state.summary.pending || 0))} pengajuan</span></div>${history.length ? `<div class="list-stack">${history.map(item => submissionCard(item, { includeOwner: true })).join('')}</div>` : emptyState('Belum ada keputusan', 'Persetujuan dan penolakan akan tercatat di sini.')}
    ${historyControls('submissions', 'pengajuan')}
    <details class="audit-panel" data-panel="audit-events"><summary>Riwayat perubahan sistem (${state.history.auditEvents.loaded} dari ${state.history.auditEvents.total})</summary>${audit.length ? `<ol class="audit-list">${audit.map(auditRow).join('')}</ol>` : `<p class="field-help">Belum ada aktivitas audit.</p>`}${historyControls('auditEvents', 'aktivitas audit')}</details>`;
}

function financePage() {
  const finance = state.submissions.filter(item => item.type === 'finance_request');
  const waiting = finance.filter(item => item.status === 'approved');
  const sent = finance.filter(item => item.status === 'sent');
  const ledgers = state.cashLedger;
  const openingConfigured = ledgers.some(event => event.event_type === 'opening_balance' && Number(event.amount_idr) > 0);
  const headingActions = `<div class="heading-actions">${openingConfigured ? '' : '<button class="secondary-button" type="button" data-action="open-opening-balance">Tetapkan saldo awal</button>'}<button class="secondary-button" type="button" data-action="download-csv">Unduh rekap lengkap CSV</button><details class="csv-fallback"><summary>File tidak muncul?</summary><p class="field-help">Coba buka di Chrome atau Safari, atau <a href="/api/export.csv" download>unduh langsung CSV</a>.</p></details></div>`;
  return `${pageHeading('Finance', 'Pantau Request Finance dari antrean Manager sampai terkirim.', headingActions)}
    <div class="metric-row" aria-label="Ringkasan Finance">${metricCard('finance', 'Total request', String(state.summary.financeTotal ?? finance.length))}${metricCard('review', 'Belum dikirim', String(state.summary.financeWaiting ?? waiting.length))}${metricCard('wallet', 'Terkirim', String(state.summary.financeSent ?? sent.length))}</div>
    <div class="section-row"><div><h2>Request Finance</h2></div></div>${finance.length ? `<div class="list-stack">${finance.map(item => { const label = item.status === 'sent' ? 'Terkirim' : item.status === 'approved' ? 'Menunggu Finance' : item.status === 'rejected' ? 'Ditolak' : 'Menunggu Manager'; const statusClass = item.status === 'sent' ? 'status-ok' : item.status === 'rejected' ? 'status-neutral' : 'status-wait'; return `<article class="item-row"><div class="item-copy"><span class="item-owner">${escapeHTML(item.createdByName || 'User')}</span><div class="item-title">${escapeHTML(item.description)}</div><div class="item-meta">${submissionMeta(item, false)}</div></div><div class="item-side"><div class="item-amount">${money(item.amountIdr)}</div><span class="status ${statusClass}">${label}</span></div>${item.status === 'approved' ? `<div class="item-actions"><button class="primary-button" type="button" data-action="send-finance" data-id="${escapeHTML(item.id)}">Tandai terkirim ke Finance</button></div>` : ''}</article>`; }).join('')}</div>` : emptyState('Belum ada Request Finance', 'Permintaan baru akan muncul setelah User mengirim pengajuan.')}
    ${historyControls('submissions', 'pengajuan')}
    <details class="audit-panel" data-panel="cash-ledger"><summary>Ledger petty cash (${state.history.cashLedger.loaded} dari ${state.history.cashLedger.total})</summary>${ledgers.length ? `<ol class="audit-list">${ledgers.map(ledgerRow).join('')}</ol>` : `<p class="field-help">Belum ada transaksi saldo.</p>`}${historyControls('cashLedger', 'transaksi ledger')}</details>`;
}

function auditRow(event) {
  let details = {};
  try { details = JSON.parse(event.details_json || '{}'); } catch { details = {}; }
  const actionLabels = {
    'system.bootstrap_completed': 'Roster awal disiapkan',
    'cash.opening_balance_set': 'Saldo awal ditetapkan',
    'submission.created': 'Pengajuan dibuat',
    'submission.status_changed': `Status pengajuan: ${details.from || '?'} → ${details.to || '?'}`,
    'user.created': 'Akun User ditambahkan',
    'user.password_changed': 'Password pengguna diperbarui',
    'user.profile_updated': 'Profil dashboard diperbarui',
    'user.deactivated': 'Akses pengguna dinonaktifkan'
  };
  const label = actionLabels[event.action] || event.action;
  const amount = details.amount_idr ? ` · ${money(details.amount_idr)}` : '';
  const reason = details.reason ? ` · Alasan: ${details.reason}` : '';
  return `<li><div class="audit-main"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(event.actor_name || 'Sistem')}</span></div><small>${escapeHTML(dateTimeLong(event.created_at))}${amount}${reason}</small></li>`;
}

function ledgerRow(event) {
  const debit = event.direction === 'debit';
  return `<li><div class="audit-main"><strong>${debit ? 'Pengeluaran petty cash disetujui' : 'Saldo awal'}</strong><span>${debit ? '−' : '+'}${money(event.amount_idr)}</span></div><small>${escapeHTML(event.actor_name || 'Sistem')} · Saldo setelah transaksi ${money(event.balance_after_idr)} · ${escapeHTML(dateTimeLong(event.created_at))}${event.note ? ` · ${escapeHTML(event.note)}` : ''}</small></li>`;
}

function usersPage() {
  const userRows = state.users.map(user => {
    const passkeyCount = Number(user.passkeyCount || 0);
    const credential = !user.active ? 'Akses nonaktif' : passkeyCount ? 'Passkey siap' : !user.passwordReady ? 'Password belum diatur' : user.mustChangePassword ? 'Wajib ganti password' : 'Siap masuk';
    const statusClass = !user.active ? 'status-neutral' : passkeyCount || (user.passwordReady && !user.mustChangePassword) ? 'status-ok' : 'status-wait';
    const passkeyLabel = passkeyCount ? `Passkey terdaftar (${passkeyCount})` : 'Belum ada passkey';
    const accessActions = user.role === 'manager' || !user.active
      ? '<span class="field-help">Tidak ada tindakan</span>'
      : `<div class="user-actions"><button class="secondary-button" type="button" data-action="reset-user-password" data-id="${escapeHTML(user.id)}" data-name="${escapeHTML(user.name)}">Atur password</button><button class="danger-button" type="button" data-action="deactivate-user" data-id="${escapeHTML(user.id)}" data-name="${escapeHTML(user.name)}">Nonaktifkan akses</button></div>`;
    const actions = `<div class="user-actions"><button class="secondary-button" type="button" data-action="edit-user-profile" data-id="${escapeHTML(user.id)}">Atur profil</button>${accessActions}</div>`;
    return `<tr><td data-label="Pengguna"><div class="profile-user-cell">${profileAvatar(user, 'user-initial')}<div>${escapeHTML(user.name)}${user.nickname ? `<small class="profile-nickname">${escapeHTML(user.nickname)}</small>` : ''}</div></div></td><td data-label="Posisi dashboard">${escapeHTML(user.dashboardPosition ?? user.position ?? 'Belum diisi')}</td><td data-label="Peran"><span class="status status-neutral">${user.role === 'manager' ? 'Manager' : 'User'}</span></td><td data-label="ID masuk">${escapeHTML(user.email)}</td><td data-label="Status akses"><span class="status ${statusClass}">${credential}</span><small class="passkey-status">${passkeyLabel}</small></td><td data-label="Aksi">${actions}</td></tr>`;
  }).join('');
  const actions = '<div class="user-page-actions"><button class="secondary-button" type="button" data-action="open-add-user">Tambah pengguna</button></div>';
  return `${pageHeading('Pengguna', 'Atur profil dashboard, foto, dan akses setiap akun, termasuk profil Anda.', actions)}
    <section class="form-card surface add-user-card" id="addUserCard" hidden><h2>Tambah akun User</h2><form id="userForm"><div class="form-grid"><div class="field"><label for="userName">Nama</label><input id="userName" name="name" required maxlength="80" autocomplete="name"></div><div class="field"><label for="userLoginId">ID masuk</label><input id="userLoginId" name="email" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="180" required><span class="field-help">Gunakan ID seperti alamat akun; aplikasi tidak mengirim email.</span></div><div class="field field-full"><label for="userPosition">Jabatan (opsional)</label><input id="userPosition" name="position" maxlength="80"></div></div><p class="form-note">Akun baru berperan sebagai User. Atur password sementara secara terpisah setelah akun dibuat.</p><div class="form-actions"><button class="primary-button" type="submit">Simpan pengguna</button><button class="secondary-button" type="button" data-action="cancel-add-user">Batal</button></div></form></section>
    <div class="section-row"><div><h2>Daftar akun</h2></div><span class="archive-total">${state.users.length} akun</span></div>
    ${state.users.length ? `<div class="table-wrap"><table><thead><tr><th>Pengguna</th><th>Posisi dashboard</th><th>Peran</th><th>ID masuk</th><th>Status akses</th><th>Aksi</th></tr></thead><tbody>${userRows}</tbody></table></div>` : emptyState('Belum ada akun', 'Daftar akun dimuat dari server setelah bootstrap disetujui.')}`;
}

function myReportsPage() {
  const query = state.archiveSearch.trim().toLocaleLowerCase('id-ID');
  const filtered = state.submissions.filter(item => {
    const text = `${item.description} ${item.note} ${reportTypeLabel(item.type)} ${dateLong(item.date)} ${item.status}`.toLocaleLowerCase('id-ID');
    return (state.archiveType === 'all' || item.type === state.archiveType) && (!query || text.includes(query));
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const groups = new Map();
  for (const item of filtered) {
    const key = String(item.date).slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const content = filtered.length ? [...groups.entries()].map(([month, items], index) => `<details class="archive-month" ${index === 0 ? 'open' : ''}><summary><span class="archive-month-copy"><strong>${escapeHTML(monthLabel(month))}</strong><small>${items.length} laporan</small></span><span class="archive-chevron" aria-hidden="true"></span></summary><div class="archive-month-content"><div class="list-stack">${items.map(item => submissionCard(item)).join('')}</div></div></details>`).join('') : emptyState(query || state.archiveType !== 'all' ? 'Tidak ada laporan yang cocok' : 'Belum ada laporan', query || state.archiveType !== 'all' ? 'Ubah kata kunci atau jenis laporan.' : 'Pengajuan yang Anda kirim akan tersimpan di akun Anda.');
  return `${pageHeading('Laporan', 'Riwayat pengajuan Anda.')}
    <div class="archive-controls"><label class="archive-search"><span class="sr-only">Cari laporan</span><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4 4" stroke-linecap="round"/></svg><input id="archiveSearch" type="search" autocomplete="off" placeholder="Cari kebutuhan atau tanggal…" value="${escapeHTML(state.archiveSearch)}"></label><div class="archive-filter-row" role="group" aria-label="Jenis laporan"><button class="filter-chip" type="button" data-report-filter="all" aria-pressed="${state.archiveType === 'all'}">Semua</button><button class="filter-chip" type="button" data-report-filter="petty_cash" aria-pressed="${state.archiveType === 'petty_cash'}">Petty cash</button><button class="filter-chip" type="button" data-report-filter="finance_request" aria-pressed="${state.archiveType === 'finance_request'}">Request Finance</button></div></div><div class="archive-month-list" id="archiveResults">${content}</div>${historyControls('submissions', 'laporan')}`;
}

function reportForm() {
  const type = reportTypePreset;
  return `${pageHeading('Buat pengajuan', 'Isi kebutuhan Anda. Nominal dan status akan tersimpan di server.')}
    <form id="reportForm" class="form-card surface"><div class="form-grid">
      <div class="field field-full"><label for="reportType">Jenis pengajuan</label><select id="reportType" name="type" required><option value="petty_cash" ${type === 'petty_cash' ? 'selected' : ''}>Petty cash</option><option value="finance_request" ${type === 'finance_request' ? 'selected' : ''}>Request Finance</option></select><div class="field-help" id="typeHelp">${state.user?.role === 'manager' ? (type === 'petty_cash' ? 'Otomatis disetujui; saldo petty cash langsung berkurang saat dikirim dan harus mencukupi.' : 'Otomatis disetujui dan langsung masuk daftar menunggu Finance.') : (type === 'petty_cash' ? 'Saldo petty cash berkurang setelah disetujui Manager.' : 'Request Finance masuk ke daftar Finance setelah disetujui.')}</div></div>
      <div class="field"><label for="reportDate">Tanggal</label><input id="reportDate" name="date" type="date" value="${todayISO()}" required></div>
      <div class="field"><label for="reportAmount">Nominal (rupiah)</label><input id="reportAmount" name="amountIdr" type="number" inputmode="numeric" min="1" step="1" required placeholder="Contoh: 150000"></div>
      <div class="field field-full"><label for="reportDescription">Keperluan</label><input id="reportDescription" name="description" required minlength="3" maxlength="150" placeholder="Jelaskan kebutuhan operasional"></div>
      <div class="field field-full"><label for="reportNote">Catatan (opsional)</label><textarea id="reportNote" name="note" maxlength="500" placeholder="Informasi tambahan untuk Manager"></textarea></div>
    </div><div class="form-actions"><button class="primary-button" type="submit">Kirim pengajuan</button><button class="secondary-button" type="button" data-page="overview">Batal</button></div></form>`;
}

function cashInfo() {
  if (state.user?.role !== 'manager') return userOverview();
  const approved = state.submissions.filter(item => item.type === 'petty_cash' && item.status === 'approved');
  return `${pageHeading('Petty cash', 'Saldo berasal dari ledger server. Persetujuan pengeluaran mengurangi saldo satu kali.')}
    <div class="hero-panel balance-panel"><div><span>Saldo tersedia</span><strong>${money(state.cashBalanceIdr)}</strong><p>${state.cashBalanceIdr === 0 ? 'Saldo awal tetap nol sampai pemilik mengonfirmasi angka aktual.' : 'Setiap pengeluaran disetujui tersimpan pada ledger.'}</p></div></div>
    ${state.user.role === 'user' ? `<div class="section-row"><div><h2>Pengeluaran Anda</h2></div><button class="primary-button" type="button" data-action="open-report-choice">Buat pengajuan</button></div>` : ''}
    ${approved.length ? `<div class="list-stack">${approved.map(item => submissionCard(item)).join('')}</div>` : emptyState('Belum ada pengeluaran disetujui', state.cashBalanceIdr === 0 ? 'Saldo nol; pengajuan Petty cash belum dapat disetujui.' : 'Pengeluaran yang disetujui akan tampil di sini.')}${historyControls('submissions', 'pengajuan')}`;
}

function changePasswordPage() {
  const forced = state.user.mustChangePassword;
  return `${pageHeading(forced ? 'Buat password baru' : 'Ganti password', forced ? 'Sebelum melanjutkan, ganti password sementara dengan password milik Anda.' : 'Gunakan password yang unik dan minimal 12 karakter.')}
    <form id="passwordForm" class="form-card surface"><div class="form-grid">
      <div class="field field-full"><label for="currentPassword">Password saat ini</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></div>
      <div class="field field-full"><label for="newPassword">Password baru</label><input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><span class="field-help">Panjang 12–128 karakter. Password tidak dikirim lewat email.</span></div>
      <div class="field field-full"><label for="confirmPassword">Ulangi password baru</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div>
      <p class="field-error" id="passwordError" role="alert" hidden></p>
    </div><div class="form-actions"><button class="primary-button" type="submit">Simpan password</button>${forced ? '' : '<button class="secondary-button" type="button" data-page="overview">Batal</button>'}</div></form>`;
}

function renderApp() {
  if (!state.user) return;
  const openPanels = new Set($$('#appContent details[data-panel][open]').map(panel => panel.dataset.panel));
  if (state.user.mustChangePassword) currentPage = 'change-password';
  const role = state.user.role;
  const allowed = role === 'manager'
    ? ['overview', 'approvals', 'finance', 'users', 'change-password', 'new-report']
    : ['overview', 'my-reports', 'change-password', 'new-report'];
  if (!allowed.includes(currentPage)) currentPage = 'overview';
  const pageChanged = currentPage !== lastRenderedPage;
  document.body.classList.remove('logged-out');
  $('#loginGate').hidden = true;
  $('#accountName').textContent = state.user.nickname || state.user.name;
  $('#accountRole').textContent = role === 'manager' ? 'Manager' : `User${state.user.position ? ` · ${state.user.position}` : ''}`;
  renderNav();
  let body;
  if (currentPage === 'change-password') body = changePasswordPage();
  else if (currentPage === 'new-report') body = reportForm();
  else if (role === 'manager') {
    body = currentPage === 'approvals' ? managerApprovals() : currentPage === 'finance' ? financePage() : currentPage === 'users' ? usersPage() : managerOverview();
  } else {
    body = currentPage === 'my-reports' ? myReportsPage() : currentPage === 'cash-info' ? cashInfo() : currentPage === 'new-report' ? reportForm() : userOverview();
  }
  $('#appContent').innerHTML = body;
  $$('#appContent details[data-panel]').forEach(panel => { panel.open = openPanels.has(panel.dataset.panel); });
  if (pageChanged) $('#mainContent').scrollTo(0, 0);
  lastRenderedPage = currentPage;
  if (currentPage === 'new-report') $('#reportDescription')?.focus();
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialogs() {
  $$('dialog[open]').forEach(dialog => dialog.close());
}

function renderProfilePreview() {
  if (!profileDraft) return;
  const target = profileDraft.target;
  if (!target) return;
  const photoUrl = profileDraft.photoDataUrl === undefined ? target.photoUrl : profileDraft.photoDataUrl;
  $('#profilePreview').innerHTML = profileAvatar({ ...target, photoUrl });
  $('[data-action="remove-profile-photo"]').disabled = !photoUrl || profileDraft.processing;
}

async function openUserProfile(id) {
  if (state.user?.role !== 'manager' || state.user.mustChangePassword) return;
  const target = state.users.find(user => user.id === id);
  if (!target) return;
  profileSelection += 1;
  const draft = { id, processing: false, saving: false, loading: true };
  profileDraft = draft;
  const epoch = authEpoch;
  $('#userProfileForm').reset();
  $('#userProfileDescription').textContent = `Profil untuk ${target.name}. Nama akun dan ID masuk tetap sama.`;
  $('#profileError').hidden = true;
  $('#profilePreview').replaceChildren();
  $('#profilePhotoStatus').textContent = 'Memuat profil terbaru…';
  const controls = [...$('#userProfileForm').querySelectorAll('input, textarea, button:not([data-action="close-dialog"])')];
  controls.forEach(control => { control.disabled = true; });
  openDialog('userProfileDialog');
  try {
    const result = await api(`/users/${encodeURIComponent(id)}/profile`);
    if (profileDraft !== draft || epoch !== authEpoch) return;
    draft.target = result.user;
    draft.profileVersion = result.user.profileVersion;
    $('#profileNickname').value = result.user.nickname || '';
    $('#profilePosition').value = result.user.dashboardPosition ?? result.user.position ?? '';
    $('#profileQuote').value = result.user.quote || '';
    controls.forEach(control => { control.disabled = false; });
    draft.loading = false;
    $('#profilePhotoStatus').textContent = '';
    renderProfilePreview();
    $('#profileNickname').focus();
  } catch (error) {
    if (profileDraft !== draft || epoch !== authEpoch) return;
    $('#profilePhotoStatus').textContent = '';
    $('#profileError').textContent = `${friendlyError(error)} Tutup dan buka kembali untuk mencoba memuat profil.`;
    $('#profileError').hidden = false;
  }
}

function unsupportedNativePhotoError(mime) {
  return (mime === 'image/heic' || mime === 'image/heif')
    ? new Error('Browser ini belum mendukung HEIC/HEIF. Pilih foto JPG atau PNG.')
    : null;
}
async function decodeProfilePhoto(file, mime = profilePhotoMime(file)) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); }
    catch {
      // WebP must not fall through to Image.decode: some engines accept a
      // header-only WebP there. JPEG/PNG can still be valid when bitmap
      // decoding is unavailable for the selected gallery file.
      if (mime === 'image/webp') throw new Error('Foto tidak dapat dibaca. Pilih file gambar yang valid.');
    }
  }
  // Some mobile browsers expose Image.decode but not createImageBitmap.
  // Image.decode can accept header-only WebP, so never use it for that format.
  if (mime === 'image/webp') throw new Error('Browser ini belum dapat memvalidasi WebP. Pilih foto JPG atau PNG, atau perbarui browser.');
  // Use data: rather than blob: so the fallback respects our image CSP.
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Foto tidak dapat dibaca.'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  if (typeof image.decode !== 'function') {
    throw unsupportedNativePhotoError(mime) || new Error('Browser tidak dapat memvalidasi foto. Perbarui browser atau coba browser lain.');
  }
  image.src = source;
  try { await image.decode(); } catch {
    throw unsupportedNativePhotoError(mime) || new Error('Foto tidak dapat dibaca. Pilih file gambar yang valid.');
  }
  return image;
}
function profilePhotoMime(file) {
  const type = String(file?.type || '').trim().toLowerCase();
  const extensionMime = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif'
  }[file?.name?.split('.').pop()?.toLowerCase()] || '';
  const aliases = {
    'image/jpg': 'image/jpeg',
    'image/x-heic': 'image/heic',
    'image/x-heif': 'image/heif',
    'application/octet-stream': extensionMime,
    'binary/octet-stream': extensionMime
  };
  if (type) return aliases[type] || type;
  return extensionMime;
}
async function prepareProfilePhoto(file) {
  if (!file || !profileDraft || profileDraft.loading || profileDraft.saving || profileDraft.conflicted) return;
  const draft = profileDraft;
  const selection = ++profileSelection;
  const errorBox = $('#profileError');
  errorBox.hidden = true;
  draft.processing = true;
  $('#profileSubmit').disabled = true;
  $('[data-action="remove-profile-photo"]').disabled = true;
  $('#profilePhotoStatus').textContent = 'Menyiapkan foto…';
  let image;
  try {
    const mime = profilePhotoMime(file);
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(mime)) throw new Error('Pilih foto JPG, PNG, WebP, HEIC, atau HEIF. Format lain belum didukung.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Foto melebihi 10 MB. Pilih foto yang lebih kecil.');
    // Never trust Image.onload alone: malformed WebP headers can fire it.
    const decodeFile = file.type === mime ? file : file.slice(0, file.size, mime);
    image = await decodeProfilePhoto(decodeFile, mime);
    if (profileDraft !== draft || selection !== profileSelection) return;
    if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error('Resolusi foto terlalu besar. Pilih foto dengan resolusi lebih kecil.');
    const side = Math.min(image.width, image.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(side, 512);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Browser tidak dapat menyiapkan foto. Coba browser lain.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    let photo;
    for (const quality of [0.88, 0.75, 0.6, 0.45]) {
      photo = canvas.toDataURL('image/jpeg', quality);
      if (Math.ceil((photo.length - photo.indexOf(',') - 1) * 3 / 4) <= 128 * 1024) break;
    }
    if (!photo?.startsWith('data:image/jpeg;base64,') || Math.ceil((photo.length - photo.indexOf(',') - 1) * 3 / 4) > 128 * 1024) throw new Error('Foto belum dapat diperkecil. Pilih foto lain.');
    if (profileDraft !== draft || selection !== profileSelection) return;
    draft.photoDataUrl = photo;
    $('#profilePhotoStatus').textContent = 'Foto siap. Tekan Simpan profil untuk menerapkan.';
  } catch (error) {
    if (profileDraft !== draft || selection !== profileSelection) return;
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    $('#profilePhotoStatus').textContent = '';
  } finally {
    image?.close?.();
    if (profileDraft === draft && selection === profileSelection) {
      draft.processing = false;
      $('#profileSubmit').disabled = false;
      $('#profilePhoto').value = '';
      renderProfilePreview();
    }
  }
}

async function performUserProfileSave(event) {
  event.preventDefault();
  const draft = profileDraft;
  const form = $('#userProfileForm');
  if (!draft || draft.loading || draft.conflicted || draft.processing || draft.saving || !form.reportValidity()) return;
  const payload = {
    profileVersion: draft.profileVersion,
    nickname: $('#profileNickname').value.trim(),
    dashboardPosition: $('#profilePosition').value.trim(),
    quote: $('#profileQuote').value.trim()
  };
  if (draft.photoDataUrl !== undefined) payload.photoDataUrl = draft.photoDataUrl;
  const errorBox = $('#profileError');
  errorBox.hidden = true;
  draft.saving = true;
  const controls = [...form.querySelectorAll('button, input, textarea')];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  setButtonBusy($('#profileSubmit'), true, 'Menyimpan profil…');
  const epoch = authEpoch;
  try {
    const result = await api(`/users/${encodeURIComponent(draft.id)}/profile`, { method: 'PUT', body: payload });
    // Use only the server-confirmed profile; never modify financial state locally.
    state.users = state.users.map(user => user.id === draft.id ? { ...user, ...result.user } : user);
    if (state.user?.id === draft.id) state.user = { ...state.user, ...result.user };
    let refreshed = true;
    try { await refreshOverview(); } catch (error) {
      if (epoch !== authEpoch || !state.user) return;
      refreshed = false;
    }
    $('#userProfileDialog').close();
    renderApp();
    showToast(refreshed ? 'Profil tersimpan. Perangkat pengguna akan memperbarui profil saat online.' : 'Profil dan foto tersimpan. Ringkasan belum diperbarui; muat ulang saat koneksi tersedia.');
    $(`[data-action="edit-user-profile"][data-id="${draft.id}"]`)?.focus({ preventScroll: true });
  } catch (error) {
    if (epoch !== authEpoch) return;
    if (error.code === 'profile_conflict') draft.conflicted = true;
    errorBox.textContent = friendlyError(error);
    errorBox.hidden = false;
  } finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    setButtonBusy($('#profileSubmit'), false);
    if (draft.conflicted) $('#profileSubmit').disabled = true;
    draft.saving = false;
  }
}

function setConfirm(kind, title, description, label, danger = false, payload = {}) {
  confirmAction = { kind, ...payload };
  $('#confirmTitle').textContent = title;
  $('#confirmDescription').textContent = description;
  const button = $('#confirmSubmit');
  button.textContent = label;
  button.classList.toggle('danger-button', danger);
  button.classList.toggle('primary-button', !danger);
  openDialog('confirmDialog');
}

function setButtonBusy(button, busy, label = '') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || 'Memproses…';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function friendlyError(error) {
  if (error instanceof ApiFailure) return error.message;
  return 'Koneksi ke layanan gagal. Periksa koneksi lalu coba lagi.';
}

async function performConfirmedAction() {
  if (!confirmAction) return;
  const button = $('#confirmSubmit');
  const action = confirmAction;
  setButtonBusy(button, true);
  try {
    if (action.kind === 'approve') await api(`/submissions/${encodeURIComponent(action.id)}/approve`, { method: 'POST', body: {} });
    if (action.kind === 'send') await api(`/submissions/${encodeURIComponent(action.id)}/send`, { method: 'POST', body: {} });
    if (action.kind === 'deactivate') await api(`/users/${encodeURIComponent(action.id)}/deactivate`, { method: 'POST', body: {} });
    closeDialogs();
    confirmAction = null;
    await refreshOverview();
    renderApp();
    showToast(action.successMessage);
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function performReject(event) {
  event.preventDefault();
  const button = $('#rejectSubmit');
  if (!$('#rejectForm').reportValidity()) return;
  const id = $('#rejectForm').dataset.id;
  const reason = $('#rejectReason').value.trim();
  setButtonBusy(button, true, 'Menyimpan keputusan…');
  try {
    await api(`/submissions/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason } });
    closeDialogs();
    await refreshOverview();
    renderApp();
    showToast('Penolakan dan alasannya tersimpan pada riwayat.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function performUserPasswordReset(event) {
  event.preventDefault();
  const form = $('#userPasswordForm');
  if (!form.reportValidity()) return;
  const button = $('#userPasswordSubmit');
  setButtonBusy(button, true, 'Menyimpan password…');
  try {
    const target = state.users.find(user => user.id === resetTargetId);
    if (!target?.email) throw new Error('Akun pengguna tidak ditemukan. Muat ulang halaman lalu coba lagi.');
    const credential = await PasswordCrypto.deriveWithRandomSalt($('#temporaryPassword').value);
    await api(`/users/${encodeURIComponent(resetTargetId)}/password`, {
      method: 'POST',
      body: { credential }
    });
    closeDialogs();
    form.reset();
    resetTargetId = '';
    await refreshOverview();
    renderApp();
    showToast('Password tersimpan. Sampaikan secara terpisah kepada pengguna.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function performPasswordChange(event) {
  event.preventDefault();
  const form = $('#passwordForm');
  if (!form.reportValidity()) return;
  const errorBox = $('#passwordError');
  const currentPassword = $('#currentPassword').value;
  const newPassword = $('#newPassword').value;
  if (newPassword !== $('#confirmPassword').value) {
    errorBox.textContent = 'Password baru tidak sama. Periksa kembali kedua kolom.';
    errorBox.hidden = false;
    $('#confirmPassword').focus();
    return;
  }
  errorBox.hidden = true;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Menyimpan password…');
  try {
    if (!state.user?.email) throw new Error('Sesi pengguna tidak tersedia. Masuk kembali lalu coba lagi.');
    const parameters = await api('/auth/password-parameters', {
      method: 'POST',
      body: { email: state.user.email }
    });
    const currentCredential = await PasswordCrypto.derive(currentPassword, parameters);
    const newCredential = await PasswordCrypto.deriveWithRandomSalt(newPassword);
    const newCurrentDerived = await PasswordCrypto.derive(newPassword, parameters);
    const result = await api('/account/password', {
      method: 'POST',
      body: { currentCredential, newCredential, newCurrentDerived: newCurrentDerived.derived }
    });
    state.user = result.user;
    await refreshOverview();
    currentPage = 'overview';
    renderApp();
    showToast('Password diperbarui.');
  } catch (error) {
    errorBox.textContent = friendlyError(error);
    errorBox.hidden = false;
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function performNewUser(event) {
  event.preventDefault();
  const form = $('#userForm');
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  const data = new FormData(form);
  setButtonBusy(button, true, 'Menyimpan akun…');
  try {
    await api('/users', { method: 'POST', body: {
      name: String(data.get('name')).trim(),
      email: String(data.get('email')).trim(),
      position: String(data.get('position') || '').trim()
    } });
    await refreshOverview();
    renderApp();
    showToast('Akun User dibuat. Atur password sementara sebelum akses diberikan.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

function newSubmissionKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto.getRandomValues !== 'function') {
    throw new ApiFailure(0, 'browser_unsupported', 'Browser ini belum mendukung pengiriman aman. Gunakan browser terbaru.');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function performNewSubmission(event) {
  event.preventDefault();
  const form = $('#reportForm');
  if (!form.reportValidity()) return;
  const button = form.querySelector('[type="submit"]');
  const data = new FormData(form);
  setButtonBusy(button, true, 'Mengirim pengajuan…');
  try {
    if (!submissionIdempotencyKey) submissionIdempotencyKey = newSubmissionKey();
    await api('/submissions', {
      method: 'POST',
      headers: { 'Idempotency-Key': submissionIdempotencyKey },
      body: {
        type: String(data.get('type')),
        amountIdr: Number(data.get('amountIdr')),
        date: String(data.get('date')),
        description: String(data.get('description')).trim(),
        note: String(data.get('note') || '').trim()
      }
    });
    submissionIdempotencyKey = '';
    let refreshed = true;
    try { await refreshOverview(); } catch (error) {
      if (error?.code === 'session_changed' || !state.user) return;
      refreshed = false;
    }
    currentPage = state.user.role === 'manager' ? 'overview' : 'my-reports';
    renderApp();
    showToast(!refreshed ? 'Pengajuan sudah tersimpan. Ringkasan belum diperbarui; muat ulang saat koneksi tersedia, jangan kirim ulang.' : state.user.role === 'manager' ? 'Pengajuan otomatis disetujui dan masuk rekap.' : 'Pengajuan terkirim dan tersimpan di akun Anda.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function downloadCsv(button) {
  if (state.user?.role !== 'manager') return;
  // Keep the native attachment click in the original user gesture on mobile
  // browsers whose download manager owns the response. Android WebView can
  // create blob URLs but does not reliably hand a programmatic blob click to
  // its download manager, so the native attachment link avoids that limitation.
  // A plain location navigation can render CSV inline in WebKit even when
  // Content-Disposition is attachment, so retain an explicit download attribute.
  // Desktop and full Android browsers keep the Blob path and its in-app error
  // handling.
  const userAgent = navigator.userAgent || '';
  const isMobileAppleBrowser = /iPhone|iPad|iPod/.test(userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(userAgent));
  const isAndroidWebView = /Android/i.test(userAgent)
    && (/;\s*wv\)/i.test(userAgent) || /\bwv\b/i.test(userAgent)
      || !/Chrome\/\d+/i.test(userAgent));
  if (isMobileAppleBrowser || isAndroidWebView) {
    const anchor = document.createElement('a');
    anchor.href = '/api/export.csv';
    anchor.download = `pangsuma-rekap-lengkap-${todayISO()}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return;
  }
  const requestEpoch = authEpoch;
  setButtonBusy(button, true, 'Menyiapkan rekap…');
  try {
    const response = await fetch('/api/export.csv', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { payload = {}; }
      const error = payload?.error || {};
      if (response.status === 401 && error.code === 'authentication_required' && state.user && requestEpoch === authEpoch) {
        showLogin('Sesi Anda berakhir. Silakan masuk kembali.');
      }
      if (requestEpoch !== authEpoch) throw new ApiFailure(401, 'session_changed', 'Sesi telah berubah. Masuk kembali untuk melanjutkan.');
      throw new ApiFailure(response.status, error.code || 'request_failed', error.message || 'Rekap lengkap tidak dapat dibuat.');
    }
    if (requestEpoch !== authEpoch || !state.user) return;
    const blob = await response.blob();
    if (requestEpoch !== authEpoch || !state.user) return;
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `pangsuma-rekap-lengkap-${todayISO()}.csv`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('Rekap siap; periksa unduhan browser untuk file CSV.');
  } catch (error) {
    if (error.code !== 'session_changed') showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function loadMoreHistory(collection, button) {
  const config = {
    submissions: { endpoint: 'submissions', stateKey: 'submissions', responseKey: 'submissions' },
    cashLedger: { endpoint: 'cash-ledger', stateKey: 'cashLedger', responseKey: 'cashLedger' },
    auditEvents: { endpoint: 'audit-events', stateKey: 'auditEvents', responseKey: 'auditEvents' }
  }[collection];
  const page = state.history?.[collection];
  if (!config || !page?.hasMore || !page.nextCursor || !state.user) return;
  const requestedUserId = state.user.id;
  const requestEpoch = authEpoch;
  setButtonBusy(button, true, 'Memuat riwayat…');
  try {
    const cursor = encodeURIComponent(page.nextCursor);
    const result = await api(`/history/${config.endpoint}?cursor=${cursor}`);
    if (requestEpoch !== authEpoch || !state.user || state.user.id !== requestedUserId) return;
    const additions = Array.isArray(result[config.responseKey]) ? result[config.responseKey] : [];
    state[config.stateKey] = [...state[config.stateKey], ...additions];
    state.history[collection] = {
      nextCursor: result.nextCursor || null,
      hasMore: Boolean(result.hasMore),
      total: Number(result.total || 0),
      loaded: Number(page.loaded || 0) + additions.length
    };
    renderApp();
    document.querySelector(`[data-action="load-more-history"][data-collection="${collection}"]`)?.focus({ preventScroll: true });
  } catch (error) {
    if (error.code !== 'session_changed') showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === 'load-more-history') {
    await loadMoreHistory(button.dataset.collection, button);
  } else if (action === 'open-report-choice') {
    if (!['user', 'manager'].includes(state.user?.role) || state.user.mustChangePassword) return;
    $('#reportChoiceDescription').textContent = state.user?.role === 'manager'
      ? 'Pengajuan otomatis disetujui. Petty cash langsung mengurangi saldo yang tersedia; Request Finance langsung menunggu Finance.'
      : 'Saldo petty cash berkurang setelah disetujui Manager. Request Finance masuk setelah persetujuan.';
    openDialog('reportChoice');
  } else if (action === 'choose-report-type') {
    reportTypePreset = button.dataset.type === 'finance_request' ? 'finance_request' : 'petty_cash';
    $('#reportChoice').close();
    currentPage = 'new-report';
    renderApp();
  } else if (action === 'close-dialog') {
    if (button.closest('#userProfileDialog') && profileDraft?.saving) return;
    button.closest('dialog')?.close();
  } else if (action === 'edit-user-profile') {
    openUserProfile(id);
  } else if (action === 'choose-profile-photo') {
    // The user taps the native file input covering its label. Do not synthesize
    // click/showPicker: mobile WebKit/WebView can ignore those without an error.
    return;
  } else if (action === 'remove-profile-photo') {
    if (!profileDraft || profileDraft.saving || profileDraft.processing) return;
    profileDraft.photoDataUrl = null;
    $('#profilePhotoStatus').textContent = 'Foto akan dihapus setelah Simpan profil ditekan.';
    renderProfilePreview();
  } else if (action === 'approve') {
    const item = state.submissions.find(entry => entry.id === id);
    if (!item || item.createdBy === state.user.id) return;
    if (item.type === 'petty_cash' && item.amountIdr > state.cashBalanceIdr) {
      showToast('Saldo petty cash tidak mencukupi.');
      return;
    }
    const description = item.type === 'petty_cash'
      ? `${money(item.amountIdr)} akan dipotong dari saldo petty cash setelah persetujuan. Keputusan akan tercatat di ledger.`
      : `${money(item.amountIdr)} akan disetujui dan masuk ke daftar Finance. Keputusan akan tercatat.`;
    setConfirm('approve', 'Setujui pengajuan?', `${item.description}. ${description}`, item.type === 'petty_cash' ? 'Setujui & kurangi saldo' : 'Setujui request', false, { id, successMessage: item.type === 'petty_cash' ? 'Pengajuan disetujui dan debit tercatat di ledger.' : 'Request disetujui dan masuk ke Finance.' });
  } else if (action === 'reject') {
    const item = state.submissions.find(entry => entry.id === id);
    if (!item || item.createdBy === state.user.id) return;
    $('#rejectForm').dataset.id = id;
    $('#rejectDescription').textContent = `${item.description} · ${money(item.amountIdr)}. Beri alasan agar keputusan dapat ditinjau kembali.`;
    $('#rejectReason').value = '';
    openDialog('rejectDialog');
    $('#rejectReason').focus();
  } else if (action === 'send-finance') {
    const item = state.submissions.find(entry => entry.id === id);
    if (!item || item.type !== 'finance_request' || item.status !== 'approved') return;
    setConfirm('send', 'Tandai terkirim ke Finance?', `${item.description} · ${money(item.amountIdr)}. Status akan berubah menjadi terkirim dan tercatat.`, 'Tandai terkirim', false, { id, successMessage: 'Status Request Finance diperbarui.' });
  } else if (action === 'open-add-user') {
    const card = $('#addUserCard');
    if (card) { card.hidden = false; $('#userName').focus(); }
  } else if (action === 'cancel-add-user') {
    const card = $('#addUserCard');
    if (card) card.hidden = true;
    $('#userForm')?.reset();
  } else if (action === 'reset-user-password') {
    resetTargetId = id;
    $('#userPasswordDescription').textContent = `Atur password sementara untuk ${button.dataset.name || 'akun User'}. Password tidak dikirim melalui email; pengguna wajib menggantinya saat masuk.`;
    $('#userPasswordForm').reset();
    openDialog('userPasswordDialog');
    $('#temporaryPassword').focus();
  } else if (action === 'deactivate-user') {
    setConfirm('deactivate', 'Nonaktifkan akses pengguna?', `${button.dataset.name || 'Pengguna'} tidak dapat masuk lagi. Riwayat laporan tetap tersimpan dan aksi ini dicatat.`, 'Nonaktifkan akses', true, { id, successMessage: 'Akses akun dinonaktifkan; riwayat tetap tersimpan.' });
  } else if (action === 'download-csv') {
    await downloadCsv(button);
  } else if (action === 'open-opening-balance') {
    if (state.user?.role !== 'manager') return;
    const openingExists = state.cashLedger.some(event => event.event_type === 'opening_balance' && Number(event.amount_idr) > 0);
    if (openingExists) { showToast('Saldo awal sudah ditetapkan.'); return; }
    $('#openingBalanceForm').reset();
    openDialog('openingBalanceDialog');
    $('#openingAmount').focus();
  }
}

async function logout() {
  const button = $('#logoutButton');
  const requestEpoch = authEpoch;
  closeDialogs();
  $$('input[type="password"]').forEach(input => { input.value = ''; });
  $$('dialog form').forEach(form => form.reset());
  setButtonBusy(button, true, 'Keluar…');
  try {
    await api('/logout', { method: 'POST' });
    if (requestEpoch !== authEpoch) return;
    showLogin('');
    showToast('Anda berhasil keluar.');
  } catch (error) {
    if (!state.user) {
      showToast('Sesi di server sudah berakhir. Silakan masuk kembali.');
    } else if (requestEpoch === authEpoch) {
      showToast('Keluar belum terkonfirmasi. Sesi Anda masih aktif; coba lagi.');
    }
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

function bindEvents() {
  document.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton && state.user) {
      const page = pageButton.dataset.page;
      if (state.user.mustChangePassword && page !== 'change-password') return;
      currentPage = page;
      renderApp();
      $('#mainContent').focus({ preventScroll: true });
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) await handleAction(actionButton);
  });

  document.addEventListener('submit', async event => {
    if (event.target.id === 'loginForm') await performLogin(event);
    else if (event.target.id === 'managerRecoveryForm') await registerPasskeyFromForm(event, {
      optionsPath: '/passkeys/manager-recovery/options',
      verifyPath: '/passkeys/manager-recovery/verify',
      readPayload: () => ({ secret: $('#managerRecoverySecret').value }),
      busyText: 'Mengaktifkan passkey…',
      autoLogin: false,
      refreshApp: false,
      successMessage: 'Passkey Manager terdaftar. Masuk dengan passkey untuk melanjutkan.'
    });
    else if (event.target.id === 'reportForm') await performNewSubmission(event);
    else if (event.target.id === 'userForm') await performNewUser(event);
    else if (event.target.id === 'passwordForm') await performPasswordChange(event);
    else if (event.target.id === 'rejectForm') await performReject(event);
    else if (event.target.id === 'userPasswordForm') await performUserPasswordReset(event);
    else if (event.target.id === 'userProfileForm') await performUserProfileSave(event);
    else if (event.target.id === 'openingBalanceForm') await performOpeningBalance(event);
    else if (event.target.id === 'confirmForm') { event.preventDefault(); await performConfirmedAction(); }
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'loginIdentifier' || event.target.id === 'loginPassword') {
      $('#loginError').hidden = true;
    }
    if (event.target.id === 'archiveSearch') {
      state.archiveSearch = event.target.value;
      const result = $('#archiveResults');
      if (result) {
        const selectionStart = event.target.selectionStart;
        const selectionEnd = event.target.selectionEnd;
        const updated = myReportsPage();
        $('#appContent').innerHTML = updated;
        const search = $('#archiveSearch');
        search.focus();
        search.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  });

  document.addEventListener('click', event => {
    const filter = event.target.closest('[data-report-filter]');
    if (filter) {
      state.archiveType = filter.dataset.reportFilter;
      renderApp();
    }
    const dialog = event.target;
    if (dialog.id === 'userProfileDialog' && profileDraft?.saving) return;
    if (dialog instanceof HTMLDialogElement && event.target === dialog) dialog.close();
  });

  document.addEventListener('error', event => {
    if (event.target.matches?.('.welcome-avatar img, .user-initial img')) event.target.remove();
  }, true);
  $('#profilePhoto').addEventListener('change', event => prepareProfilePhoto(event.target.files?.[0]));
  $('#userProfileDialog').addEventListener('cancel', event => {
    if (profileDraft?.saving) event.preventDefault();
  });
  $('#userProfileDialog').addEventListener('close', () => {
    profileSelection += 1;
    profileDraft = null;
    $('#userProfileForm').reset();
    $('#profilePreview').replaceChildren();
    $('#profileError').hidden = true;
    $('#profileSubmit').disabled = false;
  });
  window.addEventListener('focus', () => { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(); });
  window.addEventListener('pageshow', () => { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(); });
  window.addEventListener('online', () => { refreshProfile(); requestManagerOverviewRefresh(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(); }
  });
  window.setInterval(() => {
    if (!document.hidden) { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(); }
  }, managerSyncIntervalMs);

  $('#logoutButton').addEventListener('click', logout);
  $('#passkeyLoginButton').addEventListener('click', () => performPasskeyLogin());
  $('#reportChoice').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#installButton').addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const result = await installPrompt.userChoice;
      installPrompt = null;
      showToast(result.outcome === 'accepted' ? 'Pangsuma App dipasang.' : 'Pemasangan belum dilakukan.');
    } else showToast('Gunakan menu browser lalu pilih Tambahkan ke layar utama.');
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  $('#confirmDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#rejectDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#userPasswordDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#openingBalanceDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
}

async function performOpeningBalance(event) {
  event.preventDefault();
  const form = $('#openingBalanceForm');
  if (!form.reportValidity()) return;
  const button = $('#openingBalanceSubmit');
  setButtonBusy(button, true, 'Mencatat saldo…');
  try {
    const result = await api('/cash/opening-balance', {
      method: 'POST',
      body: { amountIdr: Number($('#openingAmount').value), ownerConfirmed: $('#ownerConfirmed').checked }
    });
    closeDialogs();
    await refreshOverview();
    renderApp();
    showToast(result.alreadyApplied ? 'Saldo awal ini sudah pernah dicatat.' : 'Saldo awal dan audit tersimpan.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function performLogin(event) {
  event.preventDefault();
  const form = $('#loginForm');
  if (!form.reportValidity()) return;
  const button = $('#loginSubmit');
  const email = $('#loginIdentifier').value.trim();
  const password = $('#loginPassword').value;
  setButtonBusy(button, true, 'Memeriksa akun…');
  try {
    const parameters = await api('/auth/password-parameters', { method: 'POST', body: { email } });
    const credential = await PasswordCrypto.derive(password, parameters);
    const result = await api('/login', { method: 'POST', body: { email, credential } });
    await completeLogin(result, form);
  } catch (error) {
    $('#loginError').textContent = friendlyError(error);
    $('#loginError').hidden = false;
    $('#loginPassword').value = '';
    $('#loginPassword').focus();
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function initialize() {
  bindEvents();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js')
      .then(registration => registration.update())
      .catch(() => {}));
  }
  await refreshPasskeyControls();
  try {
    const result = await api('/session');
    state.user = result.user;
    if (state.user.mustChangePassword) {
      state.cashBalanceIdr = 0;
      state.submissions = [];
      state.users = [];
      state.cashLedger = [];
      state.auditEvents = [];
      currentPage = 'change-password';
    } else {
      await refreshOverview();
      currentPage = 'overview';
    }
    renderApp();
    hidePreloader();
  } catch (error) {
    showLogin(error.status === 401 ? '' : 'Layanan belum siap. Jangan gunakan data operasional sampai koneksi server tersedia.');
    hidePreloader();
  }
}

initialize();
