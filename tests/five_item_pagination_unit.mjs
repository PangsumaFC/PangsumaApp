import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';
import { insertSubmission, request, seededFinancialDb } from './local_financial_db.mjs';

test('pending queue has five-item bidirectional pages with exact totals and no missing records', async () => {
  const { db, managerToken, userAToken, userBToken } = await seededFinancialDb();
  for (let i=0;i<12;i++) insertSubmission(db, { id:`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`, createdBy:'user-a', type:'finance_request', status:'pending', description:`Pending record ${i}`, createdAt:'2025-02-01T00:00:00.000Z' });
  insertSubmission(db, { id:'approved-excluded',createdBy:'user-a',type:'finance_request',status:'approved' });
  async function page(token, cursor='', direction='after') {
    const params=new URLSearchParams({status:'pending',direction}); if(cursor) params.set('cursor',cursor);
    const response=await onRequest({request:request(`/submissions?${params}`,token),env:{DB:db}});
    assert.equal(response.status,200); return response.json();
  }
  const first=await page(managerToken); assert.equal(first.submissions.length,5); assert.equal(first.total,12); assert.equal(first.hasPrevious,false); assert.equal(first.hasMore,true);
  const second=await page(managerToken,first.nextCursor); assert.equal(second.submissions.length,5); assert.equal(second.hasMore,true); assert.equal(second.hasPrevious,true);
  const third=await page(managerToken,second.nextCursor); assert.equal(third.submissions.length,2); assert.equal(third.hasMore,false); assert.equal(third.hasPrevious,true);
  const all=[...first.submissions,...second.submissions,...third.submissions]; assert.equal(new Set(all.map(x=>x.id)).size,12); assert.ok(all.every(x=>x.status==='pending'));
  const back=await page(managerToken,third.previousCursor,'before'); assert.deepEqual(back.submissions.map(x=>x.id),second.submissions.map(x=>x.id)); assert.equal(back.hasMore,true); assert.equal(back.hasPrevious,true);
  const home=await page(managerToken,back.previousCursor,'before'); assert.deepEqual(home.submissions.map(x=>x.id),first.submissions.map(x=>x.id)); assert.equal(home.hasMore,true); assert.equal(home.hasPrevious,false);
  const own=await page(userAToken); assert.equal(own.total,12); assert.equal(own.submissions.length,5);
  const other=await page(userBToken); assert.equal(other.total,0); assert.deepEqual(other.submissions,[]);
});
