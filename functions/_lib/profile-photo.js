import jpeg from 'jpeg-js';
import { decode as decodePng } from 'fast-png';
import { Unzlib } from 'fflate';
import decodeWebp, { init as initWebpDecode } from '@jsquash/webp/decode.js';
import webpDecoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';

initWebpDecode(webpDecoderWasm);

const MAX_BYTES = 131072;
const MAX_DIMENSION = 2048;

function dimensionsOK(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0
    && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
}

async function boundedDecode(decode, bytes) {
  try {
    const decoded = await decode(bytes);
    return Boolean(decoded && dimensionsOK(decoded.width, decoded.height)
      && decoded.data?.length >= decoded.width * decoded.height);
  } catch {
    return false;
  }
}

function boundedDimensions(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (mime === 'image/png') {
    return bytes.length >= 33 && text(0, 8) === '\x89PNG\r\n\x1a\n'
      && view.getUint32(8) === 13 && text(12, 4) === 'IHDR'
      && dimensionsOK(view.getUint32(16), view.getUint32(20));
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 24 || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length || marker === 0xda || marker === 0xd9) return false;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        return length >= 8 && bytes[offset + 2] === 8
          && length === 8 + 3 * bytes[offset + 7]
          && dimensionsOK(view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 26 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP'
      || view.getUint32(4, true) + 8 !== bytes.length) return false;
    const uint24 = offset => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    let offset = 12, canvas = null, image = null;
    while (offset + 8 <= bytes.length) {
      const type = text(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8;
      const end = start + length;
      if (end + (length & 1) > bytes.length || ((length & 1) && bytes[end] !== 0)) return false;
      let dimensions;
      if (type === 'VP8X') {
        if (canvas || image || length !== 10 || bytes[start] & 0x02) return false;
        dimensions = [uint24(start + 4) + 1, uint24(start + 7) + 1];
        canvas = dimensions;
      } else if (type === 'VP8 ') {
        if (image || length < 10 || bytes[start] & 1 || text(start + 3, 3) !== '\x9d\x01\x2a') return false;
        dimensions = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
        image = dimensions;
      } else if (type === 'VP8L') {
        if (image || length < 5 || bytes[start] !== 0x2f) return false;
        const bits = view.getUint32(start + 1, true);
        if (bits >>> 29) return false;
        dimensions = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
        image = dimensions;
      } else if (type === 'ANIM' || type === 'ANMF') return false;
      if (dimensions && !dimensionsOK(...dimensions)) return false;
      offset = end + (length & 1);
    }
    return Boolean(image && offset === bytes.length && (!canvas || (canvas[0] === image[0] && canvas[1] === image[1])));
  }
  return false;
}

function decodePngStrict(bytes) {
  if (bytes.length < 12) return null;
  const end = bytes.length - 12;
  if (bytes[end] !== 0 || bytes[end + 1] !== 0 || bytes[end + 2] !== 0 || bytes[end + 3] !== 0
    || String.fromCharCode(...bytes.subarray(end + 4, end + 8)) !== 'IEND') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxInflated = view.getUint32(20) * (view.getUint32(16) * 8 + 1) + 32768;
  let inflated = 0;
  const inflater = new Unzlib(chunk => {
    inflated += chunk.length;
    if (inflated > maxInflated) throw new Error('PNG decompression limit exceeded');
  });
  const allowedChunks = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'gAMA', 'cHRM', 'sRGB', 'pHYs']);
  let offset = 8, sawData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12 || !allowedChunks.has(type)) return null;
    if (type === 'IDAT') {
      sawData = true;
      // Feed small compressed slices so even hostile expansion is bounded per callback.
      for (let pos = offset + 8; pos < offset + 8 + length; pos += 128) {
        inflater.push(bytes.subarray(pos, Math.min(pos + 128, offset + 8 + length)), false);
      }
    }
    offset += length + 12;
  }
  if (!sawData || offset !== bytes.length) return null;
  inflater.push(new Uint8Array(), true);
  return decodePng(bytes, { checkCrc: true });
}

async function decodeWebpStrict(bytes) {
  try {
    // Pass an exact copy so pooled ArrayBuffer bytes outside this view are ignored.
    return await decodeWebp(new Uint8Array(bytes).slice().buffer);
  } catch {
    return null;
  }
}

// Decode pixels, rather than accepting headers: this rejects truncated, malformed,
// and synthetically assembled containers while keeping workerd-compatible JS only.
export async function validProfileImage(bytes, mime) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_BYTES) return false;
  if (!boundedDimensions(bytes, mime)) return false;

  if (mime === 'image/png') return boundedDecode(decodePngStrict, bytes);
  if (mime === 'image/jpeg') return boundedDecode((input) => jpeg.decode(input, {
    useTArray: true, tolerantDecoding: false, maxResolutionInMP: 4.2, maxMemoryUsageInMB: 64
  }), bytes);
  if (mime === 'image/webp') return boundedDecode(decodeWebpStrict, bytes);
  return false;
}
