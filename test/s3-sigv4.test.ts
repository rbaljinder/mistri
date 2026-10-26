/**
 * The SigV4 signer against AWS's own published examples: the S3 developer
 * guide's GET with a range, PUT, list, and presigned GET ("Signature
 * Calculations for the Authorization Header" and "Authenticating Requests:
 * Using Query Parameters"), and the general suite's get-vanilla. Each
 * expected signature is AWS's, copied from the page; none was produced by
 * this code.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presignUrl, sha256Hex, signRequest } from '../packages/mistri/src/server/files/sigv4.js';

const s3 = {
  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  region: 'us-east-1',
  service: 's3',
  now: new Date('2013-05-24T00:00:00Z'),
};
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const signatureOf = (headers: Record<string, string>) => /Signature=([0-9a-f]{64})$/.exec(headers.authorization)?.[1];

test('S3 GET object with a range', () => {
  const headers = signRequest(
    {
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY },
      payloadHash: EMPTY,
    },
    s3,
  );
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
});

test('S3 PUT object: a key with a reserved character, extra signed headers', () => {
  const body = 'Welcome to Amazon S3.';
  const headers = signRequest(
    {
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': sha256Hex(body),
      },
      payloadHash: sha256Hex(body),
    },
    s3,
  );
  assert.equal(signatureOf(headers), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  assert.match(headers.authorization, /SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,/);
});

test('S3 GET bucket lifecycle: a query name without a value', () => {
  const headers = signRequest(
    {
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      headers: { 'x-amz-content-sha256': EMPTY },
      payloadHash: EMPTY,
    },
    s3,
  );
  assert.equal(signatureOf(headers), 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
});

test('S3 list objects: the query in canonical order', () => {
  const headers = signRequest(
    {
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2'),
      headers: { 'x-amz-content-sha256': EMPTY },
      payloadHash: EMPTY,
    },
    s3,
  );
  assert.equal(signatureOf(headers), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('S3 presigned GET', () => {
  const url = presignUrl({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), expiresSeconds: 86400 }, s3);
  assert.equal(url.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

test('the general suite: get-vanilla', () => {
  const headers = signRequest(
    { method: 'GET', url: new URL('https://example.amazonaws.com/'), payloadHash: EMPTY },
    {
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      region: 'us-east-1',
      service: 'service',
      now: new Date('2015-08-30T12:36:00Z'),
    },
  );
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'.replace(
      /, /g,
      ',',
    ),
  );
});

test('temporary credentials sign their session token', () => {
  const headers = signRequest(
    { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/a'), payloadHash: EMPTY },
    { ...s3, credentials: { ...s3.credentials, sessionToken: 'token' } },
  );
  assert.equal(headers['x-amz-security-token'], 'token');
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
  const url = presignUrl(
    { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/a'), expiresSeconds: 60 },
    {
      ...s3,
      credentials: { ...s3.credentials, sessionToken: 'token' },
    },
  );
  assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'token');
});
