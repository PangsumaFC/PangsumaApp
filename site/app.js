'use strict';
let activeApiTransactions = 0;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const money = value => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', maximumFractionDigits: 0
}).format(typeof value === 'bigint' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : Number(value) || 0);
const compactMoney = value => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR', notation: 'compact', maximumFractionDigits: 1
}).format(Number(value) || 0).replace(/\s/g, '');
const APP_BUILD = document.querySelector('meta[name="app-build"]')?.content || '';
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
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta', timeZoneName: 'short'
  }).format(date);
};
const dateTimeWibFull = value => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Waktu tidak tersedia';
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Jakarta', timeZoneName: 'short'
  }).format(date);
};
const monthLabel = key => {
  const [year, month] = String(key).split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
};
const reportTypeLabel = type => type === 'petty_cash' ? 'Petty Cash' : 'Request Finance';

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
    { id: 'finance', label: 'Laporan Finance', icon: 'finance' }
  ],
  user: [
    { id: 'overview', label: 'Beranda', icon: 'overview' },
    { id: 'new-report', label: 'Buat laporan', icon: 'plus' },
    { id: 'my-reports', label: 'Laporan saya', icon: 'report' }
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
  pendingSubmissions: [],
  pendingPage: { cursor: '', nextCursor: '', total: 0, hasMore: false, hasPrevious: false, loading: false, error: '' },
  users: [],
  usersPage: { page: 1, limit: 5, total: 0, hasMore: false, query: '', loading: false, error: '' },
  cashLedger: [],
  auditEvents: [],
  summary: {},
  history: emptyHistory(),
  archiveType: 'all',
  archiveSearch: '',
  cashInsights: null,
  cashInsightsDailyLimit: 14
};
let currentPage = 'overview';
let lastRenderedPage = '';
let authEpoch = 0;
let pendingRequestGeneration = 0;
// Navigation history is deliberately a small, session-scoped view state. Never
// put report, finance, or identity data in the URL/history entry.
let navigationSession = '';
let navigationHandlingPop = false;
const navigationPages = new Set(['overview', 'approvals', 'finance', 'users', 'my-reports', 'change-password', 'new-report', 'cash-info']);
function navigationHistoryAvailable() {
  return typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function' && typeof window.history.replaceState === 'function' && typeof window.addEventListener === 'function';
}
function navigationState(page = currentPage) {
  return { pangsumaNavigation: true, session: navigationSession, page: navigationPages.has(page) ? page : 'overview' };
}
function navigationPageAllowed(page) {
  if (!state.user || !navigationPages.has(page)) return false;
  if (state.user.mustChangePassword) return page === 'change-password';
  const allowed = state.user.role === 'manager'
    ? ['overview', 'approvals', 'finance', 'users', 'change-password', 'new-report']
    : ['overview', 'my-reports', 'change-password', 'new-report'];
  return allowed.includes(page);
}
function resetNavigationSession(page = 'overview') {
  navigationSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  if (!navigationHistoryAvailable()) return;
  try { window.history.replaceState(navigationState(page), '', window.location.href); } catch {}
}
function navigateToPage(page, { replace = false, fromPop = false } = {}) {
  if (!navigationPageAllowed(page)) return false;
  const changed = currentPage !== page;
  const profileDialog = typeof document !== 'undefined' ? document.querySelector('#userProfileDialog[open]') : null;
  if (changed && profileDialog?.id === 'userProfileDialog' && !canCloseAppDialog(profileDialog)) return false;
  if (changed && profileDialog?.id === 'userProfileDialog') profileDialog.close();
  currentPage = page;
  if (changed && typeof usersPageLifecycle !== 'undefined') usersPageLifecycle.cancel();
  if (changed && page === 'users' && state.user?.role === 'manager') {
    state.usersPage = { ...state.usersPage, loading: true, error: '' };
  }
  if (navigationHistoryAvailable() && !fromPop && changed) {
    try {
      const method = replace ? 'replaceState' : 'pushState';
      window.history[method](navigationState(page), '', window.location.href);
    } catch {}
  }
  renderApp();
  if (page === 'users' && state.user?.role === 'manager' && typeof loadUsersPageView === 'function') void loadUsersPageView();
  if (page === 'approvals' && state.user?.role === 'manager') void loadPendingPage('first');
  return true;
}
function handleNavigationPop(event) {
  if (navigationHandlingPop) { navigationHandlingPop = false; return; }
  const profileDialog = typeof document !== 'undefined' ? document.querySelector('#userProfileDialog[open]') : null;
  if (profileDialog?.id === 'userProfileDialog') {
    if (!canCloseAppDialog(profileDialog)) {
      if (navigationHistoryAvailable()) { navigationHandlingPop = true; try { window.history.forward(); } catch { navigationHandlingPop = false; } }
      return;
    }
    profileDialog.close();
    if (navigationHistoryAvailable()) { navigationHandlingPop = true; try { window.history.forward(); } catch { navigationHandlingPop = false; } }
    return;
  }
  const reportDialog = typeof document !== 'undefined' ? document.querySelector('#reportActivityDialog[open]') : null;
  if (reportDialog) {
    if (!canCloseReportActivity(reportDialog)) {
      if (navigationHistoryAvailable()) { navigationHandlingPop = true; try { window.history.forward(); } catch { navigationHandlingPop = false; } }
      return;
    }
    reportDialog.close();
    // The detail dialog is not a page: restore the underlying page entry after
    // consuming Back, rather than unexpectedly navigating behind the dialog.
    if (navigationHistoryAvailable()) { navigationHandlingPop = true; try { window.history.forward(); } catch { navigationHandlingPop = false; } }
    return;
  }
  const entry = event?.state;
  if (!state.user || !entry?.pangsumaNavigation || entry.session !== navigationSession || !navigationPages.has(entry.page)) {
    // A pre-app/document entry is intentionally left to the browser (native
    // Back/exit). Protected historical entries are not allowed to reopen.
    if (state.user && navigationHistoryAvailable()) { try { window.history.replaceState(navigationState(currentPage), '', window.location.href); } catch {} }
    return;
  }
  if (hasUnsavedDraft() && !window.confirm('Masih ada draf atau nota yang belum dikirim. Tetap berpindah halaman?')) {
    if (navigationHistoryAvailable()) { navigationHandlingPop = true; try { window.history.forward(); } catch { navigationHandlingPop = false; } }
    return;
  }
  navigateToPage(entry.page, { fromPop: true });
}

