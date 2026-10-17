import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('async function decodeProfilePhoto('), source.indexOf('\nasync function prepareProfilePhoto('));
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
  vm.runInContext(helper, context);
  return { calls, decode: file => context.decodeProfilePhoto(file) };
}

test('normalizes the image/jpg MIME alias commonly returned by gallery providers', () => {
  const context = vm.createContext({});
  vm.runInContext(mimeHelper, context);
  assert.equal(context.profilePhotoMime({ type: 'image/jpg', name: 'photo.jpg' }), 'image/jpeg');
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
