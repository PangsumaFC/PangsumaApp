import { ApiError, ensureMethod, jsonResponse, readJson } from './http.js';
import { sha256Hex } from './auth.js';
import { decode as decodePng } from 'fast-png';
import jpeg from 'jpeg-js';
import { dropboxEnabled, dropboxPath, isCanonicalRequestNumber, pushReceiptToDropbox, validateDropboxUrl } from './dropbox-receipts.js';

export const RECEIPT_MAX_COUNT = 10;
export const RECEIPT_MAX_BYTES = 512 * 1024;
const REQUEST_MAX_BYTES = 800 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (b, a, n) => String.fromCharCode(...b.subarray(a, a + n));
const validationMessages = {
  invalid_mime_type: 'Jenis lampiran tidak didukung. Gunakan foto JPG atau PNG.',
  invalid_filename: 'Nama file foto tidak valid. Pilih kembali foto dengan nama hingga 180 karakter.',
  invalid_base64: 'Data foto kosong, rusak, atau melebihi batas 512 KB setelah diproses. Pilih kembali foto.',
  receipt_too_large: 'Foto hasil pemrosesan harus berisi data dan berukuran hingga 512 KB.',
  invalid_receipt_image: 'Isi foto tidak dapat divalidasi sebagai JPG/PNG yang utuh. Pilih kembali foto yang valid.',
  receipt_decode_limit: 'Foto melebihi batas pemrosesan server. Perkecil resolusi foto lalu coba lagi.'
};
const fail = (code, message = validationMessages[code] || 'Lampiran tidak valid.') => { throw new ApiError(400, code, message); };

function dbError(error) {
  const message = String(error?.message || error);
  if (/submission_receipt_limit/i.test(message)) throw new ApiError(409, 'receipt_limit_reached', 'Maksimal 10 foto nota per pengajuan.');
  if (/receipt_uploader_inactive|active_uploader/i.test(message)) throw new ApiError(403, 'forbidden', 'Akun pengunggah tidak aktif.');
  if (/no such table|no such trigger/i.test(message)) {
    throw new ApiError(503, 'receipt_storage_unavailable', 'Penyimpanan lampiran belum tersedia.');
  }
  throw error;
}
async function query(db, sql, ...args) { try { return await db.prepare(sql).bind(...args).first(); } catch (e) { return dbError(e); } }
async function all(db, sql, ...args) { try { return (await db.prepare(sql).bind(...args).all()).results || []; } catch (e) { return dbError(e); } }
async function run(db, sql, ...args) { try { return await db.prepare(sql).bind(...args).run(); } catch (e) { return dbError(e); } }

