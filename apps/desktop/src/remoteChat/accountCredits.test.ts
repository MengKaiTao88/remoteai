import { expect, it } from 'vitest';
import { formatAccountCredits } from '../../../../shared/remote-chat/accountCredits';
import { decodeUsageSummary } from '../../../../shared/remote-chat/usageSummary';

const totals = { totalTokens: 123, estimatedCostUsd: 1.5 };
const credits = { hasCredits: true, unlimited: false, balance: '62500.125' };

it('preserves PC credit points independently of token costs and quota estimates', () => {
  const summary = decodeUsageSummary({ ...totals, accountCredits: credits });
  expect(summary.accountCredits).toEqual(credits);
  expect(formatAccountCredits(summary.accountCredits, 'zh-CN', '不限额')).toBe('62,500.125');
  expect(formatAccountCredits({ ...credits, balance: '0' }, 'en-US', 'Unlimited')).toBe('0');
  expect(formatAccountCredits({ ...credits, unlimited: true }, 'en-US', 'Unlimited')).toBe('Unlimited');
  expect(formatAccountCredits({ ...credits, hasCredits: false, balance: null }, 'en-US', 'Unlimited')).toBe('0');
});

it.each([undefined, null, {}, [], '100', { ...credits, hasCredits: 'false' }, { ...credits, balance: 100 }])(
  'keeps missing and malformed host credits unavailable: %j', accountCredits => {
    const summary = decodeUsageSummary({ ...totals, accountCredits });
    expect(summary.accountCredits).toBeUndefined();
    expect(formatAccountCredits(summary.accountCredits, 'en-US', 'Unlimited')).toBe('—');
  },
);

it.each([null, '', ' ', '-1', 'NaN', 'Infinity', 'unknown'])(
  'does not turn an unknown PC balance into zero: %j', balance => {
    expect(formatAccountCredits({ ...credits, balance }, 'en-US', 'Unlimited')).toBe('—');
  },
);
