// Money is handled in integer cents and rates in integer basis points (45 % = 4500).
// Conversions go through strings so no float ever touches an amount.

/** Parses a French decimal ("60", "60,5", "1 234,56") into an integer scaled by 10^decimals. */
export function parseFixed(input: string, decimals: number): number | null {
  const s = input.replace(/\s/g, "").replace(",", ".");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return Number(whole + fraction.padEnd(decimals, "0"));
}

/** Formats an integer scaled by 10^decimals, e.g. 6050 → "60,50" (or "60,5" with `trim`). */
export function formatFixed(
  value: number,
  decimals: number,
  trim = false,
): string {
  const digits = String(Math.abs(value)).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);
  if (trim) fraction = fraction.replace(/0+$/, "");
  return (value < 0 ? "-" : "") + whole + (fraction ? "," + fraction : "");
}

export const parseEuros = (input: string) => parseFixed(input, 2);
export const centsToInput = (cents: number) => formatFixed(cents, 2);
export const formatEuros = (cents: number) => `${formatFixed(cents, 2)} €`;

export const parsePercent = (input: string) => parseFixed(input, 2);
export const bpToInput = (bp: number) => formatFixed(bp, 2, true);
export const formatPercent = (bp: number) => `${formatFixed(bp, 2, true)} %`;
