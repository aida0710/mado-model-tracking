// Protobuf JSON retains int64 as strings when JavaScript numbers cannot represent the exact value.
export function serializeInt64(value: number | string): number | string {
  const integer = BigInt(value);
  const numeric = Number(integer);
  return Number.isSafeInteger(numeric) ? numeric : integer.toString();
}
