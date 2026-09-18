/**
 * Turns a user supplied name into a stable, printable identifier that is safe
 * to use as a HAP service subtype and as an accessory serial number.
 */
export function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Formats tenths of a millimetre as millimetres, for log messages.
 */
export function tenthsToMm(tenths: number): number {
  return Math.round(tenths) / 10;
}
