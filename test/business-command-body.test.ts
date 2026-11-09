import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { commandBody } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { MAX_COMMAND_BYTES } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
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

test('command body enforces its 512 KiB byte limit, which holds a 65,536-character text', async () => {
  const exact = Buffer.from(`"${'a'.repeat(MAX_COMMAND_BYTES - 2)}"`);
  assert.equal(exact.length, MAX_COMMAND_BYTES);
  assert.equal(await commandBody(request([exact])), 'a'.repeat(MAX_COMMAND_BYTES - 2));
  await assert.rejects(commandBody(request([exact, Buffer.from(' ')])), CommandInputError);
  const multibyte = Buffer.from(`"${'雪'.repeat(Math.floor((MAX_COMMAND_BYTES - 2) / 3) + 1)}"`);
  assert.ok(multibyte.length > MAX_COMMAND_BYTES);
  await assert.rejects(commandBody(request([multibyte])), CommandInputError);
  // The longest text a command may declare, all four-byte characters, still fits whole.
  const longest = '🙂'.repeat(65_536);
  assert.ok(Buffer.byteLength(JSON.stringify({ input: longest })) <= MAX_COMMAND_BYTES);
});
