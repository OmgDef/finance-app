import { AccessError } from './errors.ts';

type SourceFields = { source?: string | null; incomeSource?: string | null };

// The ledger and schedule store both kinds in the original income_source columns.
export function normalizeTransactionSource(kind: 'income' | 'expense', input: SourceFields) {
  if ((kind !== 'income' && input.incomeSource != null) ||
      (input.source !== undefined && input.incomeSource !== undefined)) {
    throw new AccessError(400, 'INVALID_REQUEST');
  }
  const value = input.source === undefined ? input.incomeSource : input.source;
  if (value == null) return value;
  const source = value.trim();
  if (!source) throw new AccessError(400, 'INVALID_REQUEST');
  return source;
}

export function transactionSourceFields(kind: 'income' | 'expense' | 'transfer', source: string | null | undefined) {
  return source == null ? {} : { source, ...(kind === 'income' && { incomeSource: source }) };
}
