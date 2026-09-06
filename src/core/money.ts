/**
 * Amounts as integer cents.
 *
 * FDMS signs over cents, and a float that drifted by 1e-15 changes the
 * canonical string and yields RCPT010. Callers pass either a whole number of
 * major units (`price: 115`, exact in binary) or a `Money` built from a
 * decimal string (`cents("11.50")`). A fractional JS number is refused
 * rather than rounded, because by the time it arrives we cannot tell
 * 11.5 from 11.499999.
 */
export interface Money {
  readonly cents: number;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** Parse a decimal string with up to two places into cents, exactly. */
export function cents(amount: string): Money {
  const m = DECIMAL.exec(amount.trim());
  if (!m) {
    throw new Error(`cents(): "${amount}" is not a decimal amount with at most two places`);
  }
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return { cents: sign * (whole * 100 + frac) };
}

/** Wrap a value that is already in cents. */
export function fromCents(value: number): Money {
  if (!Number.isInteger(value)) {
    throw new Error(`fromCents(): ${value} is not an integer`);
  }
  return { cents: value };
}

export function isMoney(v: unknown): v is Money {
  return typeof v === "object" && v !== null && Number.isInteger((v as Money).cents);
}

/**
 * Cents from a ReceiptInput amount. `field` names the offending input in
 * the error, e.g. "lines[2].price".
 */
export function amountToCents(v: number | Money, field: string): number {
  if (isMoney(v)) return v.cents;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${field}: expected a number or Money, got ${String(v)}`);
  }
  if (!Number.isInteger(v)) {
    throw new Error(
      `${field}: ${v} has a fractional part. Pass cents("${v.toFixed(2)}") or a whole number of major units; a float cannot be converted exactly.`,
    );
  }
  return v * 100;
}

/** Decimal number for the FDMS wire format, e.g. 11500 -> 115. */
export function centsToAmount(c: number): number {
  return c / 100;
}

/** Format cents as a decimal string, e.g. 11550 -> "115.50". */
export function formatCents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Convert amounts that arrived through JSON, where 2.5 was written as the
 * text "2.5" and is exact to two places. Fractional numbers with at most
 * two decimals become Money; anything finer is refused. Use this at the
 * edge (a CLI file, an MCP tool call), not inside application code, where
 * `cents()` on the original string is the honest conversion.
 */
export function moneyFromJsonNumber(v: unknown, field: string): number | Money {
  if (typeof v !== "number") return v as Money;
  if (Number.isInteger(v)) return v;
  const text = v.toFixed(2);
  if (Math.abs(Number(text) - v) > 1e-9) {
    throw new Error(`${field}: ${v} has more than two decimal places`);
  }
  return cents(text);
}

/** Apply moneyFromJsonNumber to every amount in a ReceiptInput-shaped object. */
export function receiptInputFromJson<T extends { lines: { price: unknown }[]; payments: { amount: unknown }[] }>(input: T): T {
  return {
    ...input,
    lines: input.lines.map((l, i) => ({ ...l, price: moneyFromJsonNumber(l.price, `lines[${i}].price`) })),
    payments: input.payments.map((p, i) => ({ ...p, amount: moneyFromJsonNumber(p.amount, `payments[${i}].amount`) })),
  };
}
