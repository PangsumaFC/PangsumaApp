import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness() {
  const item = { id: 'older-pending', status: 'pending', type: 'petty_cash', createdBy: 'fixture-user', amountIdr: 12000, description: 'Synthetic older request' };
  const state = {
    user: { id: 'fixture-manager', role: 'manager' }, cashBalanceIdr: 50000,
    submissions: Array.from({ length: 5 }, (_, i) => ({ id: `recent-${i}`, status: 'approved' })),
    pendingSubmissions: [item],
  };
  const confirms = [], dialogs = [], messages = [], requests = [];
  const elements = Object.fromEntries(['#rejectForm', '#rejectDescription', '#rejectReason'].map(id => [id, { dataset: {}, value: 'old draft', focus() { this.focused = true; } }]));
  const context = vm.createContext({ state, $: id => elements[id], showToast: text => messages.push(text), money: value => `Rp ${value}`, setConfirm: (...args) => confirms.push(args), openDialog: id => dialogs.push(id), api: (...args) => requests.push(args) });
  vm.runInContext(['pendingApprovalItems', 'currentApprovalItem', 'handleAction'].filter(name => source.includes(`function ${name}(`)).map(extract).join('\n'), context);
  return { state, item, confirms, dialogs, messages, requests, elements, run: (action, id = item.id) => context.handleAction({ dataset: { action, id } }) };
}
for (const action of ['approve', 'reject']) {
  test(`${action}: pending absent from five recent history rows opens correct dialog without mutation`, async () => {
    const h = harness();
    assert.equal(h.state.submissions.length, 5);
    assert.ok(!h.state.submissions.some(row => row.id === h.item.id));
    await h.run(action);
    if (action === 'approve') {
      assert.equal(h.confirms.length, 1);
      assert.equal(h.confirms[0][0], 'approve');
      assert.equal(h.confirms[0][5].id, h.item.id);
      assert.match(h.confirms[0][2], /Synthetic older request.*12000/);
    } else {
      assert.deepEqual(h.dialogs, ['rejectDialog']);
      assert.equal(h.elements['#rejectForm'].dataset.id, h.item.id);
      assert.match(h.elements['#rejectDescription'].textContent, /Synthetic older request.*12000/);
      assert.equal(h.elements['#rejectReason'].value, '');
      assert.equal(h.elements['#rejectReason'].focused, true);
    }
    assert.deepEqual(h.requests, []);
  });
  for (const reason of ['missing', 'resolved', 'no-longer-on-page']) {
    test(`${action}: ${reason} item reports unavailable and never falls back to stale history`, async () => {
      const h = harness();
      h.state.submissions[0] = { ...h.item };
      if (reason === 'resolved') h.item.status = 'approved';
      else h.state.pendingSubmissions = [];
      await h.run(action);
      assert.equal(h.confirms.length + h.dialogs.length, 0);
      assert.match(h.messages[0], /sudah tidak tersedia.*Muat ulang antrean/);
      assert.deepEqual(h.requests, []);
    });
  }
  test(`${action}: current queue wins over conflicting recent history`, async () => {
    const h = harness();
    h.state.submissions[0] = { ...h.item, amountIdr: 999999, description: 'Stale history', status: 'approved' };
    await h.run(action);
    const description = action === 'approve' ? h.confirms[0][2] : h.elements['#rejectDescription'].textContent;
    assert.match(description, /Synthetic older request/);
    assert.doesNotMatch(description, /Stale history/);
  });
  test(`${action}: own submission remains blocked`, async () => {
    const h = harness(); h.item.createdBy = h.state.user.id;
    await h.run(action);
    assert.equal(h.confirms.length + h.dialogs.length, 0);
    assert.deepEqual(h.requests, []);
  });
  test(`${action}: legacy overview without separate queue uses same pending source as renderer`, async () => {
    const h = harness(); delete h.state.pendingSubmissions;
    h.state.submissions = [h.item]; await h.run(action);
    assert.equal(h.confirms.length + h.dialogs.length, 1);
  });
}
test('approval still blocks insufficient Petty Cash while rejection remains available', async () => {
  const h = harness(); h.state.cashBalanceIdr = 0;
  await h.run('approve');
  assert.deepEqual(h.messages, ['Saldo Petty Cash tidak mencukupi.']);
  assert.equal(h.confirms.length, 0);
  await h.run('reject'); assert.deepEqual(h.dialogs, ['rejectDialog']);
});
test('Finance request approval does not require Petty Cash balance', async () => {
  const h = harness(); h.item.type = 'finance_request'; h.state.cashBalanceIdr = 0;
  await h.run('approve'); assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0][2], /daftar Finance/);
});
