import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('function unsupportedNativePhotoError('), source.indexOf('\nasync function prepareProfilePhoto('));
const mimeHelper = source.slice(source.indexOf('function profilePhotoMime('), source.indexOf('\nasync function prepareProfilePhoto('));

function harness({ bitmap, decodeFails = false } = {}) {
  const calls = { readers: 0, images: 0 };
  class FileReader {
    readAsDataURL(file) {
      calls.readers += 1;
      this.result = `data:${file.type};base64,local`;
      this.onload();
    }
  }
  class Image {
    constructor() { calls.images += 1; this.width = this.height = 1; }
    async decode() { if (decodeFails) throw new Error('bad bytes'); }
  }
  const context = vm.createContext({ FileReader, Image, createImageBitmap: bitmap });
  vm.runInContext(mimeHelper + '\n' + helper, context);
  return { calls, decode: file => context.decodeProfilePhoto(file, context.profilePhotoMime(file)) };
}

test('normalizes the image/jpg MIME alias commonly returned by gallery providers', () => {
  const context = vm.createContext({});
  vm.runInContext(mimeHelper, context);
  assert.equal(context.profilePhotoMime({ type: 'image/jpg', name: 'photo.jpg' }), 'image/jpeg');
});

test('normalizes HEIC/HEIF MIME aliases and empty mobile MIME by extension', () => {
  const context = vm.createContext({});
  vm.runInContext(mimeHelper, context);
  assert.equal(context.profilePhotoMime({ type: 'image/heic', name: 'photo.HEIC' }), 'image/heic');
  assert.equal(context.profilePhotoMime({ type: 'image/x-heic', name: 'photo.heic' }), 'image/heic');
  assert.equal(context.profilePhotoMime({ type: 'image/x-heif', name: 'photo.heif' }), 'image/heif');
  assert.equal(context.profilePhotoMime({ type: '', name: 'photo.HEIF' }), 'image/heif');
  assert.equal(context.profilePhotoMime({ type: 'application/octet-stream', name: 'photo.JPG' }), 'image/jpeg');
  assert.equal(context.profilePhotoMime({ type: 'binary/octet-stream', name: 'photo.png' }), 'image/png');
  assert.equal(context.profilePhotoMime({ type: 'application/octet-stream', name: 'photo.bin' }), 'application/octet-stream');
});

test('foto memakai createImageBitmap bila tersedia', async () => {
  const decoded = { width: 2, height: 3, close() {} };
  const h = harness({ bitmap: async () => decoded });
  assert.equal(await h.decode({ type: 'image/webp' }), decoded);
  assert.equal(h.calls.readers, 0);
});

test('foto JPG/PNG memakai Image.decode bila createImageBitmap menolak', async () => {
  const h = harness({ bitmap: async () => { throw new Error('corrupt'); } });
  const image = await h.decode({ type: 'image/jpeg' });
  assert.equal(image.width, 1);
  assert.equal(h.calls.images, 1);
});

test('foto HEIC memakai decoder native browser bila tersedia', async () => {
  const decoded = { width: 4, height: 5, close() {} };
  const h = harness({ bitmap: async file => {
    assert.equal(file.type, 'image/heic');
    return decoded;
  }});
  assert.equal(await h.decode({ type: 'image/heic', name: 'photo.heic' }), decoded);
  assert.equal(h.calls.readers, 0);
});

test('HEIC/HEIF yang tidak didukung memberi panduan JPG/PNG', async () => {
  const h = harness({ bitmap: async () => { throw new Error('unsupported'); }, decodeFails: true });
  await assert.rejects(h.decode({ type: 'image/heic', name: 'photo.heic' }), /HEIC\/HEIF.*JPG atau PNG/);
  await assert.rejects(h.decode({ type: 'image/heif', name: 'photo.heif' }), /HEIC\/HEIF.*JPG atau PNG/);
  assert.equal(h.calls.images, 2);
});

test('HEIC dapat memakai Image.decode jika bitmap menolak tetapi decoder gambar mendukung', async () => {
  const h = harness({ bitmap: async () => { throw new Error('unsupported bitmap'); } });
  const image = await h.decode({ type: 'image/heic', name: 'photo.heic' });
  assert.equal(image.width, 1);
  assert.equal(h.calls.images, 1);
});

test('octet-stream memakai ekstensi tepercaya sambil tetap mendecode bytes', async () => {
  const decoded = { width: 4, height: 5, close() {} };
  const h = harness({ bitmap: async file => {
    assert.equal(file.type, 'image/jpeg');
    return decoded;
  }});
  const file = { type: 'application/octet-stream', name: 'photo.jpg', size: 10,
    slice: (_start, _end, type) => ({ type, name: 'photo.jpg' }) };
  assert.equal(await h.decode(file.slice(0, file.size, 'image/jpeg')), decoded);
  assert.equal(h.calls.readers, 0);
});

test('penolakan bitmap WebP tidak ditimpa oleh decoder gambar yang lebih permisif', async () => {
  const h = harness({ bitmap: async () => { throw new Error('corrupt'); } });
  await assert.rejects(h.decode({ type: 'image/webp' }), /Foto tidak dapat dibaca/);
  assert.equal(h.calls.images, 0);
});

test('browser tanpa bitmap dapat mendecode JPEG dan PNG memakai data URL sesuai CSP', async () => {
  const h = harness();
  for (const type of ['image/jpeg', 'image/png']) {
    const image = await h.decode({ type });
    assert.equal(image.width, 1);
    assert.ok(image.src.startsWith(`data:${type};`));
  }
  assert.equal(h.calls.readers, 2);
});

test('fallback menolak WebP yang tidak bisa divalidasi dan bytes JPEG rusak', async () => {
  const h = harness();
  await assert.rejects(h.decode({ type: 'image/webp' }), /Pilih foto JPG atau PNG/);
  assert.equal(h.calls.readers, 0);
  const invalid = harness({ decodeFails: true });
  await assert.rejects(invalid.decode({ type: 'image/jpeg' }), /Foto tidak dapat dibaca/);
});
