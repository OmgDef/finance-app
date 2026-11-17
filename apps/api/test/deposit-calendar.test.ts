import assert from 'node:assert/strict';
import { test } from 'node:test';
import { depositInterestAmount, nextDepositPeriod } from '../src/deposit-calendar.ts';

test('A short February preserves the original deposit anniversary and the final period is prorated', () => {
  const january = '2028-01-31';
  const maturity = '2028-03-15';
  assert.deepEqual(nextDepositPeriod(january, maturity), { fromDate: january, date: '2028-02-29', fullDays: 29 });
  assert.deepEqual(nextDepositPeriod(january, '2028-05-01', '2028-02-29'), {
    fromDate: '2028-02-29', date: '2028-03-31', fullDays: 31,
  });
  assert.deepEqual(nextDepositPeriod(january, maturity, '2028-02-29'), {
    fromDate: '2028-02-29', date: maturity, fullDays: 31,
  });
  assert.equal(nextDepositPeriod(january, maturity, maturity), null);
  assert.equal(depositInterestAmount(100000n * 15n, '12', 31), 484n);
});

test('Monthly interest uses the fractional rate and rounds only the final amount', () => {
  assert.equal(depositInterestAmount(120000n * 31n, '4.1250', 31), 413n);
  assert.equal(depositInterestAmount(49n * 30n, '12', 30), 0n);
  assert.equal(depositInterestAmount(50n * 30n, '12', 30), 1n);
});
