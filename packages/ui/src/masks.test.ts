import { expect, test } from 'vitest';
import { digits, isoDay, maskNamed, masks } from './masks.js';

test('a grouped mask draws the digits it has and parses typing back to digits', () => {
  expect(masks.phone.format('6786786781')).toBe('678-678-6781');
  expect(masks.phone.format('67867')).toBe('678-67');
  expect(masks.phone.parse('(678) 678-6781 99')).toBe('6786786781');
  expect(masks.ssn.format('123456789')).toBe('123-45-6789');
  expect(masks.date.format('0229')).toBe('02/29');
  expect(masks.month.format('102026')).toBe('10/2026');
  expect(masks.zip.parse('30301-12345')).toBe('30301');
  expect(masks.digits.format('12345')).toBe('12345');
  expect(digits('a1-b2')).toBe('12');
});

test('money keeps the digits and draws the symbol and the groups', () => {
  expect(masks.money('$').format('2500')).toBe('$2,500');
  expect(masks.money('').format('25000')).toBe('25,000');
  expect(masks.money('$').format('')).toBe('');
  expect(masks.money('$', 3).parse('$12,345')).toBe('123');
});

test('a mask is found by name, and a mask passed is returned as it is', () => {
  expect(maskNamed('phone')).toBe(masks.phone);
  expect(maskNamed('money').format('900')).toBe('$900');
  expect(maskNamed('grouped').format('9000')).toBe('9,000');
  expect(maskNamed(masks.zip)).toBe(masks.zip);
});

test('a typed day is read only when it is a real one', () => {
  expect(isoDay('02/28/2024')).toBe('2024-02-28');
  expect(isoDay('02/29/2024')).toBe('2024-02-29');
  expect(isoDay('02/29/2023')).toBe('');
  expect(isoDay('13/01/2023')).toBe('');
  expect(isoDay('1/1/2023')).toBe('');
});