let reportTypePreset = 'petty_cash';
let submissionIdempotencyKey = '';
let cashTopupIdempotencyKey = '';
let cashTopupFingerprint = '';
let cashTopupBusy = false;
let toastTimer = 0;
let confirmAction = null;
let resetTargetId = '';
let profileDraft = null;
let profileSelection = 0;
let profileSyncBusy = false;
let managerSyncBusy = false;
let managerSyncLastAt = 0;
let managerSyncRerenderPending = false;
let archiveSearchTimer = 0;
let usersSearchTimer = 0;
let cashInsightsRequestEpoch = 0;
let cashInsightsRequestBusy = false;
let cashInsightsCacheKey = '';
let cashInsightsCachedAt = 0;
const managerSyncIntervalMs = 20_000;
const managerSyncMinIntervalMs = 15_000;
let updateCheckBusy = false;
let availableBuild = '';
const updateCheckIntervalMs = 60_000;
let appUpdates = null;
function draftKey(kind, type = '') { return `pangsuma:${kind}:${state.user?.id || 'anonymous'}:${type || 'default'}`; }
function readDraft(kind, type = '') { try { const raw = sessionStorage.getItem(draftKey(kind, type)); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function writeDraft(kind, type, value) { try { sessionStorage.setItem(draftKey(kind, type), JSON.stringify(value)); } catch {} }
function clearDraft(kind, type = '') { try { sessionStorage.removeItem(draftKey(kind, type)); } catch {} }
function reportDraft(type = reportTypePreset) { return readDraft('report', type) || {}; }
function validReportType(type) { return type === 'petty_cash' || type === 'finance_request'; }
function restoreReportType() {
  const saved = readDraft('report-selection');
  if (validReportType(saved?.type)) return saved.type;
  // Upgrade older sessions without selection metadata without deleting either draft.
  return readDraft('report', 'finance_request') && !readDraft('report', 'petty_cash') ? 'finance_request' : 'petty_cash';
}
function rememberReportType(type) {
  if (state.user && validReportType(type)) writeDraft('report-selection', '', { type });
}
function persistReportDraft(type = reportTypePreset) {
  const form = $('#reportForm');
  if (!state.user || !form || !validReportType(type)) return;
  writeDraft('report', type, { type, amountIdr: String(form.amountIdr?.value || '').slice(0, 20), date: String(form.date?.value || '').slice(0, 10), description: String(form.description?.value || '').slice(0, 150), note: String(form.note?.value || '').slice(0, 500), idempotencyKey: submissionIdempotencyKey || reportDraft(type).idempotencyKey || '', submittedFingerprint: reportDraft(type).submittedFingerprint || '' });
  rememberReportType(type);
}
function persistCashTopupDraft() { if (!state.user || !$('#cashTopupForm')) return; writeDraft('cash-topup', '', { amountIdr: String($('#cashTopupAmount')?.value || '').slice(0, 20), note: String($('#cashTopupNote')?.value || '').slice(0, 500), idempotencyKey: cashTopupIdempotencyKey || '', fingerprint: cashTopupFingerprint || '' }); }

function profileDraftDirty() {
  if (!profileDraft || profileDraft.loading || !profileDraft.target) return false;
  const form = typeof document !== 'undefined' ? document.querySelector('#userProfileForm') : null;
  if (!form) return false;
  const value = selector => String(form.querySelector(selector)?.value || '').trim();
  const baseline = profileDraft.baseline || {};
  return value('#profileNickname') !== String(baseline.nickname || '')
    || value('#profilePosition') !== String(baseline.position || '')
    || value('#profileQuote') !== String(baseline.quote || '')
    || profileDraft.photoDataUrl !== undefined;
}
function formDraftIsStored(form) {
  if (!state.user || !form?.elements) return false;
  const value = name => String(form.elements.namedItem(name)?.value || '');
  if (form.id === 'reportForm') {
    const type = value('type'), draft = readDraft('report', type);
    return validReportType(type) && draft?.type === type
      && ['amountIdr', 'date', 'description', 'note'].every(name => value(name) === String(draft[name] ?? ''));
  }
  if (form.id === 'userForm' && state.user.role === 'manager') {
    const draft = readAccountDraft();
    return Boolean(draft && ['name', 'email', 'position'].every(name => value(name) === String(draft[name] ?? '')));
  }
  return false;
}
function hasUnsavedDraft() {
  if (typeof ReportEvidence !== 'undefined' && ReportEvidence.hasPending?.()) return true;
  if (profileDraft?.photoDataUrl !== undefined) return true;
  if (typeof profileDraftDirty === 'function' && profileDraftDirty()) return true;
  if ([...document.querySelectorAll('input[type="file"]')].some(field => field.files?.length && (!field.closest?.('dialog') || field.closest('dialog').open) && !field.closest?.('[hidden]'))) return true;
  return [...document.querySelectorAll('form:not(#loginForm)')].some(form => {
    const dialog = form.closest('dialog');
    if ((dialog && !dialog.open) || form.closest('[hidden]')) return false;
    if (dialog?.id === 'userProfileDialog' && typeof profileDraftDirty === 'function') return false;
    if (typeof formDraftIsStored === 'function' && formDraftIsStored(form)) return false;
    return [...form.elements].some(field => {
      if (field.disabled || ['submit', 'button', 'hidden'].includes(field.type)) return false;
      if (field.type === 'file') return Boolean(field.files?.length);
      if (['checkbox', 'radio'].includes(field.type)) return field.checked !== field.defaultChecked;
      if (field.tagName === 'SELECT') return [...field.options].some(option => option.selected !== option.defaultSelected);
      return String(field.value || '') !== String(field.defaultValue || '');
    });
  });
}

function transactionInFlight() {
  return Boolean((typeof ReportEvidence !== 'undefined' && ReportEvidence.isBusy?.()) || (typeof activeApiTransactions !== 'undefined' && activeApiTransactions > 0) || profileDraft?.saving || profileDraft?.processing || document.querySelector('[aria-busy="true"]'));
}

function setUpdateBanner(build = '') {
  const candidate = String(build || '');
  availableBuild = /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(candidate)
    && candidate.localeCompare(APP_BUILD, 'en', { numeric: true }) > 0 ? candidate : '';
  const banner = $('#appUpdateBanner');
  if (!banner) return;
  const visible = Boolean(availableBuild);
  banner.hidden = !visible;
  if (visible) $('#appUpdateVersion').textContent = `Versi ${availableBuild} tersedia.`;
}

async function checkForAppUpdate(options = {}) {
  if (typeof appUpdates !== 'undefined' && appUpdates) return appUpdates.check(options);
  if (updateCheckBusy || document.hidden || navigator.onLine === false) return false;
  updateCheckBusy = true;
  try {
    const response = await fetch(`/version.json?check=${Date.now()}`, {
      cache: 'no-store', credentials: 'same-origin', headers: { 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) return false;
    const payload = await response.json();
    const build = payload?.build || payload?.version;
    setUpdateBanner(build);
    return Boolean(availableBuild);
  } catch {
    return false;
  } finally {
    updateCheckBusy = false;
  }
}

async function reloadToLatestBuild() {
  if (transactionInFlight()) {
    showToast('Sedang menyimpan transaksi. Tunggu sampai selesai sebelum memuat ulang.');
    return;
  }
  if (hasUnsavedDraft() && !window.confirm('Ada draf yang belum disimpan. Muat ulang tetap dilakukan dan draf akan hilang?')) return;
  const button = $('#appUpdateReload');
  if (button) button.disabled = true;
  try {
    if (typeof appUpdates !== 'undefined' && appUpdates) {
      const reloaded = await appUpdates.reload();
      if (!reloaded) {
        if (button) button.disabled = false;
        showToast('Pembaruan belum siap atau proses penyimpanan masih berjalan. Tunggu sebentar lalu coba lagi.');
      }
      return;
    }
    const registration = await navigator.serviceWorker?.getRegistration?.();
    await registration?.update?.();
  } catch { /* Navigasi network-first tetap tersedia ketika SW gagal diperiksa. */ }
  window.location.reload();
}

function profileAvatar(user, className = 'welcome-avatar') {
  const name = user.nickname || user.name || 'Pengguna';
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  return `<span class="${className}" aria-hidden="true"><span>${escapeHTML(initials)}</span>${user.photoUrl ? `<img src="${escapeHTML(user.photoUrl)}" alt="" width="80" height="80">` : ''}</span>`;
}

function welcomeClock(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return {
    greeting: hour < 5 ? 'Selamat malam' : hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 18 ? 'Selamat sore' : 'Selamat malam',
    date: new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)
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

function cashInsightInteger(value) {
  try { return typeof value === 'bigint' ? value : BigInt(String(value ?? '0')); } catch { return 0n; }
}
function cashInsightMoney(value) { return money(cashInsightInteger(value)); }
function cashInsightMinimumKey() { return `pangsuma:cash-minimum-idr:${state.user?.id || 'anonymous'}`; }
function cashInsightMinimumSource(insight = state.cashInsights) {
  try {
    const stored = localStorage.getItem(cashInsightMinimumKey());
    if (stored !== null && /^\d+$/.test(stored)) return 'local';
  } catch {}
  return insight?.minimumIdr === null || insight?.minimumIdr === undefined ? 'none' : 'server';
}
function getCashInsightMinimum(insight = state.cashInsights) {
  try {
    const stored = localStorage.getItem(cashInsightMinimumKey());
    if (stored !== null && /^\d+$/.test(stored)) return stored;
  } catch {}
  return insight?.minimumIdr === null || insight?.minimumIdr === undefined ? null : String(insight.minimumIdr);
}
function cashInsightThresholdLabel(insight) {
  const value = getCashInsightMinimum(insight);
  return value === null ? 'Belum diatur' : cashInsightMoney(value);
}
function cashInsightThresholdSourceLabel(insight) {
  const source = cashInsightMinimumSource(insight);
  return source === 'local' ? 'Batas minimum perangkat ini (lokal)' : source === 'server' ? 'Batas default server' : 'Batas minimum perangkat ini (lokal)';
}
function cashInsightTrendText(insight) {
  if (!insight?.trend) return 'Belum ada data tren.';
  const current = cashInsightInteger(insight.trend.outgoingIdr);
  const previous = cashInsightInteger(insight.trend.precedingOutgoingIdr);
  if (previous === 0n) return 'Belum ada pembanding';
  const difference = current - previous;
  const magnitude = difference < 0n ? -difference : difference;
  const tenths = (magnitude * 1000n + previous / 2n) / previous;
  return `${difference < 0n ? '-' : difference > 0n ? '+' : ''}${tenths / 10n},${tenths % 10n}% dibanding 30 hari sebelumnya`;
}

function cashInsightDailyRows(insight, limit = 14) {
  const rows = Array.isArray(insight?.daily) ? [...insight.daily].sort((a,b) => String(a.day).localeCompare(String(b.day))) : [];
  return rows.map(row => ({...row, openingIdr: String(row.openingIdr ?? '0'), endingIdr: String(row.closingIdr ?? row.endingIdr ?? '0')})).slice(-limit).reverse();
}
function cashInsightsRegion() {
  const insight = state.cashInsights;
  if (!insight) return `<section class="cash-insights-region" aria-label="Kesehatan Petty Cash"><p class="field-help">${state.cashInsightsError ? escapeHTML(state.cashInsightsError) : 'Memuat kesehatan Petty Cash…'}</p>${state.cashInsightsError ? '<button class="secondary-button" type="button" data-action="refresh-cash-insights">Coba lagi</button>' : ''}</section>`;
  const totals = insight.totals || {};
  const account = cashInsightInteger(insight.account?.balanceIdr);
  const expected = cashInsightInteger(insight.accounting?.expectedBalanceIdr);
  const discrepancy = cashInsightInteger(insight.accounting?.discrepancyIdr);
  const balanced = insight.accounting?.isBalanced === true;
  const rows = cashInsightDailyRows(insight, state.cashInsightsDailyLimit || 14);
  const coverage = insight.trend?.window ? `${dateLong(insight.trend.window.start)} – ${dateLong(insight.trend.window.end)}` : '30 hari terakhir';
  const window = insight.trend?.window || {};
  const chartRows = (insight.trend?.days || []).filter(row => row.day >= window.start && row.day <= window.end);
  const maximum = chartRows.reduce((value, row) => cashInsightInteger(row.outgoingIdr) > value ? cashInsightInteger(row.outgoingIdr) : value, 0n);
  const bars = chartRows.map((row, index) => {
    const height = maximum > 0n ? Number(cashInsightInteger(row.outgoingIdr) * 6000n / maximum) / 100 : 0;
    return `<rect x="${index * (100 / Math.max(1, chartRows.length)) + 0.2}" y="${76 - height}" width="${88 / Math.max(1, chartRows.length)}" height="${height}" rx="0.3" aria-hidden="true"></rect>`;
  }).join('');
  const minimum = getCashInsightMinimum(insight);
  const minimumStatus = minimum === null ? 'Belum ada batas peringatan' : account < cashInsightInteger(minimum) ? 'Di bawah batas minimum' : 'Batas minimum terpenuhi';
  const equation = `<dl class="cash-health-equation"><div><dt>Saldo awal</dt><dd>${cashInsightMoney(totals.openingIdr)}</dd></div><span aria-hidden="true">+</span><div><dt>Penambahan</dt><dd>${cashInsightMoney(totals.topupsIdr)}</dd></div><span aria-hidden="true">−</span><div><dt>Pengeluaran</dt><dd>${cashInsightMoney(totals.outgoingIdr)}</dd></div><span aria-hidden="true">=</span><div><dt>Saldo hitung</dt><dd>${cashInsightMoney(expected)}</dd></div></dl>`;
  return `<section class="cash-insights-region" aria-label="Kesehatan Petty Cash"><article class="cash-health-card"><div><p class="cash-insights-kicker">Kesehatan saldo</p><h2>${balanced ? 'Saldo terekonsiliasi' : 'Perlu rekonsiliasi'}</h2>${equation}<p class="cash-health-status">Saldo akun ${cashInsightMoney(account)} · Ekspektasi ${cashInsightMoney(expected)} · Selisih ${cashInsightMoney(discrepancy)}</p></div><div class="cash-health-threshold"><span>${cashInsightThresholdSourceLabel(insight)}</span><strong>${cashInsightThresholdLabel(insight)}</strong><p class="cash-minimum-status" role="status">${escapeHTML(minimumStatus)}</p><button class="text-button" type="button" data-action="configure-cash-minimum" aria-expanded="false" aria-controls="cashMinimumForm">Atur batas</button><form id="cashMinimumForm" class="cash-minimum-form" hidden><label for="cashMinimumInput">Batas minimum perangkat ini (lokal, Rp)</label><input id="cashMinimumInput" name="minimumIdr" inputmode="numeric" pattern="[0-9]*" maxlength="16" value="${escapeHTML(getCashInsightMinimum(insight) || '')}" aria-describedby="cashMinimumHelp"><span id="cashMinimumHelp" class="field-help">Simpan hanya di perangkat ini. Kosongkan untuk menghapus.</span><div class="form-actions"><button class="primary-button" type="submit">Simpan</button><button class="secondary-button" type="button" data-action="clear-cash-minimum">Hapus batas</button></div></form></div></article><article class="cash-trend-card"><div class="section-row"><div><h2>Arus keluar</h2><p>${cashInsightMoney(insight.trend?.outgoingIdr || '0')} · ${coverage}</p></div><strong class="cash-trend-change">${escapeHTML(cashInsightTrendText(insight))}</strong></div><details><summary>Lihat grafik dan rincian harian</summary><p class="cash-chart-caption">Arus keluar per hari, WIB. Nilai grafik diskalakan hanya untuk visual; angka pada tabel disajikan presisi.</p><svg class="cash-trend-chart" viewBox="0 0 100 82" role="img" aria-labelledby="cashTrendTitle"><title id="cashTrendTitle">Grafik arus keluar 30 hari hingga ${escapeHTML(insight.trend?.window?.end || '')}</title><line x1="0" y1="76" x2="100" y2="76"></line>${bars}</svg><div class="cash-chart-legend"><span><i aria-hidden="true"></i> Pengeluaran</span><span>Total: ${cashInsightMoney(insight.trend?.outgoingIdr || '0')}</span><span>Periode: ${escapeHTML(coverage)}</span><span>Sebelumnya: ${cashInsightMoney(insight.trend?.precedingOutgoingIdr || '0')} (${escapeHTML(window.previousStart || '')} – ${escapeHTML(window.previousEnd || '')} WIB)</span></div><div class="table-wrap"><table class="cash-daily-table"><caption>Ledger per hari · Seluruh riwayat (WIB)</caption><thead><tr><th scope="col">Tanggal</th><th scope="col">Pembukaan</th><th scope="col">Masuk</th><th scope="col">Keluar</th><th scope="col">Saldo akhir</th></tr></thead><tbody>${rows.map(r => `<tr><th scope="row">${escapeHTML(dateLong(r.day))}</th><td>${cashInsightMoney(r.openingIdr)}</td><td>${cashInsightMoney(r.incomingIdr)}</td><td>${cashInsightMoney(r.outgoingIdr)}</td><td>${cashInsightMoney(r.endingIdr)}</td></tr>`).join('') || '<tr><td colspan="5">Belum ada aktivitas pada periode ini.</td></tr>'}</tbody></table></div><p class="field-help">Menampilkan ${rows.length} hari terbaru dari ${Array.isArray(insight.daily) ? insight.daily.length : rows.length} hari yang tersedia dari server.</p>${Array.isArray(insight.daily) && rows.length < insight.daily.length ? '<button class="secondary-button" type="button" data-action="load-more-cash-days">Muat hari berikutnya</button>' : ''}</details></article></section>`;
}
function renderCashInsightsRegion(force = false) {
  const form = $('#cashMinimumForm');
  if (!force && form && !form.hidden) return;
  const region = $('.cash-insights-region');
  if (region && currentPage === 'finance' && state.user?.role === 'manager') region.outerHTML = cashInsightsRegion();
}
async function loadCashInsights({ force = false } = {}) {
  if (!state.user || state.user.role !== 'manager' || state.user.mustChangePassword || cashInsightsRequestBusy) return;
  const cacheKey = `${authEpoch}:${state.user.id}:${state.cashLedgerAnchorId ?? state.cashLedger?.[0]?.id ?? 0}:${state.cashBalanceIdr}:${todayISO()}`;
  if (!force && state.cashInsights && cacheKey === cashInsightsCacheKey && Date.now() - cashInsightsCachedAt < 60000) return;
  const requestedUser = state.user; const requestEpoch = authEpoch; const requestId = ++cashInsightsRequestEpoch;
  cashInsightsRequestBusy = true;
  try {
    const result = await api('/cash/insights');
    if (requestEpoch !== authEpoch || !state.user || state.user.id !== requestedUser.id || requestId !== cashInsightsRequestEpoch) return;
    state.cashInsights = result;
    cashInsightsCacheKey = cacheKey;
    cashInsightsCachedAt = Date.now();
    state.cashInsightsError = '';
    renderCashInsightsRegion();
  } catch (error) {
    if (requestEpoch === authEpoch && state.user?.id === requestedUser.id) { state.cashInsightsError = friendlyError(error); renderCashInsightsRegion(); }
  } finally { cashInsightsRequestBusy = false; }
}
function configureCashMinimum(button = null) {
  const form = $('#cashMinimumForm'); if (!form) return;
  const opening = form.hidden; form.hidden = !opening;
  (button || document.querySelector('[data-action="configure-cash-minimum"]'))?.setAttribute('aria-expanded', String(opening));
  if (opening) $('#cashMinimumInput')?.focus();
}
function saveCashMinimum(value) {
  const trimmed = String(value ?? '').trim();
  try {
    if (!trimmed) localStorage.removeItem(cashInsightMinimumKey());
    else if (/^\d{1,16}$/.test(trimmed) && BigInt(trimmed) <= BigInt(Number.MAX_SAFE_INTEGER)) localStorage.setItem(cashInsightMinimumKey(), BigInt(trimmed).toString());
    else { showToast('Masukkan angka rupiah tanpa titik atau simbol.'); return false; }
    renderCashInsightsRegion(true); showToast(trimmed ? 'Batas minimum perangkat disimpan.' : 'Batas minimum perangkat dihapus.'); return true;
  } catch { showToast('Batas minimum belum dapat disimpan di perangkat ini.'); return false; }
}
function clearCashMinimum() { saveCashMinimum(''); }

function managerOverviewSnapshot() {
  return JSON.stringify({
    cashBalanceIdr: state.cashBalanceIdr,
    submissions: state.submissions,
    summary: state.summary,
    cashLedger: state.cashLedger,
    auditEvents: state.auditEvents,
    pendingSubmissions: state.pendingSubmissions,
    users: state.users,
    usersPage: state.usersPage,
    history: state.history,
    cashInsights: state.cashInsights
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
    await refreshOverview({ preserveHistory: true });
    if (currentPage === 'users') await refreshUsersPage(Number(state.usersPage.page || 1));
    const changed = before !== managerOverviewSnapshot();
    if (!changed && !managerSyncRerenderPending) return false;
    if (!['overview', 'approvals', 'finance', 'users'].includes(currentPage)) {
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

async function requestUserOverviewRefresh() {
  if (!state.user || state.user.role !== 'user' || state.user.mustChangePassword || document.hidden || currentPage === 'new-report' || navigator.onLine === false) return false;
  const pageAtStart = currentPage;
  const ownerAtStart = state.user.id;
  const epochAtStart = authEpoch;
  try {
    await refreshOverview({ preserveHistory: true });
    if (epochAtStart !== authEpoch || state.user?.id !== ownerAtStart || currentPage !== pageAtStart) return false;
    if (currentPage === 'my-reports' && typeof BoundedHistory !== 'undefined') await BoundedHistory.load('submissions', 'refresh');
    if (epochAtStart !== authEpoch || state.user?.id !== ownerAtStart || currentPage !== pageAtStart) return false;
    const active = document.activeElement;
    const preserveSearch = active?.id === 'archiveSearch' && currentPage === 'my-reports';
    const selectionStart = preserveSearch ? active.selectionStart : null;
    const selectionEnd = preserveSearch ? active.selectionEnd : null;
    renderApp();
    if (preserveSearch) {
      const search = $('#archiveSearch');
      if (search) { search.focus({ preventScroll: true }); search.setSelectionRange(selectionStart, selectionEnd); }
    }
    return true;
  } catch { return false; }
}

function requestManagerOverviewRefresh(force = false) {
  return refreshManagerOverview({ force });
}

class ApiFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const mutation = !['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase());
  if (mutation) activeApiTransactions++;
  try {
  const requestEpoch = authEpoch;
  const headers = new Headers(options.headers || {});
  let body;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    body, signal: options.signal
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
  } finally { if (mutation) activeApiTransactions = Math.max(0, activeApiTransactions - 1); }
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
  reportTypePreset = restoreReportType();
  submissionIdempotencyKey = '';
  resetNavigationSession(result.user.mustChangePassword ? 'change-password' : 'overview');
  if (state.user.mustChangePassword) {
    state.cashBalanceIdr = 0;
  state.cashFlow = { incomingIdr: '0', outgoingIdr: '0' };
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
  if (typeof ManagerReportFilters !== 'undefined') ManagerReportFilters.clear();
  if (typeof FinancialControls !== 'undefined') FinancialControls.clear();
  if (typeof ReportEvidence !== 'undefined') ReportEvidence.clear();
  if (typeof PwaFiles !== 'undefined') PwaFiles.cleanup();
  if (typeof BoundedHistory !== 'undefined') BoundedHistory.reset();
  authEpoch += 1;
  resetNavigationSession('overview');
  usersPageLifecycle.cancel();
  historyPageLifecycles.forEach(lifecycle => lifecycle.cancel());
  historyPageLifecycles.clear();
  closeDialogs({ force: true });
  $$('form').forEach(form => form.reset());
  $$('input[type="password"], textarea, input[type="number"]').forEach(input => { input.value = ''; });
  state.user = null;
  state.cashBalanceIdr = 0;
  state.cashFlow = { incomingIdr: '0', outgoingIdr: '0' };
  state.submissions = [];
  state.pendingSubmissions = [];
  state.pendingPage = { cursor: '', nextCursor: '', total: 0, hasMore: false, hasPrevious: false, loading: false, error: '' };
  state.users = [];
  state.usersPage = { page: 1, limit: 5, total: 0, hasMore: false };
  state.cashLedger = [];
  state.auditEvents = [];
  state.summary = {};
  state.cashInsights = null;
  state.cashInsightsError = '';
  state.cashInsightsDailyLimit = 14;
  cashInsightsRequestEpoch += 1;
  state.history = emptyHistory();
  state.archiveType = 'all';
  state.archiveSearch = '';
  currentPage = 'overview';
  lastRenderedPage = '';
  reportTypePreset = 'petty_cash';
  submissionIdempotencyKey = '';
  cashTopupIdempotencyKey = '';
  cashTopupFingerprint = '';
  cashTopupBusy = false;
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
  preloader.classList.add('is-hidden');
  preloader.setAttribute('aria-hidden', 'true');
  preloader.hidden = true;
}

async function loadPendingPage(direction = 'first') {
  if (!state.user || state.user.role !== 'manager' || (state.pendingPage.loading && direction !== 'first')) return;
  const focusAction = document.activeElement?.dataset?.action;
  const requestedOwner = state.user.id;
  const requestedEpoch = authEpoch;
  const requestGeneration = ++pendingRequestGeneration;
  const page = state.pendingPage; page.loading = true; page.error = '';
  if (currentPage === 'approvals') renderApp();
  try {
    const query = new URLSearchParams({ status: 'pending', limit: '5' });
    if (direction === 'next' && page.nextCursor) query.set('cursor', page.nextCursor);
    if (direction === 'previous' && page.previousCursor) { query.set('cursor', page.previousCursor); query.set('direction', 'before'); }
    const result = await api(`/submissions?${query}`);
    if (requestGeneration !== pendingRequestGeneration || requestedEpoch !== authEpoch || state.user?.id !== requestedOwner || (currentPage !== 'approvals' && direction !== 'first')) return;
    state.pendingSubmissions = Array.isArray(result.items) ? result.items : (Array.isArray(result.submissions) ? result.submissions : []);
    state.pendingPage = { ...page, cursor: result.cursor || '', nextCursor: result.nextCursor || '', previousCursor: result.previousCursor || '', total: Number(result.total || 0), hasMore: Boolean(result.hasMore), hasPrevious: Boolean(result.hasPrevious || result.previousCursor), loading: false, error: '' };
    renderApp();
    if (focusAction?.startsWith('pending-') && currentPage === 'approvals') {
      (document.querySelector(`[data-action="${direction === 'next' ? 'pending-previous' : 'pending-next'}"]`) || document.querySelector('[data-action="pending-previous"],[data-action="pending-next"]'))?.focus({ preventScroll:true });
    }
  } catch (error) { if (requestGeneration !== pendingRequestGeneration || requestedEpoch !== authEpoch || state.user?.id !== requestedOwner) return; page.loading = false; page.error = friendlyError(error); if (currentPage === 'approvals') renderApp(); }
}
async function refreshOverview({ preserveHistory = false } = {}) {
  const requestedUser = state.user;
  const requestEpoch = authEpoch;
  if (!requestedUser) throw new ApiFailure(401, 'session_changed', 'Sesi tidak aktif. Masuk kembali untuk melanjutkan.');
  const result = await api('/overview');
  if (requestEpoch !== authEpoch || !state.user || state.user.id !== requestedUser.id) {
    throw new ApiFailure(401, 'session_changed', 'Sesi telah berubah. Masuk kembali untuk melanjutkan.');
  }
  state.user = result.user;
  state.cashBalanceIdr = Number(result.cashBalanceIdr) || 0;
  state.cashLedgerAnchorId = Number(result.cashLedgerAnchorId ?? result.cashLedger?.[0]?.id ?? 0);
  state.cashFlow = result.cashFlow || { incomingIdr: '0', outgoingIdr: '0' };
  if (typeof ManagerReportFilters !== 'undefined') ManagerReportFilters.refresh();
  if (typeof FinancialControls !== 'undefined') FinancialControls.refresh();
  if (!preserveHistory && typeof BoundedHistory !== 'undefined') BoundedHistory.reset();
  const nextHistory = result.history || emptyHistory();
  const preserveUserHistory = preserveHistory && state.user?.role === 'user' && currentPage === 'my-reports';
  for (const collection of ['submissions', 'cashLedger', 'auditEvents']) {
    const browsingOlderPage = preserveHistory && Number(state.history?.[collection]?.pageNumber || 1) > 1;
    if ((collection === 'submissions' && preserveUserHistory) || browsingOlderPage) continue;
    state[collection] = Array.isArray(result[collection]) ? result[collection] : [];
    state.history[collection] = nextHistory[collection] || emptyHistory()[collection];
  }
  state.pendingSubmissions = Array.isArray(result.pendingSubmissions) ? result.pendingSubmissions : [];
  const retainUsersQuery = state.user?.role === 'manager' && (currentPage === 'users' || state.usersPage.query);
  if (!retainUsersQuery) {
    state.users = Array.isArray(result.users) ? result.users : [];
    if (!preserveHistory) state.usersPage = { ...state.usersPage, page: 1, limit: 5, total: 0, hasMore: state.users.length >= 5, query: '' };
  }
  state.summary = result.summary || {};
  configureBoundedHistory();
  if (state.user?.role === 'manager') {
    void loadCashInsights();
    if (currentPage === 'approvals') await loadPendingPage('first');
    if (retainUsersQuery) await refreshUsersPage(state.usersPage.page || 1, false, state.usersPage.query || '');
  }
}


function navButton(item) {
  const current = currentPage === item.id ? 'page' : 'false';
  return `<button class="nav-button" type="button" data-page="${item.id}" aria-current="${current}">${icons[item.icon]}<span>${escapeHTML(item.label)}</span></button>`;
}

function renderNav() {
  const role = state.user?.role || 'user';
  const items = navByRole[role];
  $('#desktopNav').innerHTML = items.map(navButton).join('');
  const headerUsers = document.querySelector('.account-users-button');
  if (headerUsers) {
    headerUsers.hidden = role !== 'manager';
    headerUsers.setAttribute('aria-current', currentPage === 'users' ? 'page' : 'false');
  }
  const headerPassword = document.querySelector('.account-password-button');
  if (headerPassword) headerPassword.classList.toggle('is-manager', role === 'manager');
  const mobile = $('#mobileNav');
  if (role === 'manager') {
    // Keep mobile navigation identical to the desktop hierarchy. Finance itself
    // owns the Laporan and Pengelolaan kas sections; nav labels must not imply
    // that Ringkasan or Persetujuan are cash-management pages.
    mobile.className = 'mobile-nav is-manager';
    mobile.innerHTML = items.map(navButton).join('');
    return;
  }
  mobile.className = 'mobile-nav is-user';
  mobile.innerHTML = `${navButton(items[0])}<button class="mobile-add" type="button" data-page="new-report" aria-label="Buat laporan baru">${icons.plus}</button>${navButton(items[2])}`;
}

function pageHeading(title, description = '', action = '') {
  return `<div class="page-heading"><div><h1>${escapeHTML(title)}</h1>${description ? `<p class="page-description">${escapeHTML(description)}</p>` : ''}</div>${action}</div>`;
}

function welcomePanel() {
  const user = state.user;
  const name = user.nickname || (user.name || 'Pengguna').trim().split(/\s+/)[0];
  const clock = welcomeClock();
  const position = user.dashboardPosition ?? user.position;
  const avatar = user.role === 'manager'
    ? `<button class="welcome-avatar-button" type="button" data-action="edit-user-profile" data-id="${escapeHTML(user.id)}" aria-label="Ubah foto dan profil dashboard">${profileAvatar(user)}</button>`
    : profileAvatar(user);
  return `<section class="welcome-card">${avatar}<div class="welcome-copy"><p class="welcome-date">${escapeHTML(clock.date)}</p><h1>${clock.greeting}, ${escapeHTML(name)}</h1><p class="welcome-role">${escapeHTML(position || (user.role === 'manager' ? 'Manager Pangsuma' : 'User Pangsuma'))}</p>${user.quote ? `<p class="welcome-quote">${escapeHTML(user.quote)}</p>` : ''}</div></section>`;
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
    const approveLabel = item.type === 'petty_cash' ? 'Setujui & kurangi saldo' : 'Setujui pengajuan';
    const disableHint = own
      ? 'Manager tidak dapat memutuskan pengajuannya sendiri.'
      : !enoughCash ? 'Saldo Petty Cash belum mencukupi.' : '';
    actions = `<div class="item-actions"><button class="primary-button" type="button" data-action="approve" data-id="${escapeHTML(item.id)}" ${cannotApprove ? 'disabled' : ''} ${disableHint ? `aria-describedby="hint-${escapeHTML(item.id)}" title="${escapeHTML(disableHint)}"` : ''}>${approveLabel}</button><button class="secondary-button" type="button" data-action="reject" data-id="${escapeHTML(item.id)}" ${own ? 'disabled' : ''}>Tolak</button></div>${disableHint ? `<p class="action-hint" id="hint-${escapeHTML(item.id)}">${escapeHTML(disableHint)}</p>` : ''}`;
  }
  if (options.financeActions && state.user?.role === 'manager' && item.type === 'finance_request' && item.status === 'approved') {
    actions = `<div class="item-actions"><button class="primary-button" type="button" data-action="send-finance" data-id="${escapeHTML(item.id)}">Tandai terkirim ke Finance</button></div>`;
  }
  const detail = `<button class="text-button" type="button" data-action="report-detail" data-id="${escapeHTML(item.id)}">Detail</button>`;
  return `<article class="item-row"><div class="item-copy">${owner}<div class="item-title">${escapeHTML(item.description)}</div><div class="item-meta">${submissionMeta(item, false)}</div>${item.note ? `<p class="item-note">${escapeHTML(item.note)}</p>` : ''}</div><div class="item-side">${amount}${options.showStatus !== false ? status : ''}${detail}</div>${item.decisionReason ? `<p class="decision-reason"><strong>Alasan:</strong> ${escapeHTML(item.decisionReason)}</p>` : ''}${actions}</article>`;
}

function emptyState(title, message = '') {
  return `<div class="surface empty-state"><strong>${escapeHTML(title)}</strong>${message ? `<span>${escapeHTML(message)}</span>` : ''}</div>`;
}

function historyControls(collection, label) {
  const page = state.history?.[collection];
  if (!page || !Number(page.total || 0)) return '';
  const meta = typeof BoundedHistory !== 'undefined' ? BoundedHistory.controlsMeta(collection) : {};
  const number = meta.pageNumber || 1, count = state[collection]?.length || 0;
  const button = (direction, text, label = text) => `<button class="secondary-button" type="button" data-action="${direction}" data-collection="${escapeHTML(collection)}" aria-label="${escapeHTML(label)}">${text}</button>`;
  return `<div class="history-controls" aria-live="polite"><p>Halaman ${number} · ${count} ${escapeHTML(label)} ditampilkan · total ${Number(page.total)}.</p><div class="form-actions">${meta.hasPrevious ? button('history-previous', 'Sebelumnya', `Halaman ${number - 1}, sebelumnya`) : ''}${meta.canFirst ? button('history-first', 'Kembali ke terbaru') : ''}${page.hasMore ? button('load-more-history', 'Lihat 5 berikutnya', `Halaman ${number + 1}, lihat 5 berikutnya`) : ''}</div>${meta.cursorHistoryTruncated ? '<p class="field-help">Navigasi kembali dibatasi demi memori perangkat; semua halaman tetap dapat diakses dari data terbaru.</p>' : ''}</div>`;
}

function submissionTimeline(item) {
  const steps = [['pending', 'Dikirim', item.createdAt]];
  if (item.status === 'approved' || item.status === 'sent') steps.push(['approved', 'Disetujui', item.status === 'approved' ? item.updatedAt : null]);
  if (item.status === 'sent') steps.push(['sent', 'Terkirim ke Finance', item.updatedAt]);
  if (item.status === 'rejected') steps.push(['rejected', 'Ditolak', item.updatedAt]);
  return `<ol class="submission-timeline" aria-label="Timeline ${escapeHTML(item.description)}">${steps.map(([status, label, timestamp]) => `<li class="timeline-step ${status}"><span class="timeline-dot" aria-hidden="true"></span><span><strong>${label}</strong>${timestamp ? `<small>${escapeHTML(dateTimeLong(timestamp))}</small>` : ''}${status === 'rejected' && item.decisionReason ? `<small class="timeline-reason">${escapeHTML(item.decisionReason)}</small>` : ''}</span></li>`).join('')}</ol>`;
}
function managerOverview() {
  const recent = state.submissions.slice(0, 5);
  const financeWaiting = state.summary.financeWaiting ?? 0;
  const pendingCount = state.summary.pending ?? 0;
  const todayCount = state.summary.today ?? 0;
  return `${welcomePanel()}
    <section class="hero-panel balance-panel"><div><span>Saldo Petty Cash</span><strong>${money(state.cashBalanceIdr)}</strong><p>${state.cashBalanceIdr === 0 ? 'Saldo awal tetap nol sampai pemilik mengonfirmasi angka aktual.' : 'Saldo dikelola melalui keputusan dan ledger.'}</p></div></section>
    <div id="financialControlsOverview">${typeof FinancialControls !== 'undefined' ? FinancialControls.renderOverview() : ''}</div>
    <div class="section-row manager-action-row"><h2>Ringkasan operasional</h2><button class="primary-button" type="button" data-action="open-report-choice">Buat pengajuan</button></div>
    <div class="metric-row" aria-label="Ringkasan operasional">${metricCard('review', 'Menunggu persetujuan', String(pendingCount))}${metricCard('finance', 'Menunggu Finance', String(financeWaiting))}${metricCard('report', 'Pengajuan hari ini', String(todayCount))}</div>
    <section class="recent-section"><div class="section-row"><h2>Pengajuan terbaru</h2></div>${recent.length ? `<div class="list-stack">${recent.map(item => submissionCard(item, { includeOwner: true })).join('')}</div><button class="secondary-button" type="button" data-page="approvals">Lihat semua pengajuan</button>` : emptyState('Belum ada pengajuan')}</section>`;
}
function userOverview() {
  const own = state.submissions;
  const total = state.summary.total ?? 0;
  const pending = state.summary.pending ?? 0;
  return `${welcomePanel()}
    <div class="metric-row" aria-label="Ringkasan laporan">${metricCard('report', 'Total laporan', String(total))}${metricCard('review', 'Menunggu', String(pending))}</div>
    <section class="user-status-section" aria-labelledby="userStatusTitle"><div class="section-row"><h2 id="userStatusTitle">Laporan terbaru</h2></div>${own.length ? `<div class="list-stack">${own.slice(0, 5).map(item => submissionCard(item)).join('')}</div><button class="secondary-button" type="button" data-page="my-reports">Lihat semua laporan</button>` : emptyState('Belum ada laporan', 'Pilih Buat laporan di navigasi untuk mengirim kebutuhan.')}</section>`;
}
function managerApprovals() {
  const pending = Array.isArray(state.pendingSubmissions) ? state.pendingSubmissions : state.submissions.filter(item => item.status === 'pending');
  const history = state.submissions.filter(item => item.status !== 'pending');
  const audit = state.auditEvents;
  return `${pageHeading('Persetujuan', 'Tinjau setiap pengajuan. Keputusan Petty Cash tercatat bersama perubahan saldo.')}
    <div class="metric-row" aria-label="Ringkasan persetujuan">${metricCard('review', 'Menunggu', String(state.summary.pending ?? pending.length))}${metricCard('wallet', 'Saldo Petty Cash', compactMoney(state.cashBalanceIdr), 'overview', money(state.cashBalanceIdr))}${metricCard('report', 'Masuk hari ini', String(state.summary.today ?? 0))}</div>
    <div class="section-row"><div><h2>Antrian</h2></div></div>${state.pendingPage.error ? `<p class="inline-error" role="alert">${escapeHTML(state.pendingPage.error)}</p><button class="secondary-button" type="button" data-action="pending-retry">Coba lagi</button>` : ''}${pending.length ? `<div class="list-stack">${pending.map(item => submissionCard(item, { includeOwner: true, actions: true })).join('')}</div>` : emptyState('Belum ada pengajuan menunggu', 'Keputusan Manager yang selesai akan tetap ada di riwayat.')}<p class="field-help" role="status">${state.pendingPage.loading ? 'Memuat antrean…' : `Menampilkan ${pending.length} dari ${Number(state.pendingPage.total || state.summary.pending || 0)} pengajuan menunggu.`}</p><nav class="report-pagination" aria-label="Navigasi antrean">${state.pendingPage.hasPrevious ? '<button class="secondary-button" type="button" data-action="pending-previous">Sebelumnya</button>' : ''}${state.pendingPage.hasMore ? '<button class="secondary-button" type="button" data-action="pending-next">Lihat 5 berikutnya</button>' : ''}</nav>
    <div class="section-row"><div><h2>Riwayat keputusan</h2></div><span class="archive-total">${Math.max(0, Number(state.summary.total || 0) - Number(state.summary.pending || 0))} pengajuan</span></div>${history.length ? `<div class="list-stack">${history.map(item => submissionCard(item, { includeOwner: true })).join('')}</div>` : emptyState('Tidak ada keputusan pada halaman ini', 'Gunakan navigasi riwayat untuk melihat pengajuan lainnya.')}
    ${historyControls('submissions', 'pengajuan')}
    <details class="audit-panel" data-panel="audit-events"><summary>Riwayat perubahan sistem (${state.history.auditEvents.loaded} dari ${state.history.auditEvents.total})</summary>${audit.length ? `<ol class="audit-list">${audit.map(auditRow).join('')}</ol>` : `<p class="field-help">Belum ada aktivitas audit.</p>`}${historyControls('auditEvents', 'aktivitas audit')}</details>`;
}

function financePage() {
  const ledgers = state.cashLedger;
  const openingConfigured = Boolean(state.cashFlow?.openingConfigured);
  const pdfFallback = isPangsumaApkWrapper()
    ? '<p class="field-help pdf-apk-status">Unduh PDF langsung memerlukan APK yang diperbarui.</p>'
    : '';
  const reportActions = `<div class="heading-actions"><button class="primary-button" type="button" data-action="download-pdf" data-report-type="petty_cash">Unduh laporan Petty Cash</button><button class="secondary-button" type="button" data-action="download-pdf" data-report-type="finance_request">Unduh laporan Request Finance</button>${pdfFallback}</div>`;
  const cashActions = `<div class="heading-actions"><button class="secondary-button" type="button" data-action="open-cash-topup">Tambah Petty Cash</button>${openingConfigured ? '' : '<button class="secondary-button" type="button" data-action="open-opening-balance">Tetapkan saldo awal</button>'}</div>`;
  return `${pageHeading('Finance', 'Pantau Request Finance dan laporan terfilter.')}
    <section class="finance-section" aria-labelledby="financeReportsTitle"><div class="section-row"><h2 id="financeReportsTitle">Laporan</h2>${reportActions}</div>
    <div id="managerReportsRegion">${typeof ManagerReportFilters !== 'undefined' ? ManagerReportFilters.render() : `<div class="list-stack">${state.submissions.map(item => submissionCard(item, { includeOwner: true, financeActions: true })).join('')}</div>${historyControls('submissions', 'pengajuan')}`}</div></section>
    <section class="finance-section" aria-labelledby="financeCashTitle"><div class="section-row"><h2 id="financeCashTitle">Pengelolaan kas</h2>${cashActions}</div>
    <details class="audit-panel" data-panel="cash-insights"><summary>Rincian saldo dan tren Petty Cash</summary>${cashInsightsRegion()}</details>
    <div id="financialControlsFinance">${typeof FinancialControls !== 'undefined' ? FinancialControls.renderFinance() : ''}</div>
    <details class="audit-panel" data-panel="cash-ledger"><summary>Ledger Petty Cash (${state.history.cashLedger.loaded} dari ${state.history.cashLedger.total})</summary>${ledgers.length ? `<ol class="audit-list">${ledgers.map(ledgerRow).join('')}</ol>` : `<p class="field-help">Belum ada transaksi saldo.</p>`}${historyControls('cashLedger', 'transaksi ledger')}</details></section>`;
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
    'user.password_changed': 'Kata sandi pengguna diperbarui',
    'user.profile_updated': 'Profil dashboard diperbarui',
    'user.deactivated': 'Akses pengguna dinonaktifkan'
  };
  const label = actionLabels[event.action] || event.action;
  const amount = details.amount_idr ? ` · ${money(details.amount_idr)}` : '';
  const reason = details.reason ? ` · Alasan: ${escapeHTML(details.reason)}` : '';
  return `<li><div class="audit-main"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(event.actor_name || 'Sistem')}</span></div><small>${escapeHTML(dateTimeLong(event.created_at))}${amount}${reason}</small></li>`;
}

function ledgerRow(event) {
  const debit = event.direction === 'debit';
  const topup = event.event_type === 'cash_topup';
  return `<li><div class="audit-main"><strong>${topup ? 'Petty Cash ditambah' : debit ? 'Pengeluaran Petty Cash disetujui' : 'Saldo awal'}</strong><span>${debit ? '−' : '+'}${money(event.amount_idr)}</span></div><small>${escapeHTML(event.actor_name || 'Sistem')} · Saldo setelah transaksi ${money(event.balance_after_idr)} · ${escapeHTML(topup ? dateTimeWibFull(event.created_at) : dateTimeLong(event.created_at))}${event.note ? ` · ${escapeHTML(event.note)}` : ''}</small></li>`;
}

function asyncLifecycle() {
  let token = 0, busy = false, error = null;
  return {
    begin() { const current = ++token; busy = true; error = null; return current; },
    current(current) { return current === token; },
    finish(current) { if (current === token) busy = false; },
    cancel() { token++; busy = false; error = null; },
    fail(current, value) { if (current === token) error = value; },
    get busy() { return busy; }, get error() { return error; }
  };
}
const usersPageLifecycle = asyncLifecycle();
const historyPageLifecycles = new Map();
async function refreshUsersPage(page = 1, append = false, query = state.usersPage.query || '') {
  if (!state.user || state.user.role !== 'manager') return false;
  const request = usersPageLifecycle.begin();
  const requestEpoch = authEpoch;
  const requestUserId = state.user?.id;
  state.usersPage = { ...state.usersPage, loading: true, error: '' };
  try {
    const search = String(query || '').trim().slice(0, 100);
    const result = await api(`/users?page=${page}&limit=5&q=${encodeURIComponent(search)}`);
    if (!usersPageLifecycle.current(request) || requestEpoch !== authEpoch || state.user?.id !== requestUserId) return false;
    const rows = Array.isArray(result.users) ? result.users : [];
    state.users = rows;
    state.usersPage = { page: Number(result.page || page), limit: Number(result.limit || 5), total: Number(result.total || state.users.length), hasMore: Boolean(result.hasMore), query: search, loading: false, error: '' };
    return true;
  } catch (error) {
    if (!usersPageLifecycle.current(request) || requestEpoch !== authEpoch || state.user?.id !== requestUserId) return false;
    usersPageLifecycle.fail(request, error);
    state.usersPage = { ...state.usersPage, loading: false, error: friendlyError(error) };
    throw error;
  } finally { usersPageLifecycle.finish(request); }
}

function renderUsersPageView() {
  if (currentPage !== 'users' || state.user?.role !== 'manager') return;
  const active = document.activeElement;
  const focused = active?.id === 'usersSearch';
  const start = focused ? active.selectionStart : null;
  const end = focused ? active.selectionEnd : null;
  renderApp();
  if (focused) {
    const search = $('#usersSearch');
    search?.focus({ preventScroll: true });
    if (start !== null && end !== null) search?.setSelectionRange(start, end);
  }
}
async function loadUsersPageView(page = state.usersPage.page || 1, query = state.usersPage.query || '') {
  if (currentPage !== 'users' || state.user?.role !== 'manager') return false;
  const requestEpoch = authEpoch, owner = state.user.id;
  const pending = refreshUsersPage(page, false, query);
  renderUsersPageView();
  try {
    const applied = await pending;
    if (applied && requestEpoch === authEpoch && state.user?.id === owner) renderUsersPageView();
    return applied;
  } catch (error) {
    if (requestEpoch === authEpoch && state.user?.id === owner && currentPage === 'users') {
      renderUsersPageView();
      showToast(friendlyError(error));
    }
    return false;
  }
}
function accountDraftKey() { return 'manager-account-form'; }
function readAccountDraft() { return state.user?.role === 'manager' ? readDraft(accountDraftKey()) : null; }
function persistAccountDraft() { const form = $('#userForm'); if (!state.user || state.user.role !== 'manager' || !form) return; const fields = form.elements; const values = { name: String(fields.namedItem('name')?.value || '').slice(0, 80), email: String(fields.namedItem('email')?.value || '').slice(0, 180), position: String(fields.namedItem('position')?.value || '').slice(0, 80) }; if (Object.values(values).some(Boolean)) writeDraft(accountDraftKey(), '', values); else clearDraft(accountDraftKey()); }
function restoreAccountDraft() { const draft = readAccountDraft(), form = $('#userForm'); if (!form || !draft) return; for (const field of ['name', 'email', 'position']) if (form.elements[field]) form.elements[field].value = draft[field] || ''; $('#addUserCard').hidden = false; }
function accountDraftPresent() { const draft = readAccountDraft(); return Boolean(draft && Object.values(draft).some(Boolean)); }
function usersPage() {
  const userRows = state.users.map(user => {
    const passkeyCount = Number(user.passkeyCount || 0);
    const credential = !user.active ? 'Akses nonaktif' : passkeyCount ? 'Passkey siap' : !user.passwordReady ? 'Kata sandi belum diatur' : user.mustChangePassword ? 'Wajib ganti kata sandi' : 'Siap masuk';
    const statusClass = !user.active ? 'status-neutral' : passkeyCount || (user.passwordReady && !user.mustChangePassword) ? 'status-ok' : 'status-wait';
    const passkeyLabel = passkeyCount ? `Passkey terdaftar (${passkeyCount})` : 'Belum ada passkey';
    const accessActions = user.role === 'manager' || !user.active
      ? ''
      : `<div class="user-actions"><button class="secondary-button" type="button" data-action="reset-user-password" data-id="${escapeHTML(user.id)}" data-name="${escapeHTML(user.name)}">Atur kata sandi</button><button class="danger-button" type="button" data-action="deactivate-user" data-id="${escapeHTML(user.id)}" data-name="${escapeHTML(user.name)}">Nonaktifkan akses</button></div>`;
    const actions = `<div class="user-actions"><button class="secondary-button" type="button" data-action="edit-user-profile" data-id="${escapeHTML(user.id)}">Atur profil</button>${accessActions}</div>`;
    return `<tr><td data-label="Pengguna"><div class="profile-user-cell">${profileAvatar(user, 'user-initial')}<div>${escapeHTML(user.name)}${user.nickname ? `<small class="profile-nickname">${escapeHTML(user.nickname)}</small>` : ''}</div></div></td><td data-label="Posisi dashboard">${escapeHTML(user.dashboardPosition ?? user.position ?? 'Belum diisi')}</td><td data-label="Peran"><span class="status status-neutral">${user.role === 'manager' ? 'Manager' : 'User'}</span></td><td data-label="ID masuk">${escapeHTML(user.email)}</td><td data-label="Status akses"><div class="user-access-state"><span class="status ${statusClass}">${credential}</span><small class="passkey-status">${passkeyLabel}</small></div></td><td data-label="Aksi">${actions}</td></tr>`;
  }).join('');
  const actions = '<div class="user-page-actions"><button class="secondary-button" type="button" data-action="open-add-user">Tambah pengguna</button></div>';
  const query = String(state.usersPage.query || '');
  const listStatus = state.usersPage.loading ? '<p class="field-help" role="status" aria-live="polite">Memuat daftar akun…</p>' : state.usersPage.error ? `<p class="field-error" role="alert">${escapeHTML(state.usersPage.error)} <button class="secondary-button" type="button" data-action="retry-users">Coba lagi</button></p>` : '';
  return `${pageHeading('Pengguna', 'Atur profil dashboard, foto, dan akses setiap akun, termasuk profil Anda.', actions)}
    <section class="users-search-panel form-card surface" aria-labelledby="usersSearchTitle"><h2 id="usersSearchTitle">Cari akun</h2><label for="usersSearch">Nama atau ID masuk</label><input id="usersSearch" type="search" maxlength="100" value="${escapeHTML(query)}" placeholder="Cari nama atau ID masuk…" autocomplete="off" spellcheck="false" aria-describedby="usersSearchHint"><p id="usersSearchHint" class="field-help" role="status" aria-live="polite">${query ? `Hasil untuk “${escapeHTML(query)}”` : 'Cari di seluruh daftar akun, bukan hanya halaman yang sudah dimuat.'}</p>${listStatus}</section>
    <section class="form-card surface add-user-card" id="addUserCard" hidden><h2>Tambah akun User</h2><form id="userForm"><div class="form-grid"><div class="field"><label for="userName">Nama</label><input id="userName" name="name" required maxlength="80" autocomplete="name"></div><div class="field"><label for="userLoginId">ID masuk</label><input id="userLoginId" name="email" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="180" required><span class="field-help">Gunakan ID seperti alamat akun; aplikasi tidak mengirim email.</span></div><div class="field field-full"><label for="userPosition">Jabatan (opsional)</label><input id="userPosition" name="position" maxlength="80"></div></div><p class="form-note">Akun baru berperan sebagai User. Atur kata sandi sementara secara terpisah setelah akun dibuat.</p><div class="form-actions"><button class="primary-button" type="submit">Simpan pengguna</button><button class="secondary-button" type="button" data-action="cancel-add-user">Batal</button></div></form></section>
    <div class="section-row"><div><h2>Daftar akun</h2></div><span class="archive-total">${state.usersPage.total ? `Halaman ${Number(state.usersPage.page || 1)} · ${state.users.length} dari ${Number(state.usersPage.total)} akun` : `${state.users.length}${state.usersPage.hasMore ? '+' : ''} akun dimuat`}</span></div>
    ${state.usersPage.loading || state.usersPage.error ? '' : state.users.length ? `<div class="table-wrap"><table><thead><tr><th>Pengguna</th><th>Posisi dashboard</th><th>Peran</th><th>ID masuk</th><th>Status akses</th><th>Aksi</th></tr></thead><tbody>${userRows}</tbody></table></div><div class="form-actions">${state.usersPage.page > 1 ? '<button class="secondary-button" type="button" data-action="previous-users" aria-label="Halaman sebelumnya">Sebelumnya</button>' : ''}${state.usersPage.hasMore ? '<button class="secondary-button" type="button" data-action="load-more-users" aria-label="Lihat 5 akun berikutnya">Lihat 5 berikutnya</button>' : ''}</div>` : (state.usersPage.loading || state.usersPage.error) ? '' : emptyState(query ? 'Tidak ada hasil' : 'Belum ada akun', query ? 'Coba nama atau ID masuk lain.' : 'Daftar akun dimuat dari server setelah bootstrap disetujui.')}`;
}

function myReportsPage() {
  const query = state.archiveSearch.trim().toLocaleLowerCase('id-ID');
  const filtered = state.submissions.filter(item => state.archiveType === 'all' || item.type === state.archiveType).sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
  const groups = new Map();
  for (const item of filtered) {
    const key = String(item.date).slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const content = filtered.length ? [...groups.entries()].map(([month, items], index) => `<details class="archive-month" ${index === 0 ? 'open' : ''}><summary><span class="archive-month-copy"><strong>${escapeHTML(monthLabel(month))}</strong><small>${items.length} laporan</small></span><span class="archive-chevron" aria-hidden="true"></span></summary><div class="archive-month-content"><div class="list-stack">${items.map(item => submissionCard(item)).join('')}</div></div></details>`).join('') : emptyState(query || state.archiveType !== 'all' ? 'Tidak ada laporan yang cocok' : 'Belum ada laporan', query || state.archiveType !== 'all' ? 'Ubah kata kunci atau jenis laporan.' : 'Pengajuan yang Anda kirim akan tersimpan di akun Anda.');
  return `${pageHeading('Laporan', 'Riwayat pengajuan Anda.')}
    <div class="archive-controls"><label class="archive-search"><span class="sr-only">Cari laporan</span><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.8" cy="10.8" r="6.7"/><path d="m16 16 4 4" stroke-linecap="round"/></svg><input id="archiveSearch" type="search" autocomplete="off" placeholder="Cari kebutuhan atau tanggal…" value="${escapeHTML(state.archiveSearch)}"></label><div class="archive-filter-row" role="group" aria-label="Jenis laporan"><button class="filter-chip" type="button" data-report-filter="all" aria-pressed="${state.archiveType === 'all'}">Semua</button><button class="filter-chip" type="button" data-report-filter="petty_cash" aria-pressed="${state.archiveType === 'petty_cash'}">Petty Cash</button><button class="filter-chip" type="button" data-report-filter="finance_request" aria-pressed="${state.archiveType === 'finance_request'}">Request Finance</button></div></div><div class="archive-month-list" id="archiveResults">${content}</div>${historyControls('submissions', 'laporan')}`;
}

function reportForm() {
  const type = reportTypePreset;
  const draft = reportDraft(type);
  submissionIdempotencyKey = draft.idempotencyKey || '';
  return `${pageHeading('Buat pengajuan', 'Isi kebutuhan Anda. Nominal dan status akan tersimpan di server.')}
    <form id="reportForm" class="form-card surface"><div class="form-grid">
      <div class="field field-full"><label for="reportType">Jenis pengajuan</label><select id="reportType" name="type" required><option value="petty_cash" ${type === 'petty_cash' ? 'selected' : ''}>Petty Cash</option><option value="finance_request" ${type === 'finance_request' ? 'selected' : ''}>Request Finance</option></select><div class="field-help" id="typeHelp">${state.user?.role === 'manager' ? (type === 'petty_cash' ? 'Otomatis disetujui; saldo Petty Cash langsung berkurang saat dikirim dan harus mencukupi.' : 'Otomatis disetujui dan langsung masuk daftar menunggu Finance.') : (type === 'petty_cash' ? 'Saldo Petty Cash berkurang setelah disetujui Manager.' : 'Request Finance masuk ke daftar Finance setelah disetujui.')}</div></div>
      <div class="field"><label for="reportDate">Tanggal</label><input id="reportDate" name="date" type="date" value="${escapeHTML(draft.date || todayISO())}" required></div>
      <div class="field"><label for="reportAmount">Nominal (rupiah)</label><input id="reportAmount" name="amountIdr" type="number" inputmode="numeric" min="1" step="1" value="${escapeHTML(draft.amountIdr || '')}" required placeholder="Contoh: 150000"></div>
      <div class="field field-full"><label for="reportDescription">Keperluan</label><input id="reportDescription" name="description" value="${escapeHTML(draft.description || '')}" required minlength="3" maxlength="150" placeholder="Jelaskan kebutuhan operasional"></div>
      <div class="field field-full"><label for="reportNote">Catatan (opsional)</label><textarea id="reportNote" name="note" maxlength="500" placeholder="Informasi tambahan untuk Manager">${escapeHTML(draft.note || '')}</textarea></div>
    </div><div class="form-actions"><button class="primary-button" type="submit">Kirim pengajuan</button><button class="secondary-button" type="button" data-page="overview">Batal</button></div></form>`;
}

function cashInfo() {
  if (state.user?.role !== 'manager') return userOverview();
  const approved = state.submissions.filter(item => item.type === 'petty_cash' && item.status === 'approved');
  return `${pageHeading('Petty Cash', 'Saldo berasal dari ledger server. Persetujuan pengeluaran mengurangi saldo satu kali.')}
    <div class="hero-panel balance-panel"><div><span>Saldo tersedia</span><strong>${money(state.cashBalanceIdr)}</strong><p>${state.cashBalanceIdr === 0 ? 'Saldo awal tetap nol sampai pemilik mengonfirmasi angka aktual.' : 'Setiap pengeluaran disetujui tersimpan pada ledger.'}</p></div></div>
    ${state.user.role === 'user' ? `<div class="section-row"><div><h2>Pengeluaran Anda</h2></div><button class="primary-button" type="button" data-action="open-report-choice">Buat pengajuan</button></div>` : ''}
    ${approved.length ? `<div class="list-stack">${approved.map(item => submissionCard(item)).join('')}</div>` : emptyState('Belum ada pengeluaran disetujui', state.cashBalanceIdr === 0 ? 'Saldo nol; pengajuan Petty Cash belum dapat disetujui.' : 'Pengeluaran yang disetujui akan tampil di sini.')}${historyControls('submissions', 'pengajuan')}`;
}

function changePasswordPage() {
  const forced = state.user.mustChangePassword;
  return `${pageHeading(forced ? 'Buat kata sandi baru' : 'Ganti kata sandi', forced ? 'Sebelum melanjutkan, ganti kata sandi sementara dengan kata sandi milik Anda.' : 'Gunakan kata sandi yang unik dan minimal 12 karakter.')}
    <form id="passwordForm" class="form-card surface"><div class="form-grid">
      <div class="field field-full"><label for="currentPassword">Kata sandi saat ini</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></div>
      <div class="field field-full"><label for="newPassword">Kata sandi baru</label><input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><span class="field-help">Panjang 12–128 karakter. Kata sandi tidak dikirim lewat email.</span></div>
      <div class="field field-full"><label for="confirmPassword">Ulangi kata sandi baru</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></div>
      <p class="field-error" id="passwordError" role="alert" hidden></p>
    </div><div class="form-actions"><button class="primary-button" type="submit">Simpan kata sandi</button>${forced ? '' : '<button class="secondary-button" type="button" data-page="overview">Batal</button>'}</div></form>`;
}

function renderApp() {
  if (!state.user) return;
  const addUserWasOpen = currentPage === 'users' && $('#addUserCard')?.hidden === false;
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
  if (currentPage === 'users') restoreAccountDraft();
  if (currentPage === 'users' && addUserWasOpen && $('#addUserCard')) $('#addUserCard').hidden = false;
  if (currentPage === 'new-report' && typeof ReportEvidence !== 'undefined') {
    ReportEvidence.mountDraft($('#reportForm'), { type: reportTypePreset, ownerId: state.user.id });
    ReportEvidence.mountDuplicateCheck($('#reportForm'));
  }
  $$('#appContent details[data-panel]').forEach(panel => { panel.open = openPanels.has(panel.dataset.panel); });
  if (pageChanged) $('#mainContent').scrollTo(0, 0);
  lastRenderedPage = currentPage;
  if (currentPage === 'new-report') $('#reportDescription')?.focus();
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialogs({ force = false } = {}) {
  const openDialogs = $$('dialog[open]');
  if (!force && openDialogs.some(dialog => !canCloseAppDialog(dialog))) return false;
  openDialogs.forEach(dialog => dialog.close());
  return true;
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
  const existing = $('#userProfileDialog');
  if (existing?.open && !canCloseAppDialog(existing)) return;
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
    draft.baseline = {
      nickname: String(result.user.nickname || '').trim(),
      position: String(result.user.dashboardPosition ?? result.user.position ?? '').trim(),
      quote: String(result.user.quote || '').trim()
    };
    $('#profileNickname').value = draft.baseline.nickname;
    $('#profilePosition').value = draft.baseline.position;
    $('#profileQuote').value = draft.baseline.quote;
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
      if (mime === 'image/webp') throw new Error('Foto tidak dapat dibaca. Pilih berkas gambar yang valid.');
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
    throw unsupportedNativePhotoError(mime) || new Error('Foto tidak dapat dibaca. Pilih berkas gambar yang valid.');
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
async function resolveProfilePhotoMime(file) {
  const mime = profilePhotoMime(file);
  // Android gallery/cloud providers can omit both a usable MIME and extension.
  // Sniff only generic metadata; the full image decoder and server still validate
  // every byte. Never reinterpret an explicitly unsupported MIME (e.g. SVG).
  if (!['', 'application/octet-stream', 'binary/octet-stream', 'image/*'].includes(mime)) return mime;
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)) return 'image/png';
  const tag = offset => String.fromCharCode(...header.slice(offset, offset + 4));
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image/webp';
  return mime;
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
    if (file.size > 10 * 1024 * 1024) throw new Error('Foto melebihi 10 MB. Pilih foto yang lebih kecil.');
    const mime = await resolveProfilePhotoMime(file);
    if (profileDraft !== draft || selection !== profileSelection) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(mime)) throw new Error('Pilih foto JPG, PNG, WebP, HEIC, atau HEIF. Format lain belum didukung.');
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
    button.classList.add('is-busy');
  } else {
    button.textContent = button.dataset.originalLabel || button.textContent;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('is-busy');
  }
}

function friendlyError(error) {
  if (error instanceof ApiFailure) return error.message;
  return 'Koneksi ke layanan gagal. Periksa koneksi lalu coba lagi.';
}

async function renderAfterMutation(successMessage, committedMessage = successMessage) {
  try {
    await refreshOverview();
    renderApp();
    showToast(successMessage);
    return true;
  } catch (error) {
    if (error?.code === 'session_changed' || !state.user) return false;
    renderApp();
    showToast(committedMessage);
    return false;
  }
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
    await renderAfterMutation(action.successMessage, `${action.successMessage} Ringkasan belum diperbarui; muat ulang saat koneksi tersedia.`);
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
    await renderAfterMutation('Penolakan dan alasannya tersimpan pada riwayat.', 'Penolakan sudah tersimpan. Ringkasan belum diperbarui; muat ulang saat koneksi tersedia.');
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
  setButtonBusy(button, true, 'Menyimpan kata sandi…');
  const targetId = resetTargetId;
  const target = state.users.find(user => user.id === targetId);
  const targetEmail = target?.email;
  try {
    if (!targetEmail || resetTargetId !== targetId) throw new Error('Akun pengguna tidak ditemukan. Muat ulang halaman lalu coba lagi.');
    const credential = await PasswordCrypto.deriveWithRandomSalt($('#temporaryPassword').value);
    if (resetTargetId !== targetId || state.users.find(user => user.id === targetId)?.email !== targetEmail) throw new Error('Target akun berubah. Tutup dialog lalu ulangi dari daftar pengguna.');
    await api(`/users/${encodeURIComponent(targetId)}/password`, {
      method: 'POST',
      body: { credential }
    });
    closeDialogs();
    form.reset();
    resetTargetId = '';
    await renderAfterMutation('Kata sandi tersimpan. Sampaikan secara terpisah kepada pengguna.', 'Kata sandi tersimpan. Daftar pengguna belum diperbarui; muat ulang saat koneksi tersedia.');
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
    errorBox.textContent = 'Kata sandi baru tidak sama. Periksa kembali kedua kolom.';
    errorBox.hidden = false;
    $('#confirmPassword').focus();
    return;
  }
  errorBox.hidden = true;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Menyimpan kata sandi…');
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
    if (typeof navigateToPage === 'function') navigateToPage('overview', { replace: true });
    else { currentPage = 'overview'; renderApp(); }
    showToast('Kata sandi diperbarui.');
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
    clearDraft(accountDraftKey());
    await renderAfterMutation('Akun User dibuat. Atur kata sandi sementara sebelum akses diberikan.', 'Akun User dibuat. Daftar pengguna belum diperbarui; muat ulang saat koneksi tersedia.');
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
  if (button.disabled) return;
  const data = new FormData(form);
  const owner = state.user?.id;
  let requestSaved = false;
  setButtonBusy(button, true, 'Mengirim pengajuan…');
  try {
    const type = String(data.get('type') || form.type?.value || (typeof reportTypePreset !== 'undefined' ? reportTypePreset : ''));
    const previous = typeof readDraft === 'function' ? readDraft('report', type) : null;
    const field = name => data.get(name) ?? previous?.[name] ?? '';
    const payload = { type, amountIdr: Number(field('amountIdr')), date: String(field('date')), description: String(field('description')).trim(), note: String(field('note')).trim() };
    const evidence = typeof ReportEvidence !== 'undefined' ? ReportEvidence : null;
    const photo = evidence ? await evidence.prepareDraftSubmission(form) : null;
    if (state.user?.id !== owner) return;
    const savedDraft = typeof readDraft === 'function' ? readDraft('report', payload.type) : null;
    if (typeof reportTypePreset !== 'undefined' && reportTypePreset !== payload.type) submissionIdempotencyKey = savedDraft?.idempotencyKey || '';
    const submittedFingerprint = JSON.stringify(payload);
    if (!submissionIdempotencyKey || (savedDraft?.submittedFingerprint && savedDraft.submittedFingerprint !== submittedFingerprint)) submissionIdempotencyKey = newSubmissionKey();
    if (typeof writeDraft === 'function') writeDraft('report', payload.type, { ...payload, amountIdr: String(payload.amountIdr), idempotencyKey: submissionIdempotencyKey, submittedFingerprint });
    if (photo?.hasPhoto && typeof readDraft === 'function') {
      const persisted = readDraft('report', payload.type);
      if (persisted?.idempotencyKey !== submissionIdempotencyKey || persisted?.submittedFingerprint !== submittedFingerprint) throw new Error('Draf pengajuan belum dapat disimpan di perangkat ini. Pengajuan belum dikirim; kosongkan ruang penyimpanan lalu coba lagi.');
    }
    let submissionId = evidence?.getDraftSubmission(form);
    if (!submissionId) {
      const result = await api('/submissions', { method: 'POST', headers: { 'Idempotency-Key': submissionIdempotencyKey }, body: payload });
      submissionId = result?.submission?.id;
    }
    requestSaved = true;
    if (state.user?.id !== owner) return;
    if (photo?.hasPhoto) {
      if (!submissionId) throw new Error('ID pengajuan belum diterima. Coba lagi dengan draf yang sama.');
      setButtonBusy(button, true, 'Mengunggah foto…');
      await evidence.completeDraftSubmission(form, submissionId);
    }
    if (typeof clearDraft === 'function') clearDraft('report', payload.type);
    submissionIdempotencyKey = '';
    let refreshed = true;
    try { await refreshOverview(); } catch (error) {
      if (error?.code === 'session_changed' || !state.user) return;
      refreshed = false;
    }
    const successPage = state.user.role === 'manager' ? 'overview' : 'my-reports';
    if (typeof navigateToPage === 'function') navigateToPage(successPage, { replace: true });
    else { currentPage = successPage; renderApp(); }
    showToast(!refreshed ? 'Pengajuan sudah tersimpan. Ringkasan belum diperbarui; muat ulang saat koneksi tersedia, jangan kirim ulang.' : state.user.role === 'manager' ? 'Pengajuan otomatis disetujui dan masuk rekap.' : 'Pengajuan terkirim dan tersimpan di akun Anda.');
  } catch (error) {
    showToast(requestSaved ? `Pengajuan sudah tersimpan, tetapi foto belum terkonfirmasi. Coba lagi unggah foto tanpa membuat pengajuan baru. ${friendlyError(error)}` : friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

function isPangsumaApkWrapper() {
  return (typeof PwaFiles !== 'undefined' && typeof PwaFiles.isAndroidWebView === 'function')
    ? PwaFiles.isAndroidWebView() : !!window.PangsumaFileBridge;
}
async function downloadPdf(button) {
  if (state.user?.role !== 'manager') return;
  const reportType = button?.dataset?.reportType === 'finance_request' ? 'finance_request' : 'petty_cash';
  const reportUrl = typeof ManagerReportFilters !== 'undefined' ? ManagerReportFilters.pdfUrl(reportType) : `/api/export.pdf?laporan=${reportType}`;
  const reportFilename = `pangsuma-laporan-${reportType === 'finance_request' ? 'request-finance' : 'petty-cash'}-${todayISO()}.pdf`;
  if (isPangsumaApkWrapper()) {
    // The confirmed APK bridge supports CSV only, not native PDF downloads.
    if (typeof PwaFiles !== 'undefined' && typeof PwaFiles.showApkDownloadStatus === 'function') {
      const requestEpoch = authEpoch;
      return PwaFiles.showApkDownloadStatus({
        isCurrent: () => requestEpoch === authEpoch && state.user?.role === 'manager'
      });
    }
    showToast('Unduh PDF langsung memerlukan APK yang diperbarui.');
    return;
  }
  const userAgent = navigator.userAgent || '';
  const isMobileAppleBrowser = /iPhone|iPad|iPod/.test(userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(userAgent));
  if (isMobileAppleBrowser) {
    const anchor = document.createElement('a');
    anchor.href = reportUrl;
    anchor.download = reportFilename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    showToast('Permintaan PDF diteruskan ke perangkat. Periksa notifikasi atau folder Unduhan; jika belum muncul, coba unduh kembali dari aplikasi.');
    return;
  }
  const requestEpoch = authEpoch;
  setButtonBusy(button, true, 'Menyiapkan rekap…');
  try {
    const response = await fetch(reportUrl, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
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
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || reportFilename;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('PDF berhasil disiapkan untuk diunduh.');
  } catch (error) {
    if (error.code !== 'session_changed') showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}
function configureBoundedHistory() {
  if (typeof BoundedHistory === 'undefined') return;
  const configuredEpoch = authEpoch;
  const configuredOwner = state.user?.id;
  BoundedHistory.configure({
    api: async (path, options) => {
      const requestedPage = currentPage;
      const requestedQuery = `${state.archiveSearch}|${state.archiveType}`;
      const read = async endpoint => {
        const result = await api(endpoint, options);
        if (requestedPage !== currentPage || (requestedPage === 'my-reports' && requestedQuery !== `${state.archiveSearch}|${state.archiveType}`)) throw new ApiFailure(409, 'session_changed', 'Halaman sudah berubah.');
        return result;
      };
      if (path.startsWith('/history/submissions') && state.user?.role === 'user' && currentPage === 'my-reports') {
        const url = new URL(path, 'https://app.local');
        const query = new URLSearchParams(url.search);
        const search = state.archiveSearch.trim();
        const aliases = { 'disetujui': 'approved', 'approved': 'approved', 'menunggu manager': 'pending', 'menunggu': 'pending', 'ditolak': 'rejected', 'terkirim ke finance': 'sent', 'terkirim': 'sent' };
        if (aliases[search.toLocaleLowerCase('id-ID')]) query.set('status', aliases[search.toLocaleLowerCase('id-ID')]);
        else if (search) query.set('q', search);
        if (state.archiveType !== 'all') query.set('kind', state.archiveType);
        return read(`/submissions?${query.toString()}`);
      }
      return read(path);
    }, getUser: () => state.user, getEpoch: () => authEpoch,
    getRows: key => state[key] || [], setRows: (key, rows) => { state[key] = rows; },
    getPage: key => state.history?.[key], setPage: (key, page) => { state.history[key] = page; },
    onError: error => { if (error.code !== 'session_changed') showToast(friendlyError(error)); },
    onChange: collection => queueMicrotask(() => {
      if (!state.user || currentPage === 'new-report' || authEpoch !== configuredEpoch || state.user.id !== configuredOwner) return;
      const active = document.activeElement;
      const preserveSearch = active?.id === 'archiveSearch' && currentPage === 'my-reports';
      const selectionStart = preserveSearch ? active.selectionStart : null;
      const selectionEnd = preserveSearch ? active.selectionEnd : null;
      renderApp();
      if (preserveSearch) {
        const search = $('#archiveSearch');
        if (search) { search.focus({ preventScroll: true }); search.setSelectionRange(selectionStart, selectionEnd); }
      } else {
        if (collection === 'submissions') $('#mainContent').scrollTo(0, 0);
        const panel = collection === 'cashLedger' ? $('#appContent details[data-panel="cash-ledger"]') : null;
        if (panel) panel.scrollIntoView({ block: 'start', behavior: 'auto' });
        document.querySelector(`.history-controls button[data-collection="${collection}"]`)?.focus({ preventScroll: true });
      }
    })
  });
}
async function loadMoreHistory(collection, button, direction = 'next') {
  if (typeof BoundedHistory === 'undefined' || !state.user) return;
  const historyPageLifecycle = historyPageLifecycles.get(collection) || asyncLifecycle();
  historyPageLifecycles.set(collection, historyPageLifecycle);
  if (historyPageLifecycle.busy) return;
  const request = historyPageLifecycle.begin();
  setButtonBusy(button, true, 'Memuat halaman…');
  try { await BoundedHistory.load(collection, direction); }
  catch (error) { historyPageLifecycle.fail(request, error); throw error; }
  finally { if (historyPageLifecycle.current(request) && button?.isConnected) setButtonBusy(button, false); historyPageLifecycle.finish(request); }
}

function canCloseReportActivity(dialog) {
  if (typeof ReportEvidence === 'undefined' || !dialog) return true;
  if (ReportEvidence.isBusy?.(dialog)) { showToast('Tunggu pemrosesan atau unggahan nota selesai.'); return false; }
  return !ReportEvidence.hasPending?.(dialog) || window.confirm('Nota yang dipilih belum diunggah. Tutup dan buang pilihan nota?');
}
function canCloseAppDialog(dialog) {
  if (!dialog) return true;
  if (dialog.id === 'reportActivityDialog') return canCloseReportActivity(dialog);
  if (dialog.id === 'userProfileDialog') {
    if (profileDraft?.saving || profileDraft?.processing) { showToast('Tunggu pemrosesan atau penyimpanan profil selesai.'); return false; }
    if (profileDraftDirty() && !window.confirm('Perubahan profil belum disimpan. Tutup dan buang perubahan?')) return false;
  }
  if (dialog.id === 'cashTopupDialog' && cashTopupBusy) { showToast('Tunggu penambahan saldo selesai.'); return false; }
  return true;
}
async function openReportActivity(id, trigger) {
  if (!state.user || state.user.mustChangePassword) return;
  const previous = $('#reportActivityDialog');
  if (previous) { if (!canCloseReportActivity(previous)) return; previous.close(); previous.remove(); }
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog'; dialog.id = 'reportActivityDialog';
  dialog.setAttribute('aria-labelledby', 'reportActivityTitle');
  dialog.innerHTML = '<div class="dialog-panel"><div class="dialog-heading"><div><p class="choice-kicker">Riwayat aktivitas</p><h2 id="reportActivityTitle">Detail pengajuan</h2></div><button class="choice-close" type="button" data-action="close-dialog" aria-label="Tutup dialog">×</button></div><div data-report-activity-body aria-live="polite" aria-busy="true">Memuat detail…</div></div>';
  const body = dialog.querySelector('[data-report-activity-body]');
  const requestedUserId = state.user.id, requestedEpoch = authEpoch;
  const active = () => dialog.isConnected && dialog.open && state.user?.id === requestedUserId && authEpoch === requestedEpoch;
  const statuses = { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak', sent: 'Terkirim ke Finance' };
  let events = [];
  let activityPage = { nextCursor: '', previousCursor: '', hasMore: false, hasPrevious: false };
  let activityIndex = 0; const activityCursors = [''];
  let busy = false;
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => { if (!canCloseReportActivity(dialog)) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); }, { once: true });
  openDialog(dialog.id);
  async function load(cursor = '', direction = 'next') {
    if (busy || !active()) return;
    busy = true; body.setAttribute('aria-busy', 'true');
    const focusInActivity = body.contains(document.activeElement);
    const targetIndex = direction === 'before' ? Math.max(0, activityIndex - 1) : (cursor ? activityIndex + 1 : 0);
    const pageCursor = direction === 'before' ? activityCursors[targetIndex] : cursor;
    const moreButton = body.querySelector('[data-report-activity-more]');
    if (moreButton) setButtonBusy(moreButton, true, 'Memuat aktivitas…');
    try {
      const query = new URLSearchParams();
      if (pageCursor) query.set('cursor', pageCursor);
      const result = await api(`/submissions/${encodeURIComponent(id)}/activity${query.toString() ? `?${query}` : ''}`);
      if (!active()) return;
      const sub = result.submission || {};
      events = Array.isArray(result.activity) ? result.activity : [];
      activityIndex = targetIndex; activityCursors[activityIndex] = pageCursor; activityCursors.length = activityIndex + 1;
      if (activityCursors.length > 200) { activityCursors.shift(); activityIndex--; }
      activityPage = { nextCursor: result.nextCursor || '', previousCursor: activityIndex > 0 ? activityCursors[activityIndex - 1] : '', hasMore: Boolean(result.hasMore), hasPrevious: activityIndex > 0 };
      const receiptWorkspace = body.querySelector('.receipt-workspace');
      const rows = events.map(event => {
        const details = event.details || {};
        const label = event.action === 'submission.created' ? 'Pengajuan dibuat' : 'Status pengajuan berubah';
        const transition = details.to ? `${details.from ? `${statuses[details.from] || details.from} → ` : ''}${statuses[details.to] || details.to}` : '';
        return `<li><div class="audit-main"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(event.actorName || 'Sistem')}</span></div><small>${escapeHTML(dateTimeWibFull(event.createdAt))}</small>${transition ? `<p>${escapeHTML(transition)}</p>` : ''}${details.reason ? `<p>Alasan: ${escapeHTML(details.reason)}</p>` : ''}</li>`;
      }).join('');
      body.innerHTML = `<p><strong>${escapeHTML(sub.description || '')}</strong><br>${escapeHTML(reportTypeLabel(sub.type))} · ${escapeHTML(money(sub.amountIdr))} · ${escapeHTML(statuses[sub.status] || sub.status)}</p><p class="field-help">Pengaju: ${escapeHTML(sub.createdByName || '—')}${sub.createdByPosition ? ` · ${escapeHTML(sub.createdByPosition)}` : ''}</p>${sub.resolvedByName ? `<p class="field-help">Pemroses: ${escapeHTML(sub.resolvedByName)}</p>` : ''}${sub.sentByName ? `<p class="field-help">Ditandai terkirim oleh: ${escapeHTML(sub.sentByName)}</p>` : ''}${sub.note ? `<p>${escapeHTML(sub.note)}</p>` : ''}${sub.decisionReason ? `<p><strong>Alasan keputusan:</strong> ${escapeHTML(sub.decisionReason)}</p>` : ''}${rows ? `<ol class="audit-list">${rows}</ol>` : '<p class="field-help">Audit aktivitas belum tersedia. Status saat ini berasal dari pengajuan tersimpan.</p>'}<nav class="report-pagination" aria-label="Navigasi aktivitas">${activityPage.hasPrevious ? '<button class="secondary-button" type="button" data-report-activity-before>Sebelumnya</button>' : ''}${activityPage.hasMore ? '<button class="secondary-button" type="button" data-report-activity-more>Berikutnya</button>' : ''}</nav>`;
      body.querySelector('[data-report-activity-more]')?.addEventListener('click', () => load(activityPage.nextCursor, 'next'));
      body.querySelector('[data-report-activity-before]')?.addEventListener('click', () => load(activityPage.previousCursor, 'before'));
      if (receiptWorkspace) body.append(receiptWorkspace);
      else if (typeof ReportEvidence !== 'undefined') ReportEvidence.mountReceipts(body, { ...sub, id: sub.id || id });
      if (focusInActivity) (body.querySelector(direction === 'before' ? '[data-report-activity-before]' : '[data-report-activity-more]') || body.querySelector('[data-report-activity-before],[data-report-activity-more]'))?.focus({ preventScroll:true });
    } catch (error) {
      if (!active()) return;
      if (!events.length) body.textContent = friendlyError(error);
      else showToast(friendlyError(error));
    } finally {
      busy = false;
      if (active()) { body.setAttribute('aria-busy', 'false'); if (moreButton?.isConnected) setButtonBusy(moreButton, false); }
    }
  }
  await load();
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'pending-next') { void loadPendingPage('next'); return; }
  if (action === 'pending-previous') { void loadPendingPage('previous'); return; }
  if (action === 'pending-retry') { void loadPendingPage('first'); return; }
  if (action === 'check-app-update') {
    setButtonBusy(button, true, 'Memeriksa…');
    try {
      const found = await checkForAppUpdate({ force: true });
      showToast(navigator.onLine === false ? 'Tidak ada koneksi. Sambungkan internet lalu cek kembali.' : appUpdates?.lastError ? 'Pembaruan belum dapat diperiksa. Coba lagi saat koneksi tersedia.' : found ? `Pembaruan ${availableBuild} tersedia. Tekan Muat ulang.` : `Aplikasi sudah terbaru. Versi terpasang ${APP_BUILD}.`);
    } finally { if (button.isConnected) setButtonBusy(button, false); }
    return;
  }
  if (action === 'history-previous' || action === 'history-first') { await loadMoreHistory(button.dataset.collection, button, action === 'history-first' ? 'first' : 'previous'); document.querySelector(`.history-controls button[data-collection="${button.dataset.collection}"][data-action="${action}"]`)?.focus({ preventScroll:true }); if (document.activeElement === document.body) document.querySelector(`.history-controls button[data-collection="${button.dataset.collection}"]`)?.focus({preventScroll:true}); return; }
  if (action === 'refresh-cash-insights') { await loadCashInsights({ force: true }); return; }
  if (action === 'configure-cash-minimum') { configureCashMinimum(button); return; }
  if (action === 'clear-cash-minimum') { clearCashMinimum(); return; }
  if (action === 'load-more-cash-days') { state.cashInsightsDailyLimit = (state.cashInsightsDailyLimit || 14) + 14; renderCashInsightsRegion(); return; }
  const id = button.dataset.id;
  if (action === 'report-detail') { await openReportActivity(id, button);
  } else if (action === 'load-more-users' || action === 'previous-users') {
    const next = Math.max(1, Number(state.usersPage.page || 1) + (action === 'previous-users' ? -1 : 1));
    await loadUsersPageView(next);
    const selector = action === 'previous-users' ? '[data-action="previous-users"]' : '[data-action="load-more-users"]';
    (document.querySelector(`#appContent ${selector}`) || document.querySelector('#appContent [data-action="previous-users"],#appContent [data-action="load-more-users"],#usersSearch'))?.focus({ preventScroll: true });
  } else if (action === 'retry-users') {
    await loadUsersPageView();
  } else if (action === 'load-more-history') {
    const collection = button.dataset.collection;
    await loadMoreHistory(collection, button);
    (document.querySelector(`.history-controls button[data-action="load-more-history"][data-collection="${collection}"]`) || document.querySelector(`.history-controls button[data-collection="${collection}"]`))?.focus({ preventScroll: true });
  } else if (action === 'open-report-choice') {
    if (!['user', 'manager'].includes(state.user?.role) || state.user.mustChangePassword) return;
    navigateToPage('new-report');
  } else if (action === 'close-dialog') {
    if (button.closest('#userProfileDialog') && profileDraft?.saving) return;
    const dialog = button.closest('dialog');
    if (canCloseAppDialog(dialog)) dialog?.close();
  } else if (action === 'edit-user-profile') {
    openUserProfile(id);
  } else if (action === 'remove-profile-photo') {
    if (!profileDraft || profileDraft.saving || profileDraft.processing) return;
    profileDraft.photoDataUrl = null;
    $('#profilePhotoStatus').textContent = 'Foto akan dihapus setelah Simpan profil ditekan.';
    renderProfilePreview();
  } else if (action === 'approve') {
    const item = state.submissions.find(entry => entry.id === id);
    if (!item || item.createdBy === state.user.id) return;
    if (item.type === 'petty_cash' && item.amountIdr > state.cashBalanceIdr) {
      showToast('Saldo Petty Cash tidak mencukupi.');
      return;
    }
    const description = item.type === 'petty_cash'
      ? `${money(item.amountIdr)} akan dipotong dari saldo Petty Cash setelah persetujuan. Keputusan akan tercatat di ledger.`
      : `${money(item.amountIdr)} akan disetujui dan masuk ke daftar Finance. Keputusan akan tercatat.`;
    setConfirm('approve', 'Setujui pengajuan?', `${item.description}. ${description}`, item.type === 'petty_cash' ? 'Setujui & kurangi saldo' : 'Setujui pengajuan', false, { id, successMessage: item.type === 'petty_cash' ? 'Pengajuan disetujui dan debit tercatat di ledger.' : 'Pengajuan disetujui dan masuk ke Finance.' });
  } else if (action === 'reject') {
    const item = state.submissions.find(entry => entry.id === id);
    if (!item || item.createdBy === state.user.id) return;
    $('#rejectForm').dataset.id = id;
    $('#rejectDescription').textContent = `${item.description} · ${money(item.amountIdr)}. Beri alasan agar keputusan dapat ditinjau kembali.`;
    $('#rejectReason').value = '';
    openDialog('rejectDialog');
    $('#rejectReason').focus();
  } else if (action === 'send-finance') {
    const item = (typeof ManagerReportFilters !== 'undefined' ? ManagerReportFilters.findItem?.(id) : null)
      || state.submissions.find(entry => entry.id === id);
    if (!item || item.type !== 'finance_request' || item.status !== 'approved') return;
    setConfirm('send', 'Tandai terkirim ke Finance?', `${item.description} · ${money(item.amountIdr)}. Status akan berubah menjadi terkirim dan tercatat.`, 'Tandai terkirim', false, { id, successMessage: 'Status Request Finance diperbarui.' });
  } else if (action === 'open-add-user') {
    const card = $('#addUserCard');
    if (card) { card.hidden = false; $('#userName').focus(); }
  } else if (action === 'cancel-add-user') {
    if (accountDraftPresent() && !window.confirm('Buang draf akun ini?')) return;
    clearDraft(accountDraftKey());
    const card = $('#addUserCard');
    if (card) card.hidden = true;
    $('#userForm')?.reset();
  } else if (action === 'reset-user-password') {
    resetTargetId = id;
    $('#userPasswordDescription').textContent = `Atur kata sandi sementara untuk ${button.dataset.name || 'akun User'}. Kata sandi tidak dikirim melalui email; pengguna wajib menggantinya saat masuk.`;
    $('#userPasswordForm').reset();
    openDialog('userPasswordDialog');
    $('#temporaryPassword').focus();
  } else if (action === 'deactivate-user') {
    setConfirm('deactivate', 'Nonaktifkan akses pengguna?', `${button.dataset.name || 'Pengguna'} tidak dapat masuk lagi. Riwayat laporan tetap tersimpan dan aksi ini dicatat.`, 'Nonaktifkan akses', true, { id, successMessage: 'Akses akun dinonaktifkan; riwayat tetap tersimpan.' });
  } else if (action === 'download-pdf') {
    await downloadPdf(button);
  } else if (action === 'open-opening-balance') {
    if (state.user?.role !== 'manager') return;
    const openingExists = state.cashLedger.some(event => event.event_type === 'opening_balance' && Number(event.amount_idr) > 0);
    if (openingExists) { showToast('Saldo awal sudah ditetapkan.'); return; }
    $('#openingBalanceForm').reset();
    openDialog('openingBalanceDialog');
    $('#openingAmount').focus();
  } else if (action === 'open-cash-topup') {
    if (state.user?.role !== 'manager' || state.user.mustChangePassword || cashTopupBusy) return;
    const draft = readDraft('cash-topup', '');
    if (draft) { $('#cashTopupAmount').value = draft.amountIdr || ''; $('#cashTopupNote').value = draft.note || ''; cashTopupIdempotencyKey = draft.idempotencyKey || ''; cashTopupFingerprint = draft.fingerprint || ''; } else $('#cashTopupForm').reset();
    openDialog('cashTopupDialog');
    $('#cashTopupAmount').focus();
  }
}

async function logout() {
  if (transactionInFlight()) { showToast('Tunggu proses yang berjalan selesai sebelum keluar.'); return; }
  if (hasUnsavedDraft() && !window.confirm('Masih ada draf atau nota yang belum dikirim. Tetap keluar?')) return;
  const button = $('#logoutButton');
  const requestEpoch = authEpoch;
  closeDialogs({ force: true });
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
  if (navigationHistoryAvailable()) window.addEventListener('popstate', handleNavigationPop);
  window.addEventListener('beforeunload', event => {
    // Text account/report drafts already survive reload in this tab; only
    // unsaved profile edits or in-memory attachments need a native warning.
    if (!state.user || (!profileDraftDirty() && !profileDraft?.processing && !profileDraft?.saving
      && !(typeof ReportEvidence !== 'undefined' && ReportEvidence.hasPending?.()))) return;
    event.preventDefault();
    event.returnValue = '';
  });
  if (typeof FinancialControls !== 'undefined') FinancialControls.configure({
    getUser: () => state.user, api, notify: showToast, newKey: newSubmissionKey,
    onRefresh: async () => { await refreshOverview(); renderApp(); },
    navigate: page => { navigateToPage(page); },
    onChange: region => {
      if (state.user?.role !== 'manager') return;
      const finance = $('#financialControlsFinance'), overview = $('#financialControlsOverview');
      if (finance && currentPage === 'finance' && region !== 'alerts') {
        const active = document.activeElement;
        const focus = finance.contains(active) ? { form: active.closest('form')?.id, name: active.name, start: active.selectionStart, end: active.selectionEnd } : null;
        finance.innerHTML = FinancialControls.renderFinance();
        const field = focus?.form && focus.name ? document.getElementById(focus.form)?.elements.namedItem(focus.name) : null;
        if (field && !field.disabled) { field.focus({ preventScroll: true }); if (typeof focus.start === 'number' && ['text', 'search', 'textarea'].includes(field.type)) field.setSelectionRange(focus.start, focus.end); }
      }
      if (overview && currentPage === 'overview') overview.innerHTML = FinancialControls.renderOverview();
    }
  });
  if (typeof ReportEvidence !== 'undefined') ReportEvidence.configure({ getUser: () => state.user, api, notify: showToast, newKey: newSubmissionKey });

  if (typeof ManagerReportFilters !== 'undefined') ManagerReportFilters.configure({
    getUser: () => state.user, api,
    renderCard: item => submissionCard(item, { includeOwner: true, financeActions: true }),
    onError: showToast,
    onChange: () => {
      if (state.user?.role !== 'manager' || currentPage !== 'finance') return;
      const region = $('#managerReportsRegion');
      if (region) region.innerHTML = ManagerReportFilters.render();
    }
  });
  document.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-page]');
    if (pageButton && state.user) {
      const page = pageButton.dataset.page;
      if (state.user.mustChangePassword && page !== 'change-password') return;
      // Keep the legacy capability fallback for VM/test hosts that do not
      // provide History API; real browsers use the pushState path.
      if (!navigateToPage(page)) return;
      $('#mainContent').focus({ preventScroll: true });
      if (page === 'my-reports' && state.user?.role === 'user' && typeof BoundedHistory !== 'undefined') {
        configureBoundedHistory();
        void BoundedHistory.load('submissions', 'refresh');
      }
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
    else if (event.target.id === 'cashTopupForm') await performCashTopup(event);
    else if (event.target.id === 'cashMinimumForm') { event.preventDefault(); saveCashMinimum($('#cashMinimumInput')?.value); }
    else if (event.target.id === 'confirmForm') { event.preventDefault(); await performConfirmedAction(); }
  });

  document.addEventListener('input', event => {
    if (event.target.closest?.('#userForm')) persistAccountDraft();
    if (event.target.id === 'usersSearch') {
      usersPageLifecycle.cancel();
      state.usersPage = { ...state.usersPage, query: event.target.value.slice(0, 100), page: 1, loading: true, error: '' };
      window.clearTimeout(usersSearchTimer);
      const requestEpoch = authEpoch, owner = state.user?.id;
      renderUsersPageView();
      usersSearchTimer = window.setTimeout(() => {
        if (requestEpoch === authEpoch && state.user?.id === owner && currentPage === 'users') void loadUsersPageView(1);
      }, 300);
    }
    if (event.target.closest?.('#reportForm') && event.target.id !== 'reportType') persistReportDraft();
    if (event.target.closest?.('#cashTopupForm')) persistCashTopupDraft();
    if (event.target.id === 'loginIdentifier' || event.target.id === 'loginPassword') {
      $('#loginError').hidden = true;
    }
    if (event.target.id === 'archiveSearch') {
      state.archiveSearch = event.target.value;
      const result = $('#archiveResults');
      if (result) {
        if (state.user?.role === 'user' && currentPage === 'my-reports' && typeof BoundedHistory !== 'undefined') {
          window.clearTimeout(archiveSearchTimer);
          const searchEpoch = authEpoch;
          const searchOwner = state.user.id;
          archiveSearchTimer = window.setTimeout(() => {
            if (searchEpoch !== authEpoch || state.user?.id !== searchOwner || currentPage !== 'my-reports') return;
            BoundedHistory.reset();
            state.submissions = [];
            state.history.submissions = { nextCursor: null, hasMore: false, total: 0, loaded: 0 };
            configureBoundedHistory();
            void BoundedHistory.load('submissions', 'first');
          }, 250);
        }
        const selectionStart = event.target.selectionStart;
        const selectionEnd = event.target.selectionEnd;
        const updated = myReportsPage();
        $('#appContent').innerHTML = updated;
        const search = $('#archiveSearch');
        search.focus();
        search.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    if (event.target.closest?.('#cashTopupForm') && ['cashTopupAmount', 'cashTopupNote'].includes(event.target.id)) {
      cashTopupIdempotencyKey = '';
      cashTopupFingerprint = '';
    }
  });

  document.addEventListener('change', event => {
    if (!event.target.closest('#reportForm')) return;
    if (event.target.id !== 'reportType') { persistReportDraft(); return; }
    if (!validReportType(event.target.value)) return;
    // The select already contains the new type, but the other fields still
    // belong to the previous one. Save them under the previous type only.
    persistReportDraft(reportTypePreset);
    reportTypePreset = String(event.target.value);
    rememberReportType(reportTypePreset);
    submissionIdempotencyKey = reportDraft(reportTypePreset).idempotencyKey || '';
    renderApp();
    $('#reportType')?.focus({ preventScroll: true });
  });

  document.addEventListener('click', event => {
    const filter = event.target.closest('[data-report-filter]');
    if (filter) {
      state.archiveType = filter.dataset.reportFilter;
      window.clearTimeout(archiveSearchTimer);
      if (state.user?.role === 'user' && currentPage === 'my-reports' && typeof BoundedHistory !== 'undefined') {
        BoundedHistory.reset();
        state.submissions = [];
        state.history.submissions = { nextCursor: null, hasMore: false, total: 0, loaded: 0 };
        configureBoundedHistory();
        void BoundedHistory.load('submissions', 'first');
      }
      renderApp();
    }
    const dialog = event.target;
    if (dialog.id === 'userProfileDialog' && profileDraft?.saving) return;
    if (dialog instanceof HTMLDialogElement && event.target === dialog && canCloseAppDialog(dialog)) dialog.close();
  });

  document.addEventListener('error', event => {
    if (event.target.matches?.('.welcome-avatar img, .user-initial img')) event.target.remove();
  }, true);
  $('#profilePhoto').addEventListener('change', event => prepareProfilePhoto(event.target.files?.[0]));
  $('#profilePhoto').addEventListener('cancel', () => {
    if (!profileDraft || profileDraft.processing || profileDraft.saving) return;
    $('#profilePhotoStatus').textContent = profileDraft.photoDataUrl !== undefined
      ? 'Pilihan dibatalkan. Perubahan foto sebelumnya tetap tersedia; tekan Simpan profil untuk menerapkan.'
      : 'Pemilihan foto dibatalkan. Profil belum diubah; Anda dapat memilih foto lagi.';
  });
  $('#userProfileDialog').addEventListener('cancel', event => {
    if (!canCloseAppDialog(event.currentTarget)) event.preventDefault();
  });
  $('#userProfileDialog').addEventListener('close', () => {
    profileSelection += 1;
    profileDraft = null;
    $('#userProfileForm').reset();
    $('#profilePreview').replaceChildren();
    $('#profileError').hidden = true;
    $('#profileSubmit').disabled = false;
  });
  window.addEventListener('focus', () => { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(true); requestUserOverviewRefresh(); });
  window.addEventListener('pageshow', () => { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(true); requestUserOverviewRefresh(); });
  window.addEventListener('online', () => { refreshProfile(); requestManagerOverviewRefresh(true); requestUserOverviewRefresh(); });
  window.addEventListener('online', checkForAppUpdate);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(true); requestUserOverviewRefresh(); checkForAppUpdate(); }
  });
  window.setInterval(() => {
    if (!document.hidden) { updateWelcomePanel(); refreshProfile(); requestManagerOverviewRefresh(true); requestUserOverviewRefresh(); checkForAppUpdate(); }
  }, managerSyncIntervalMs);
  window.setInterval(checkForAppUpdate, updateCheckIntervalMs);

  $('#logoutButton').addEventListener('click', logout);
  $('#passkeyLoginButton').addEventListener('click', () => performPasskeyLogin());
  $('#appUpdateReload').addEventListener('click', reloadToLatestBuild);
  const offlineNotice = $('#offlineNotice');
  const updateConnectivity = () => { if (offlineNotice) offlineNotice.hidden = navigator.onLine !== false; };
  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);
  updateConnectivity();
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
  $('#cashTopupDialog').addEventListener('cancel', event => { if (!canCloseAppDialog(event.currentTarget)) event.preventDefault(); });
  $('#cashTopupDialog').addEventListener('click', event => {
    if (event.target === event.currentTarget && canCloseAppDialog(event.currentTarget)) event.currentTarget.close();
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
    await renderAfterMutation(result.alreadyApplied ? 'Saldo awal ini sudah pernah dicatat.' : 'Saldo awal dan audit tersimpan.', 'Saldo awal dan audit tersimpan. Ringkasan belum diperbarui; muat ulang saat koneksi tersedia.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    if (button.isConnected) setButtonBusy(button, false);
  }
}

async function performCashTopup(event) {
  event.preventDefault();
  if (state.user?.role !== 'manager' || cashTopupBusy) return;
  const form = $('#cashTopupForm');
  if (!form.reportValidity()) return;
  const amountIdr = Number($('#cashTopupAmount').value);
  const note = String($('#cashTopupNote').value || '').trim();
  const fingerprint = JSON.stringify({ amountIdr, note });
  if (cashTopupFingerprint !== fingerprint) {
    cashTopupFingerprint = fingerprint;
    cashTopupIdempotencyKey = newSubmissionKey();
    persistCashTopupDraft();
  }
  const button = $('#cashTopupSubmit');
  cashTopupBusy = true;
  setButtonBusy(button, true, 'Mencatat penambahan…');
  try {
    const result = await api('/cash/topups', {
      method: 'POST',
      headers: { 'Idempotency-Key': cashTopupIdempotencyKey },
      body: { amountIdr, note, confirmed: true }
    });
    clearDraft('cash-topup', '');
    cashTopupIdempotencyKey = '';
    cashTopupFingerprint = '';
    closeDialogs({ force: true });
    let refreshed = true;
    try { await refreshOverview(); } catch (error) {
      if (error?.code === 'session_changed' || !state.user) return;
      refreshed = false;
    }
    renderApp();
    showToast(!refreshed
      ? 'Penambahan saldo sudah tercatat. Ringkasan belum diperbarui; jangan kirim ulang.'
      : result.alreadyApplied ? 'Penambahan saldo ini sudah pernah dicatat.' : 'Saldo Petty Cash bertambah dan riwayat tersimpan.');
  } catch (error) {
    showToast(friendlyError(error));
  } finally {
    cashTopupBusy = false;
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
  // Start before authentication: the login screen must see updates too.
  checkForAppUpdate();
  import(`/pwa-updates.js?v=${APP_BUILD}`).then(({ createPwaUpdateCoordinator }) => {
    appUpdates = createPwaUpdateCoordinator({
      currentBuild: APP_BUILD, setAvailable: setUpdateBanner,
      isBlocked: () => transactionInFlight(),
      onError: () => { const status = $('#appUpdateCheckStatus'); if (status) status.textContent = 'Pembaruan belum dapat diperiksa. Coba lagi saat koneksi tersedia.'; }
    }).bind();
    appUpdates.check();
  }).catch(() => {});
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js')
      .then(registration => registration.update())
      .catch(() => {}));
  }
  try {
    await refreshPasskeyControls();
    const result = await api('/session');
    state.user = result.user;
    reportTypePreset = restoreReportType();
    submissionIdempotencyKey = '';
    resetNavigationSession(state.user.mustChangePassword ? 'change-password' : 'overview');
    if (state.user.mustChangePassword) {
      state.cashBalanceIdr = 0;
      state.cashFlow = { incomingIdr: '0', outgoingIdr: '0' };
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
    checkForAppUpdate();
  } catch (error) {
    showLogin(error.status === 401 ? '' : 'Layanan belum siap. Jangan gunakan data operasional sampai koneksi server tersedia.');
  } finally {
    hidePreloader();
  }
}

initialize();
