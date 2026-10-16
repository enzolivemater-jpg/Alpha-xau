/**
 * Canonical JSON and its SHA-256 digest, shared by CHAIN-0 and the market
 * evidence replay. Pure: Web Crypto only, no clock, no I/O.
 */

/**
 * Canonical JSON: object keys sorted by code unit, arrays in order, no
 * whitespace. Values JSON cannot represent exactly are rejected rather than
 * silently coerced, so two equal digests imply equal chain content.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

/**
 * Deepest nesting accepted. Real chain, archive and event structures are under
 * twenty levels. A fixed bound refuses a hostile or circular structure with a
 * typed error at the same depth everywhere; the host's stack size would not.
 */
const MAX_DEPTH = 256;

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('canonicalJson: nesting too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => encode(item, depth + 1)).join(',')}]`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonicalJson: unsupported object');
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        if (record[key] === undefined) throw new TypeError(`canonicalJson: undefined at ${key}`);
        return `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`;
      }).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** `sha256:<hex>` of a UTF-8 string. */
export async function sha256Text(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** `sha256:<hex>` of the canonical JSON of a value. */
export function sha256Canonical(value: unknown): Promise<string> {
  return sha256Text(canonicalJson(value));
}
