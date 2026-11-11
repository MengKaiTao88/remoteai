import { expect, it } from 'vitest';
import { accountExpirationDate } from './expiration';
import { earliestExpirationDate } from '../../../../shared/accounts/expiration';

it('formats subscription timestamps using the display device calendar date', () => {
  const instant = '2026-12-11T16:47:15Z';
  const local = new Date(instant);
  const expected = [local.getFullYear(), String(local.getMonth() + 1).padStart(2, '0'),
    String(local.getDate()).padStart(2, '0')].join('-');
  expect(accountExpirationDate(null, instant)).toBe(expected);
  expect(earliestExpirationDate(null, instant)).toBe(expected);
});

it('preserves a manual date and does not invent a missing expiration', () => {
  expect(accountExpirationDate('2026-11-30', '2026-12-11T16:47:15Z')).toBe('2026-11-30');
  expect(accountExpirationDate('', null)).toBeNull();
  expect(earliestExpirationDate('', null)).toBeNull();
});