async function activeActor(db, actor) {
  if (!actor || typeof actor.id !== 'string' || !['user', 'manager'].includes(actor.role))
    throw new ApiError(401, 'authentication_required', 'Autentikasi diperlukan.');
  const row = await query(db, 'SELECT id, name, role, is_active FROM users WHERE id = ? LIMIT 1', actor.id);
  if (!row || !row.is_active || row.role !== actor.role) throw new ApiError(401, 'authentication_required', 'Autentikasi diperlukan.');
  return row;
}
async function visibleSubmission(db, actor, submissionId) {
  if (typeof submissionId !== 'string' || submissionId.length > 160) throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
  const row = await query(db, 'SELECT id, created_by FROM submissions WHERE id = ? LIMIT 1', submissionId);
  if (!row || (actor.role !== 'manager' && row.created_by !== actor.id)) throw new ApiError(404, 'submission_not_found', 'Pengajuan tidak ditemukan.');
  return row;
}
async function requestNumber(db, submissionId) {
  try {
    const row = await db.prepare('SELECT request_number FROM submissions WHERE id = ? LIMIT 1').bind(submissionId).first();
    return { available: true, value: row?.request_number || null };
  } catch (error) {
    if (/no such column: request_number/i.test(String(error?.message || error))) return { available: false, value: null };
    throw error;
  }
}
function validatedExtension(filename, mime) {
  const match = /\.(jpg|jpeg|png)$/i.exec(filename);
  if (!match || (mime === 'image/png' && match[1].toLowerCase() !== 'png') ||
      (mime === 'image/jpeg' && !['jpg', 'jpeg'].includes(match[1].toLowerCase())))
    fail('invalid_filename', 'Ekstensi file harus cocok dengan MIME gambar.');
  return `.${match[1].toLowerCase()}`;
}
function metadata(row) {
  return { id: row.id, submissionId: row.submission_id, filename: row.filename, mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes), width: Number(row.width), height: Number(row.height), sha256: row.sha256,
    uploadedBy: row.uploaded_by, uploadedByName: row.uploaded_by_name || '', createdAt: row.created_at,
    url: `/api/receipts/${encodeURIComponent(row.id)}`,
    ...(row.dropbox_state ? { storageStatus: row.dropbox_state, ...(row.dropbox_state === 'ready' && validateDropboxUrl(row.dropbox_url) ? { dropboxUrl: row.dropbox_url } : {}) } : {}) };
}
const receiptSelect = `SELECT r.id,r.submission_id,r.uploaded_by,r.filename,r.mime_type,r.size_bytes,r.width,r.height,r.sha256,r.created_at,r.idempotency_key,r.payload_hash,u.name uploaded_by_name FROM submission_receipts r JOIN users u ON u.id=r.uploaded_by`;
const receiptSelectWithDropbox = receiptSelect.replace(' FROM submission_receipts', ', dm.state dropbox_state, dm.public_url dropbox_url, dm.dropbox_path FROM submission_receipts') + ' LEFT JOIN receipt_dropbox_metadata dm ON dm.receipt_id=r.id';

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) { c ^= bytes[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function pngInfo(input) {
  const b = input; if (b.length < 33 || text(b, 0, 8) !== '\x89PNG\r\n\x1a\n') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength); let p = 8, ihdr = false, idat = false, iend = false, kept = [];
  while (p + 12 <= b.length) {
    const n = v.getUint32(p), type = text(b, p + 4, 4), end = p + 12 + n;
    if (end > b.length || !/^[A-Za-z]{4}$/.test(type) || v.getUint32(p + 8 + n) !== crc32(b, p + 4, p + 8 + n)) return null;
    if (type === 'IHDR') { if (ihdr || n !== 13) return null; ihdr = true; const w=v.getUint32(p+8),h=v.getUint32(p+12); if (!w||!h||w>4096||h>4096||w*h>16_000_000||b[p+16]!==8) return null; kept.push(b.slice(p,end)); }
    else if (type === 'IDAT') { idat = true; kept.push(b.slice(p,end)); }
    else if (type === 'IEND') { if (n || iend || !ihdr || !idat || end !== b.length) return null; iend=true; kept.push(b.slice(p,end)); }
    else if (['PLTE','tRNS'].includes(type)) kept.push(b.slice(p,end));
    p=end;
  }
  if (p !== b.length || !iend) return null;
  try { const decoded = decodePng(b, { checkCrc: true }); if (!decoded || decoded.width > 4096 || decoded.height > 4096 || decoded.data.length < decoded.width * decoded.height) return null; } catch { return null; }
  const view = new DataView(b.buffer,b.byteOffset,b.byteLength); return { width:view.getUint32(16), height:view.getUint32(20), bytes: b };
}
function pngSanitize(b, info) {
  const chunks = [b.slice(0,8)]; let p=8, v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  while (p+12<=b.length) { const n=v.getUint32(p), type=text(b,p+4,4), end=p+12+n; if (['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type)) chunks.push(b.slice(p,end)); p=end; }
  const out = new Uint8Array(chunks.reduce((n,x)=>n+x.length,0)); let q=0; for(const x of chunks){out.set(x,q);q+=x.length;} return out;
}
function jpegInfo(input) {
  const b=input; if (b.length<4||b[0]!==0xff||b[1]!==0xd8) return null; let p=2,w=0,h=0,sawSof=false;
  while (p < b.length) {
    if (b[p++]!==0xff) return null; while (b[p]===0xff) p++; const m=b[p++];
    if (m===0xd9) return sawSof && p===b.length ? {width:w,height:h,bytes:b} : null;
    if (m===0xda) { if (p+2>b.length) return null; const n=(b[p]<<8)|b[p+1]; if(n<2||p+n>b.length) return null; p+=n; while(p+1<b.length){ if(b[p]===0xff && b[p+1]!==0){ if(b[p+1]===0xd9){ if(p+2!==b.length)return null; return sawSof?{width:w,height:h,bytes:b}:null;} return null; } p++; } return null; }
    if (m===0x01 || (m>=0xd0&&m<=0xd7)) continue;
    if (p+2>b.length) return null; const n=(b[p]<<8)|b[p+1]; if(n<2||p+n>b.length)return null;
    if ((m>=0xc0&&m<=0xc3)||(m>=0xc5&&m<=0xc7)||(m>=0xc9&&m<=0xcb)||(m>=0xcd&&m<=0xcf)) { if(n<8||b[p+2]!==8)return null; h=(b[p+3]<<8)|b[p+4];w=(b[p+5]<<8)|b[p+6];if(!w||!h||w>4096||h>4096||w*h>16_000_000)return null;sawSof=true; }
    p+=n;
  } return null;
}
function sanitizeJpeg(b, info) {
  const chunks=[b.slice(0,2)]; let p=2;
  while(p<b.length){ if(b[p++]!==0xff)return b; while(b[p]===0xff)p++; const m=b[p++]; if(m===0xda){chunks.push(b.slice(p-2)); return concat(chunks);} if(m===0xd9){chunks.push(b.slice(p-2));break;} if(m===1||(m>=0xd0&&m<=0xd7)){chunks.push(b.slice(p-2));continue;} const n=(b[p]<<8)|b[p+1]; if(!n||p+n>b.length)return b; if(m!==0xe1&&m!==0xed)chunks.push(b.slice(p-2,p+n)); p+=n; } return concat(chunks); }
function concat(parts,last=new Uint8Array(0)){const out=new Uint8Array(parts.reduce((n,x)=>n+x.length,0)+last.length);let p=0;for(const x of parts){out.set(x,p);p+=x.length;}out.set(last,p);return out;}

async function parseImage(mime, bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > RECEIPT_MAX_BYTES) fail('receipt_too_large');
  let info = mime === 'image/png' ? pngInfo(bytes) : mime === 'image/jpeg' ? jpegInfo(bytes) : null;
  if (!info) fail('invalid_receipt_image');
  if (mime === 'image/jpeg') {
    try {
      const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 64 });
      if (decoded.width !== info.width || decoded.height !== info.height) fail('invalid_receipt_image');
    } catch (error) {
      if (/maxMemoryUsageInMB|maxResolutionInMP|Could not allocate enough memory/.test(String(error?.message || ''))) fail('receipt_decode_limit');
      fail('invalid_receipt_image');
    }
  }
  const clean = mime === 'image/png' ? pngSanitize(bytes, info) : sanitizeJpeg(bytes, info);
  return { ...info, bytes: clean };
}
function canonicalBase64(bytes) { let out = ''; for (let p = 0; p < bytes.length; p += 3 * 2048) out += btoa(String.fromCharCode(...bytes.subarray(p, p + 3 * 2048))); return out; }
function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(RECEIPT_MAX_BYTES/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('invalid_base64');
  try { const raw=atob(value); const b=Uint8Array.from(raw,c=>c.charCodeAt(0)); if(b.length>RECEIPT_MAX_BYTES || b.length===0 || canonicalBase64(b)!==value) fail('invalid_base64'); return b; } catch { fail('invalid_base64'); }
}
function safeFilename(value) { if(typeof value!=='string'||!value.trim()||value.length>180||/[\u0000-\u001f\u007f]/.test(value)) fail('invalid_filename'); const n=value.replaceAll('\\','/').split('/').pop().trim(); if(!n||n==='.'||n==='..')fail('invalid_filename'); return n; }
function rowPayload(row){ return metadata(row); }
async function resolveDuplicate(context, db, duplicate, actorId, key, payloadHash, enabled) {
  if (duplicate?.uploaded_by === actorId && duplicate.idempotency_key === key && duplicate.payload_hash !== payloadHash)
    throw new ApiError(409, 'idempotency_conflict', 'Idempotency-Key sudah digunakan untuk data lain.');
  // A pending Dropbox job is resumable only when metadata exists; legacy
  // receipts have no job and must never be migrated as a side effect.
  if (enabled && duplicate.dropbox_state === 'pending') return resumeDropbox(context, db, duplicate, 200);
  return jsonResponse(rowPayload(duplicate), 200);
}

export async function listSubmissionReceipts(context, db, actor, submissionId) {
  ensureMethod(context.request, 'GET'); const a=await activeActor(db,actor); await visibleSubmission(db,a,submissionId);
  const enabled = dropboxEnabled(context.env);
  if (enabled) await ensureDropboxSchema(db);
  const rows=await all(db, `${enabled ? receiptSelectWithDropbox : receiptSelect} WHERE r.submission_id = ? ORDER BY r.created_at ASC,r.id ASC LIMIT 11`,submissionId);
  return jsonResponse({items:rows.map(metadata),count:rows.length,maxCount:RECEIPT_MAX_COUNT});
}
async function ensureDropboxSchema(db) {
  try {
    await db.prepare('SELECT receipt_id,dropbox_path,state FROM receipt_dropbox_metadata LIMIT 0').all();
    const required = ['receipt_dropbox_metadata_insert_guard','receipt_dropbox_identity_immutable','receipt_dropbox_ready_immutable','receipt_dropbox_active_owner','receipt_dropbox_ready_audit','receipt_dropbox_delete_guard'];
    const rows = (await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('receipt_dropbox_metadata_insert_guard','receipt_dropbox_identity_immutable','receipt_dropbox_ready_immutable','receipt_dropbox_active_owner','receipt_dropbox_ready_audit','receipt_dropbox_delete_guard')").all()).results || [];
    if (!required.every(name => rows.some(row => row.name === name))) throw new Error('incomplete_dropbox_schema');
  } catch { throw new ApiError(503, 'receipt_storage_unavailable', 'Penyimpanan Dropbox belum tersedia.'); }
}
async function ensureReceiptWriteSchema(db) {
  try {
    await db.prepare('SELECT id,submission_id,bytes_blob,payload_hash FROM submission_receipts LIMIT 0').all();
    const expected = ['submission_receipts_active_uploader','submission_receipts_max_ten','submission_receipts_append_only_update','submission_receipts_append_only_delete','submission_receipt_created_audit'];
    const triggers = (await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('submission_receipts_active_uploader','submission_receipts_max_ten','submission_receipts_append_only_update','submission_receipts_append_only_delete','submission_receipt_created_audit') LIMIT 5").all()).results || [];
    if (!expected.every(name => triggers.some(row => row.name === name))) throw new Error('incomplete_receipt_schema');
  } catch { throw new ApiError(503, 'receipt_storage_unavailable', 'Penyimpanan nota menunggu migrasi lengkap dan proteksi audit.'); }
}
export async function createSubmissionReceipt(context, db, actor, submissionId) {
  ensureMethod(context.request, 'POST'); const a=await activeActor(db,actor); const submission=await visibleSubmission(db,a,submissionId);
  if (submission.created_by !== a.id) throw new ApiError(403, 'forbidden', 'Hanya pemilik pengajuan yang dapat mengunggah foto nota.');
  await ensureReceiptWriteSchema(db);
  const enabled = dropboxEnabled(context.env); if (enabled) await ensureDropboxSchema(db);
  const key=context.request.headers.get('Idempotency-Key')||context.request.headers.get('X-Idempotency-Key'); if(!UUID.test(key||'')) throw new ApiError(400,'invalid_idempotency_key','Idempotency-Key UUID diperlukan.');
  const body=await readJson(context.request,REQUEST_MAX_BYTES); const filename=safeFilename(body.filename); const mime=body.mimeType;
  if(mime!=='image/jpeg'&&mime!=='image/png')fail('invalid_mime_type');
  if (enabled && body.dropboxPublicConsent !== true) throw new ApiError(400, 'dropbox_public_consent_required', 'Persetujuan tautan publik Dropbox diperlukan.');
  const original=decodeBase64(body.dataBase64); const image=await parseImage(mime,original);
  const digest=await crypto.subtle.digest('SHA-256', image.bytes); const sha=Array.from(new Uint8Array(digest), byte=>byte.toString(16).padStart(2,'0')).join(''); const payloadHash=await sha256Hex(`${submissionId}\n${sha}\n${mime}\n${filename}`);
  const select = enabled ? receiptSelectWithDropbox : receiptSelect;
  const keyed=await query(db,`${select} WHERE r.uploaded_by = ? AND r.idempotency_key = ? LIMIT 1`,a.id,key);
  if(keyed){
    if(keyed.payload_hash!==payloadHash)throw new ApiError(409,'idempotency_conflict','Idempotency-Key sudah digunakan untuk data lain.');
    if (!enabled || keyed.dropbox_state === 'ready' || !keyed.dropbox_state) return jsonResponse(rowPayload(keyed),200);
    return resumeDropbox(context, db, keyed, 200);
  }
  const duplicate=await query(db,`${enabled ? receiptSelectWithDropbox : receiptSelect} WHERE r.submission_id = ? AND r.sha256 = ? LIMIT 1`,submissionId,sha);
  if(duplicate)return resolveDuplicate(context, db, duplicate, a.id, key, payloadHash, enabled);
  // Resolve existing idempotent/legacy jobs before enforcing new filename rules.
  const fileExtension = enabled ? validatedExtension(filename, mime) : null;
  const id=crypto.randomUUID(), now=new Date().toISOString();
  const numbered = await requestNumber(db, submissionId);
  if (enabled && numbered.available && !isCanonicalRequestNumber(numbered.value))
    throw new ApiError(503, 'receipt_storage_unavailable', 'Nomor pengajuan belum tersedia atau tidak valid.');
  try {
    if (enabled) await db.batch([
      db.prepare(`INSERT INTO submission_receipts (id,submission_id,uploaded_by,filename,mime_type,bytes_blob,size_bytes,width,height,sha256,created_at,idempotency_key,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,submissionId,a.id,filename,mime,image.bytes,image.bytes.length,image.width,image.height,sha,now,key,payloadHash),
      numbered.available
        ? db.prepare(`INSERT INTO receipt_dropbox_metadata (receipt_id,dropbox_path,state,created_at)
            SELECT r.id, '/Pengajuan Pangsuma/' || s.request_number || '/' || r.id || '/' ||
              s.request_number || CASE WHEN (SELECT COUNT(*) FROM submission_receipts WHERE submission_id=r.submission_id)>1
                THEN '-' || printf('%02d',(SELECT COUNT(*) FROM submission_receipts WHERE submission_id=r.submission_id)-1) ELSE '' END || ?,
              'pending', r.created_at
            FROM submission_receipts r JOIN submissions s ON s.id=r.submission_id WHERE r.id=?`).bind(fileExtension,id)
        : db.prepare(`INSERT INTO receipt_dropbox_metadata (receipt_id,dropbox_path,state,created_at) VALUES (?,?,?,?)`).bind(id,dropboxPath(id,mime),'pending',now)
    ]);
    else await run(db,`INSERT INTO submission_receipts (id,submission_id,uploaded_by,filename,mime_type,bytes_blob,size_bytes,width,height,sha256,created_at,idempotency_key,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,submissionId,a.id,filename,mime,image.bytes,image.bytes.length,image.width,image.height,sha,now,key,payloadHash);
  } catch(e){
    if(/UNIQUE|constraint/i.test(String(e?.message||e))){ const raceKey=await query(db,`${select} WHERE r.uploaded_by = ? AND r.idempotency_key = ? LIMIT 1`,a.id,key); if(raceKey){if(raceKey.payload_hash!==payloadHash)throw new ApiError(409,'idempotency_conflict','Idempotency-Key sudah digunakan untuk data lain.'); return enabled && raceKey.dropbox_state==='pending' ? resumeDropbox(context,db,raceKey,200) : jsonResponse(rowPayload(raceKey),200);} const race=await query(db,`${receiptSelect} WHERE r.submission_id=? AND r.sha256=? LIMIT 1`,submissionId,sha);if(race)return resolveDuplicate(context,db,race,a.id,key,payloadHash,enabled);}
    dbError(e);
  }
  const row=await query(db,`${select} WHERE r.id = ? LIMIT 1`,id);
  if (!enabled) return jsonResponse(rowPayload(row),201);
  return resumeDropbox(context, db, row, 201);
}
async function resumeDropbox(context, db, row, status) {
  try {
    const result = await pushReceiptToDropbox(context.env, { ...row, bytes_blob: (await query(db,'SELECT bytes_blob FROM submission_receipts WHERE id=? LIMIT 1',row.id)).bytes_blob });
    await run(db, `UPDATE receipt_dropbox_metadata SET file_id=?, public_url=?, state='ready', completed_at=? WHERE receipt_id=? AND state='pending'`, result.fileId, result.publicUrl, new Date().toISOString(), row.id);
    const ready = await query(db, `${receiptSelectWithDropbox} WHERE r.id=? LIMIT 1`, row.id);
    if (!ready || ready.dropbox_state !== 'ready' || !validateDropboxUrl(ready.dropbox_url)) throw new Error('Dropbox finalization unavailable');
    return jsonResponse(rowPayload(ready),status);
  } catch { throw new ApiError(503, 'receipt_storage_unavailable', 'Penyimpanan Dropbox sedang tidak tersedia. Coba lagi.'); }
}
export async function getSubmissionReceipt(context, db, actor, receiptId) {
  ensureMethod(context.request,'GET'); const a=await activeActor(db,actor); const enabled = dropboxEnabled(context.env); if (enabled) await ensureDropboxSchema(db); const row=await query(db,`${enabled ? receiptSelectWithDropbox : receiptSelect} JOIN submissions s ON s.id=r.submission_id WHERE r.id=? AND (?='manager' OR s.created_by=?) LIMIT 1`,receiptId,a.role,a.id);
  if(!row)throw new ApiError(404,'receipt_not_found','Lampiran tidak ditemukan.');
  if(context.metadataOnly)return jsonResponse(metadata(row));
  const blob=await query(db,'SELECT bytes_blob,mime_type,filename FROM submission_receipts WHERE id=? LIMIT 1',receiptId); if(!blob)throw new ApiError(404,'receipt_not_found','Lampiran tidak ditemukan.');
  const safe=blob.filename.replace(/[^A-Za-z0-9._ -]/g,'_').slice(0,120)||'receipt'; const encoded=encodeURIComponent(blob.filename);
  const bytes = blob.bytes_blob instanceof ArrayBuffer ? new Uint8Array(blob.bytes_blob) : ArrayBuffer.isView(blob.bytes_blob) ? new Uint8Array(blob.bytes_blob.buffer, blob.bytes_blob.byteOffset, blob.bytes_blob.byteLength) : Array.isArray(blob.bytes_blob) ? Uint8Array.from(blob.bytes_blob) : null;
  if (!bytes || bytes.byteLength !== Number(row.size_bytes)) throw new ApiError(503, 'receipt_storage_unavailable', 'Data nota tidak dapat dibaca utuh.');
  return new Response(bytes,{status:200,headers:{'Content-Type':blob.mime_type,'Content-Length':String(bytes.byteLength),'Content-Disposition':`inline; filename="${safe}"; filename*=UTF-8''${encoded}`,'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'"}});
}
