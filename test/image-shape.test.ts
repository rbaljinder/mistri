import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageAspect } from '../packages/mistri/src/server/app/imageShape.js';

const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

test('a PNG says its shape in its header', () => {
  assert.equal(imageAspect(png(400, 100)), 4);
  assert.equal(imageAspect(png(64, 64)), 1);
  assert.equal(imageAspect(png(0, 64)), undefined);
});

test('a GIF says its shape in its screen descriptor', () => {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(30, 6);
  bytes.writeUInt16LE(20, 8);
  assert.equal(imageAspect(bytes), 1.5);
});

test('a JPEG says its shape in its first start of frame, past other segments', () => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(50, 5); // height
  sof.writeUInt16BE(200, 7); // width
  assert.equal(imageAspect(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])), 4);
  assert.equal(imageAspect(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04])), undefined);
});

test('a WebP says its shape in each of its three forms', () => {
  const riff = (kind: string, body: Buffer) => {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'latin1');
    bytes.write('WEBP', 8, 'latin1');
    bytes.write(kind, 12, 'latin1');
    body.copy(bytes, 20);
    return bytes;
  };
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(299, 4, 3); // width - 1
  extended.writeUIntLE(99, 7, 3); // height - 1
  assert.equal(imageAspect(riff('VP8X', extended)), 3);
  const lossy = Buffer.alloc(10);
  lossy.set([0x9d, 0x01, 0x2a], 0);
  lossy.writeUInt16LE(80, 3);
  lossy.writeUInt16LE(40, 5);
  assert.equal(imageAspect(riff('VP8 ', Buffer.concat([Buffer.alloc(0), lossy]))), undefined, 'the signature is at byte 23');
  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE(((49 << 14) | 99) >>> 0, 1); // 100 by 50
  assert.equal(imageAspect(riff('VP8L', lossless)), 2);
});

test('an SVG says its shape by its width and height, else its viewBox', () => {
  assert.equal(imageAspect(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"></svg>')), 4);
  assert.equal(imageAspect(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 24 24" stroke-width="2"></svg>')), 1);
  assert.equal(imageAspect(Buffer.from("<svg width='50%' viewBox='0 0 90 30'/>")), 3);
  assert.equal(imageAspect(Buffer.from('<svg></svg>')), undefined);
});

test('anything else, or anything cut short, says nothing', () => {
  assert.equal(imageAspect(Buffer.alloc(0)), undefined);
  assert.equal(imageAspect(Buffer.from('not a picture')), undefined);
  assert.equal(imageAspect(png(10, 10).subarray(0, 18)), undefined);
});
