import { ApiError, isValidIsoDate } from './http.js';
import { sha256Hex } from './auth.js';

const SETTINGS_MIGRATION = '0008_financial_alert_settings.sql';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DAYS = 3650;
const REQUIRED_COLUMNS = ['id','minimum_cash_idr','pending_max_days','version','updated_by','updated_at','idempotency_key','payload_hash'];
const REQUIRED_TRIGGERS = ['financial_settings_audit_update','financial_settings_append_only_update','financial_settings_append_only_delete','financial_settings_manager_guard'];

function actor(user) { if (!user || !user.id || !['user','manager'].includes(user.role)) throw new ApiError(403, 'forbidden', 'Akses ditolak.'); return user; }
async function schema(db) {
  try {
    const table = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='financial_alert_settings'").first();
    const cols = await db.prepare('PRAGMA table_info(financial_alert_settings)').all();
    if (!table || !REQUIRED_COLUMNS.every(c => (cols.results || []).some(x => x.name === c))) throw new Error('schema');
    const triggers = await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all();
    if (!REQUIRED_TRIGGERS.every(t => (triggers.results || []).some(x => x.name === t))) throw new Error('trigger');
    await db.prepare('SELECT id, CAST(minimum_cash_idr AS TEXT) AS minimum_cash_idr, pending_max_days, version, updated_by, updated_at FROM financial_alert_settings LIMIT 0').all();
  } catch { throw new ApiError(503, 'migration_required', `Database belum siap: migrasi ${SETTINGS_MIGRATION} harus diterapkan.`); }
}
function output(row) { return { minimumCashIdr: row.minimum_cash_idr == null ? null : String(row.minimum_cash_idr), pendingMaxDays: row.pending_max_days == null ? null : Number(row.pending_max_days), version: Number(row.version), updatedBy: row.updated_by || null, updatedAt: row.updated_at, scope: 'organization' }; }
async function current(db) { return db.prepare('SELECT id, CAST(minimum_cash_idr AS TEXT) AS minimum_cash_idr, pending_max_days, version, updated_by, updated_at, idempotency_key, payload_hash FROM financial_alert_settings WHERE id = ?').bind('operational').first(); }
function validSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_settings', 'Pengaturan tidak valid.');
  if (!Object.hasOwn(body,'minimumCashIdr') || !Object.hasOwn(body,'pendingMaxDays') || Object.keys(body).some(k => !['minimumCashIdr','pendingMaxDays','expectedVersion'].includes(k))) throw new ApiError(400, 'invalid_settings', 'Kirim kedua pengaturan secara eksplisit.');
  const cash = body.minimumCashIdr; let minimumCashIdr = null;
  if (cash !== null && cash !== undefined) {
    if (typeof cash === 'number' && !Number.isSafeInteger(cash)) throw new ApiError(400, 'invalid_minimum_cash', 'Batas kas minimum tidak valid.');
    if (!(typeof cash === 'string' || typeof cash === 'number') || !/^\d+$/.test(String(cash))) throw new ApiError(400, 'invalid_minimum_cash', 'Batas kas minimum tidak valid.');
    const n = BigInt(String(cash)); if (n < 0n || n > MAX_SAFE) throw new ApiError(400, 'invalid_minimum_cash', 'Batas kas minimum tidak valid.');
    minimumCashIdr = n.toString();
  }
  const days = body.pendingMaxDays; let pendingMaxDays = null;
  if (days !== null && days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS)) throw new ApiError(400, 'invalid_pending_max_days', 'Batas hari pending harus 1–3650.');
  if (days !== null && days !== undefined) pendingMaxDays = days;
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new ApiError(400, 'invalid_expected_version', 'expectedVersion wajib berupa versi valid.');
  return { minimumCashIdr, pendingMaxDays, expectedVersion: body.expectedVersion };
}
function now(context) { return context?.nowISO || new Date().toISOString(); }
function suppliedKey(context) { return context?.idempotencyKey || context?.request?.headers?.get?.('Idempotency-Key') || null; }
function makeKey(context, manager) { const key = suppliedKey(context); if (key && !UUID.test(key)) throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key harus UUID.'); return key || (globalThis.crypto?.randomUUID?.() || `local-${now(context)}-${manager.id}`); }
function sameValues(row, next) { return String(row.minimum_cash_idr ?? '') === String(next.minimumCashIdr ?? '') && (row.pending_max_days == null ? null : Number(row.pending_max_days)) === next.pendingMaxDays; }

export async function getFinancialSettings(context, db, user) { const me = actor(user); if (me.role !== 'manager') throw new ApiError(403, 'manager_required', 'Hanya manager yang dapat melihat pengaturan.'); await schema(db); const row = await current(db); if (!row) throw new ApiError(503, 'migration_required', 'Pengaturan belum tersedia.'); return output(row); }
export async function updateFinancialSettings(context, db, user) {
  const me = actor(user); if (me.role !== 'manager') throw new ApiError(403, 'manager_required', 'Hanya manager yang dapat mengubah pengaturan.'); await schema(db);
  const next = validSettings(context?.body || context?.json || {}); const old = await current(db); if (!old) throw new ApiError(503, 'migration_required', 'Pengaturan belum tersedia.');
  const key = makeKey(context, me); const payloadHash = await sha256Hex(JSON.stringify({ minimumCashIdr: next.minimumCashIdr, pendingMaxDays: next.pendingMaxDays }));
  const history = await db.prepare('SELECT manager_id,payload_hash,version_after FROM financial_settings_changes WHERE idempotency_key = ?').bind(key).first();
  if (history) {
    if (history.payload_hash !== payloadHash || history.manager_id !== me.id) throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key sudah digunakan untuk payload lain.');
    const actual = output(await current(db)); return { ...actual, alreadyApplied: true, appliedVersion: Number(history.version_after) };
  }
  if (sameValues(old, next)) return output(old);
  if (Number(old.version) !== next.expectedVersion) throw new ApiError(409, 'version_conflict', 'Pengaturan berubah. Muat ulang lalu coba lagi.');
  const updatedAt = now(context);
  try {
    const result = await db.prepare("UPDATE financial_alert_settings SET minimum_cash_idr=?, pending_max_days=?, version=version+1, updated_by=?, updated_at=?, idempotency_key=?, payload_hash=? WHERE id='operational' AND version=?").bind(next.minimumCashIdr, next.pendingMaxDays, me.id, updatedAt, key, payloadHash, next.expectedVersion).run();
    if (!result?.meta?.changes) throw new ApiError(409, 'version_conflict', 'Pengaturan berubah. Muat ulang lalu coba lagi.');
  } catch (e) { if (e instanceof ApiError) throw e; if (/unique|constraint|version/i.test(String(e?.message))) throw new ApiError(409, 'version_conflict', 'Pengaturan berubah. Muat ulang lalu coba lagi.'); throw e; }
  const row = await current(db); return output(row);
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 1000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(cursor)) throw new Error();
    const raw = Buffer.from(cursor, 'base64url').toString('utf8'); const x = JSON.parse(raw);
    if (!x || typeof x.createdAt !== 'string' || !isValidIsoDate(x.createdAt.slice(0,10)) || typeof x.id !== 'string' || !x.checkedAt || !Number.isSafeInteger(x.settingsVersion) || !['manager','user'].includes(x.actorRole) || typeof x.actorId !== 'string') throw new Error();
    return x;
  } catch { throw new ApiError(400, 'invalid_cursor', 'Cursor tidak valid.'); }
}
function encodeCursor(x) { return Buffer.from(JSON.stringify(x)).toString('base64url'); }
function intString(value) { try { const n=BigInt(String(value)); if (n < 0n || n > MAX_SAFE) throw new Error('range'); return n.toString(); } catch { throw new ApiError(500, 'invalid_account_balance', 'Nilai moneter tidak valid.'); } }
export async function getFinancialAlerts(context, db, user) {
  const me = actor(user); await schema(db); const row = await current(db); if (!row) throw new ApiError(503,'migration_required','Pengaturan belum tersedia.'); const settings=output(row);
  const account = await db.prepare("SELECT CAST(balance_idr AS TEXT) AS balance_idr FROM cash_accounts WHERE id='operational'").first();
  if (!account || account.balance_idr == null) throw new ApiError(503,'account_unavailable','Akun kas operasional tidak tersedia.');
  let balance; try { balance=intString(account.balance_idr); } catch(e) { throw e; }
  const cash = me.role === 'manager' ? { configured: settings.minimumCashIdr !== null, thresholdIdr: settings.minimumCashIdr, balanceIdr: balance, isLow: settings.minimumCashIdr === null ? null : BigInt(balance) < BigInt(settings.minimumCashIdr) } : { configured:false, thresholdIdr:null, balanceIdr:null, isLow:null };
  const checkedAt=now(context); const cutoff=settings.pendingMaxDays==null?null:new Date(new Date(checkedAt).getTime()-settings.pendingMaxDays*86400000).toISOString(); const owner=me.role==='manager'?'':' AND s.created_by = ?'; const ownerArgs=me.role==='manager'?[]:[me.id];
  const count=await db.prepare(`SELECT COUNT(*) AS total, MIN(created_at) AS oldest FROM submissions s WHERE s.status='pending'${owner}`).bind(...ownerArgs).first();
  const overdue=cutoff?await db.prepare(`SELECT COUNT(*) AS total FROM submissions s WHERE s.status='pending' AND s.created_at <= ?${owner}`).bind(cutoff,...ownerArgs).first():{total:0};
  const cur=decodeCursor(context?.cursor); if(cur && (cur.settingsVersion!==settings.version || cur.actorRole!==me.role || cur.actorId!==me.id)) throw new ApiError(400,'invalid_cursor','Cursor tidak sesuai permintaan.');
  const effectiveCheckedAt=cur?.checkedAt || checkedAt; const effectiveCutoff=settings.pendingMaxDays==null?null:new Date(new Date(effectiveCheckedAt).getTime()-settings.pendingMaxDays*86400000).toISOString();
  const ageClause = effectiveCutoff ? ' AND s.created_at <= ?' : '';
  const clause=cur?' AND (s.created_at > ? OR (s.created_at = ? AND s.id > ?))':''; const args=['pending']; args.push(...ownerArgs); if(effectiveCutoff) args.push(effectiveCutoff); if(cur) args.push(cur.createdAt,cur.createdAt,cur.id);
  const rows=effectiveCutoff ? await db.prepare(`SELECT s.id,s.description,s.amount_idr,s.created_at,s.created_by,u.name AS created_by_name FROM submissions s LEFT JOIN users u ON u.id=s.created_by WHERE s.status=?${owner}${ageClause}${clause} ORDER BY s.created_at ASC,s.id ASC LIMIT 26`).bind(...args).all() : { results: [] };
  const list=rows.results||[], page=list.slice(0,25), hasMore=list.length>25;
  return { cash, pending:{configured:settings.pendingMaxDays!==null,maxDays:settings.pendingMaxDays,totalPending:Number(count?.total||0),overdueCount:Number(overdue?.total||0),oldestPendingAt:count?.oldest||null,items:settings.pendingMaxDays===null?[]:page.filter(r=>r.created_at<=effectiveCutoff).map(r=>({id:r.id,description:r.description,amountIdr:intString(r.amount_idr),createdAt:r.created_at,waitingDays:Math.max(0,Math.floor((new Date(effectiveCheckedAt)-new Date(r.created_at))/86400000)),createdByName:r.created_by_name||null})),hasMore:settings.pendingMaxDays===null?false:hasMore,nextCursor:hasMore?encodeCursor({createdAt:page.at(-1).created_at,id:page.at(-1).id,checkedAt:effectiveCheckedAt,settingsVersion:settings.version,actorRole:me.role,actorId:me.id}):null},checkedAt:effectiveCheckedAt};
}
function normalize(text) { return String(text??'').normalize('NFKC').toLocaleLowerCase('id-ID').replace(/[\p{P}\p{S}]+/gu,' ').replace(/\s+/g,' ').trim(); }
const STOP=new Set(['untuk','yang','dan','dari','dengan','pada','ke','di','the','a','an']); function tokens(text){return new Set(normalize(text).split(' ').filter(x=>x.length>=3&&!STOP.has(x)));}
function similarity(a,b){const na=normalize(a),nb=normalize(b);if(!na||!nb)return 0;if(na===nb)return 1;const A=tokens(a),B=tokens(b);let shared=0;for(const x of A)if(B.has(x))shared++;const union=new Set([...A,...B]).size;const j=union?shared/union:0;return j>=.5&&shared>=2?Math.min(1,.5+j/2):((na.includes(nb)||nb.includes(na))?.6:0);}
function dateDistance(a,b){return Math.abs((Date.parse(`${a}T00:00:00Z`)-Date.parse(`${b}T00:00:00Z`))/86400000);}
export async function findPotentialDuplicates(context,db,user){
  const me=actor(user),body=context?.body||context?.json||{}; if(!body||Array.isArray(body)||!['petty_cash','finance_request'].includes(body.type)||!Number.isSafeInteger(body.amountIdr)||body.amountIdr<=0||!isValidIsoDate(body.date)||typeof body.description!=='string'||normalize(body.description).length<3|| (body.excludeId!==undefined&&(!/^(?!.*[\u0000-\u001f\u007f])[\s\S]{1,100}$/u.test(String(body.excludeId))))) throw new ApiError(400,'invalid_duplicate_check','Data pemeriksaan duplikasi tidak valid.');
  const center=Date.parse(`${body.date}T00:00:00Z`),start=new Date(center-3*86400000).toISOString().slice(0,10),end=new Date(center+3*86400000).toISOString().slice(0,10); let where=`s.type=? AND s.amount_idr=? AND s.date BETWEEN ? AND ?`;const baseArgs=[body.type,body.amountIdr,start,end];if(me.role!=='manager'){where+=' AND s.created_by=?';baseArgs.push(me.id);}if(body.excludeId!==undefined){where+=' AND s.id<>?';baseArgs.push(String(body.excludeId));}
  const maxRow=await db.prepare(`SELECT COALESCE(MAX(rowid),0) AS max_rowid FROM submissions s WHERE ${where}`).bind(...baseArgs).first(); const cutoff=Number(maxRow?.max_rowid||0); let last=0,examined=0,matchingCount=0,matches=[];
  while(last<cutoff){ const page=await db.prepare(`SELECT s.rowid AS scan_rowid,s.id,s.type,s.date,s.amount_idr,s.description,s.status,s.created_by,u.name AS created_by_name,u.role AS created_by_role FROM submissions s LEFT JOIN users u ON u.id=s.created_by WHERE ${where} AND s.rowid>? AND s.rowid<=? ORDER BY s.rowid ASC LIMIT 500`).bind(...baseArgs,last,cutoff).all(); const rows=page.results||[]; if(!rows.length)break; for(const r of rows){last=Number(r.scan_rowid);examined++;const sim=similarity(body.description,r.description);if(sim<=0)continue;matchingCount++;matches.push({id:r.id,type:r.type,date:r.date,amountIdr:intString(r.amount_idr),description:r.description,status:r.status,createdByName:r.created_by_name||null,createdByRole:r.created_by_role||null,similarity:Number(sim.toFixed(3)),reason:'Tanggal, nominal, dan keperluan mirip',dateDistanceDays:dateDistance(body.date,r.date)}); if(matches.length>40) { matches.sort((a,b)=>b.similarity-a.similarity||a.dateDistanceDays-b.dateDistanceDays||a.id.localeCompare(b.id)); matches=matches.slice(0,20); } } if(rows.length<500)break; }
  matches.sort((a,b)=>b.similarity-a.similarity||a.dateDistanceDays-b.dateDistanceDays||a.id.localeCompare(b.id)); return {matches:matches.slice(0,20),totalCandidateCount:examined,matchingCount,hasMoreCandidates:matchingCount>20,examinedCount:examined};
}
export const __test={normalize,similarity};
