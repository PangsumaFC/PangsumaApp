import test from 'node:test';
import assert from 'node:assert/strict';
import { validProfileImage } from '../functions/_lib/profile-photo.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAE0lEQVR4nGP8z8DAwMDAxIBMAQAUQAEF3SN5DgAAAABJRU5ErkJggg==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');
const webp = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=', 'base64');

// Short JPEG and padded VP8 containers accepted by the old structural parser.
const fakeJpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,8,8,0,1,0,1,1,0xff,0xda,0,8,1,1,0,0,0,0,0,0,0x11,0xff,0xd9]);
const fakeJpeg20 = Buffer.from([0xff,0xd8,0xff,0xc0,0,8,8,0,1,0,1,1,0xff,0xda,0,2,0,0,0xff,0xd9]);
function fakeWebpOfSize(size) {
  const fake = Buffer.alloc(size);
  fake.write('RIFF'); fake.writeUInt32LE(size - 8, 4); fake.write('WEBP', 8);
  fake.write('VP8 ', 12); fake.writeUInt32LE(size - 20, 16);
  Buffer.from([0x30,0,0,0x9d,1,0x2a]).copy(fake, 20);
  fake.writeUInt16LE(1, 26); fake.writeUInt16LE(1, 28);
  return fake;
}
const fakeWebps = [30, 34, 36, 40, 60, 100].map(fakeWebpOfSize);

// IHDR CRC occupies bytes 29..32 (and must not be ignored).
const corruptPng = Buffer.from(png); corruptPng.fill(0, 29, 33);
const oversizedPng = Buffer.from(png); oversizedPng.writeUInt32BE(2049, 16);
const oversizedWebp = Buffer.from(webp); oversizedWebp.writeUInt16LE(2049, 26);
const oversizedJpeg = Buffer.from(jpeg);
const jpegSof = oversizedJpeg.indexOf(0xff, 2);
const sof = oversizedJpeg.indexOf(0xc0, jpegSof);
oversizedJpeg.writeUInt16BE(2049, sof + 6);

test('accepts real decodable PNG/JPEG/WebP fixtures', async () => {
  assert.equal(await validProfileImage(png, 'image/png'), true);
  assert.equal(await validProfileImage(jpeg, 'image/jpeg'), true);
  assert.equal(await validProfileImage(webp, 'image/webp'), true);
});

test('rejects fake structural containers and corrupted PNG', async () => {
  assert.equal(await validProfileImage(fakeJpeg, 'image/jpeg'), false);
  assert.equal(await validProfileImage(fakeJpeg20, 'image/jpeg'), false);
  for (const fakeWebp of fakeWebps) {
    assert.equal(await validProfileImage(fakeWebp, 'image/webp'), false, `fake WebP ${fakeWebp.length}`);
  }
  assert.equal(await validProfileImage(corruptPng, 'image/png'), false);
  assert.equal(await validProfileImage(Buffer.concat([png, Buffer.from('trailing')]), 'image/png'), false);
  assert.equal(await validProfileImage(png, 'image/jpeg'), false);
  assert.equal(await validProfileImage(Buffer.from('<svg></svg>'), 'image/svg+xml'), false);
  assert.equal(await validProfileImage(oversizedPng, 'image/png'), false);
  assert.equal(await validProfileImage(oversizedJpeg, 'image/jpeg'), false);
  assert.equal(await validProfileImage(oversizedWebp, 'image/webp'), false);
});

test('rejects truncation and size limit', async () => {
  assert.equal(await validProfileImage(png.subarray(0, 24), 'image/png'), false);
  assert.equal(await validProfileImage(jpeg.subarray(0, 20), 'image/jpeg'), false);
  assert.equal(await validProfileImage(webp.subarray(0, 34), 'image/webp'), false);
  assert.equal(await validProfileImage(new Uint8Array(131073), 'image/png'), false);
});
