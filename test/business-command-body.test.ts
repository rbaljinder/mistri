import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { commandBody } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { CommandInputError } from '../packages/mistri/src/server/commands/commandPayload.js';

const request = (chunks: readonly Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

test('command body preserves valid UTF-8 across arbitrary chunk boundaries', async () => {
  const value = { input: { text: '雪🙂\uFFFD', embeddedBom: '\uFEFF' } };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.deepEqual(await commandBody(request([...bytes].map((byte) => Buffer.from([byte])))), value);
});

test('command body rejects malformed UTF-8 rather than replacement-decoding input', async () => {
  for (const bytes of [
    [0x80],
    [0xff],
    [0xc0, 0xaf],
    [0xe0, 0x80, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0xc2],
    [0xe9, 0x9b],
  ]) {
    const body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from(bytes), Buffer.from('"}')]);
    await assert.rejects(commandBody(request([body])), CommandInputError);
  }
  await assert.rejects(commandBody(request([Buffer.from([0xe9, 0x9b])])), CommandInputError);
});

test('command body preserves BOM and malformed JSON refusal without decoder details', async () => {
  for (const body of [Buffer.from('\uFEFF{}'), Buffer.from('{'), Buffer.from('')]) {
    await assert.rejects(commandBody(request([body])), (error) => {
      assert.ok(error instanceof CommandInputError);
      assert.equal(error.message, new CommandInputError().message);
      return true;
    });
  }
});

test('command body enforces its existing 64 KiB byte limit', async () => {
  const exact = Buffer.from(`"${'a'.repeat(65_534)}"`);
  assert.equal(exact.length, 65_536);
  assert.equal(await commandBody(request([exact])), 'a'.repeat(65_534));
  await assert.rejects(commandBody(request([exact, Buffer.from(' ')])), CommandInputError);
  const multibyte = Buffer.from(`"${'雪'.repeat(21_845)}"`);
  assert.equal(multibyte.length, 65_537);
  await assert.rejects(commandBody(request([multibyte])), CommandInputError);
});
