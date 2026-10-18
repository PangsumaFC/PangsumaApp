import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const app = fs.readFileSync(path.join(process.cwd(), 'site/app.js'), 'utf8');

function fakeHistory() {
  const entries = [{ state: null }];
  let index = 0;
  const listeners = [];
  const dispatch = () => listeners.forEach(listener => listener({ state: entries[index].state }));
  return {
    entries,
    get index() { return index; },
    addEventListener(type, listener) { if (type === 'popstate') listeners.push(listener); },
    pushState(state) { entries.splice(index + 1); entries.push({ state }); index++; },
    replaceState(state) { entries[index] = { state }; },
    back() { if (index) { index--; dispatch(); } },
    forward() { if (index < entries.length - 1) { index++; dispatch(); } },
  };
}

test('navigation writes only enum page/session state and Back restores without pushing', () => {
  const history = fakeHistory();
  const session = 's1';
  const allowed = new Set(['overview', 'finance', 'new-report']);
  let page = 'overview';
  const push = next => {
    if (!allowed.has(next) || next === page) return;
    page = next;
    history.pushState({ pangsumaNavigation: true, session, page });
  };
  history.replaceState({ pangsumaNavigation: true, session, page });
  push('finance');
  push('new-report');
  assert.equal(history.entries.length, 3);
  history.addEventListener('popstate', event => {
    if (event.state?.session === session && allowed.has(event.state.page)) page = event.state.page;
  });
  history.back();
  assert.equal(page, 'finance');
  assert.equal(history.entries.length, 3);
  history.back();
  assert.equal(page, 'overview');
});

test('tab and standalone mocks both expose guarded popstate integration', () => {
  assert.match(app, /typeof window !== 'undefined' && window\.history/);
  assert.match(app, /window\.addEventListener\('popstate', handleNavigationPop\)/);
  assert.match(app, /fromPop: true/);
  assert.match(app, /navigationPages = new Set/);
});

test('session reset invalidates protected historical entries without data mutation', () => {
  const history = fakeHistory();
  history.replaceState({ pangsumaNavigation: true, session: 'old', page: 'finance' });
  const protectedData = { amount: 123, receipt: 'kept-out-of-history' };
  let user = { id: 'u1' };
  let session = 'new';
  let restored = false;
  history.addEventListener('popstate', event => {
    if (user && event.state?.session === session) restored = true;
  });
  history.pushState({ pangsumaNavigation: true, session: 'old', page: 'new-report' });
  user = null;
  history.back();
  assert.equal(restored, false);
  assert.deepEqual(protectedData, { amount: 123, receipt: 'kept-out-of-history' });
  assert.doesNotMatch(JSON.stringify(history.entries), /123|receipt/);
});

test('native boundary remains available when no prior app entry exists', () => {
  const history = fakeHistory();
  history.pushState({ pangsumaNavigation: true, session: 's', page: 'overview' });
  history.back();
  assert.equal(history.index, 0);
  assert.equal(history.entries[0].state, null);
});

test('nonmenu view changes use the shared guarded navigation helper', () => {
  assert.match(app, /navigate:\s*page\s*=>\s*\{\s*navigateToPage\(page\);\s*\}/);
  assert.match(app, /action === 'open-report-choice'[\s\S]{0,300}navigateToPage\('new-report'\)/);
  assert.match(app, /navigateToPage\('overview', \{ replace: true \}\)/);
  assert.match(app, /const successPage = state\.user\.role === 'manager' \? 'overview' : 'my-reports'/);
  assert.match(app, /navigateToPage\(successPage, \{ replace: true \}\)/);
});

test('role-disallowed pages are rejected before a history entry can be written', () => {
  const allowed = role => role === 'manager'
    ? new Set(['overview', 'approvals', 'finance', 'users', 'change-password', 'new-report'])
    : new Set(['overview', 'my-reports', 'change-password', 'new-report']);
  const history = fakeHistory();
  let role = 'user';
  let page = 'overview';
  const navigate = next => {
    if (!allowed(role).has(next) || next === page) return false;
    page = next;
    history.pushState({ pangsumaNavigation: true, session: 's', page });
    return true;
  };
  assert.equal(navigate('finance'), false);
  assert.equal(history.entries.length, 1);
  assert.equal(navigate('my-reports'), true);
  assert.equal(history.entries.length, 2);
});
