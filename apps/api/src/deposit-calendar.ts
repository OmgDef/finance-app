export type DepositPeriod = { fromDate: string; date: string; fullDays: number };

export function nextDepositPeriod(startDate: string, maturityDate: string, afterDate = startDate): DepositPeriod | null {
  if (afterDate >= maturityDate) return null;
  const start = Temporal.PlainDate.from(startDate);
  const from = Temporal.PlainDate.from(afterDate);
  const months = (from.year - start.year) * 12 + from.month - start.month;
  const nominalDate = start.add({ months: months + 1 });
  const maturity = Temporal.PlainDate.from(maturityDate);
  const date = Temporal.PlainDate.compare(nominalDate, maturity) <= 0 ? nominalDate : maturity;
  return { fromDate: afterDate, date: date.toString(), fullDays: from.until(nominalDate).days };
}

export function depositInterestAmount(positiveBalanceDays: bigint, annualRatePercent: string, fullDays: number): bigint {
  const [whole, fraction = ''] = annualRatePercent.split('.');
  const rate = BigInt(whole + fraction.padEnd(4, '0'));
  const denominator = BigInt(fullDays) * 12n * 100n * 10_000n;
  return (positiveBalanceDays * rate + denominator / 2n) / denominator;
}
