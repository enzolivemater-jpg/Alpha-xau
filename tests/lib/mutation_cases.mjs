/**
 * Deterministic node-level mutations of a JSON-like document, shared by the
 * mutation sweeps. No randomness, clock or I/O.
 */

/** Values a hostile or buggy JavaScript caller can hand to an offline gate. */
export const HOSTILE_VALUES = [
  null, undefined, NaN, Infinity, -Infinity, -0, 0, -1, 1e308, Number.MAX_SAFE_INTEGER + 2,
  '', ' ', 'x'.repeat(300), '__proto__', 'constructor', '\u0000', '2026-02-30T00:00:00Z',
  '2026-10-01T14:15:00.000500Z', `sha256:${'0'.repeat(64)}`, true, false, [], {}, [null], { value: 1 },
];

/** Every key path of the document, containers included; `[]` is the root. */
export function nodePaths(node, prefix = [], out = []) {
  out.push(prefix);
  if (node !== null && typeof node === 'object') {
    for (const key of Object.keys(node)) nodePaths(node[key], [...prefix, key], out);
  }
  return out;
}

export const nodeAt = (root, path) => path.reduce((node, key) => node[key], root);

/**
 * For each node: replacement by every hostile value, removal (object members
 * only), an unknown sibling key, and an own enumerable `__proto__` key.
 * Returns `[label, mutatedClone]` pairs; the base is never modified.
 */
export function mutationCases(base) {
  const cases = [];
  for (const path of nodePaths(base)) {
    const label = path.join('.') || '<root>';
    for (const [index, value] of HOSTILE_VALUES.entries()) {
      if (path.length === 0) {
        cases.push([`${label} <- hostile#${index}`, structuredClone(value)]);
        continue;
      }
      const copy = structuredClone(base);
      nodeAt(copy, path.slice(0, -1))[path.at(-1)] = structuredClone(value);
      cases.push([`${label} <- hostile#${index}`, copy]);
    }
    if (path.length > 0 && !Array.isArray(nodeAt(base, path.slice(0, -1)))) {
      const copy = structuredClone(base);
      delete nodeAt(copy, path.slice(0, -1))[path.at(-1)];
      cases.push([`${label} <- deleted`, copy]);
    }
    const node = nodeAt(base, path);
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      const unknown = structuredClone(base);
      nodeAt(unknown, path).unexpectedKey = true;
      cases.push([`${label} <- unknown key`, unknown]);
      const proto = structuredClone(base);
      Object.defineProperty(nodeAt(proto, path), '__proto__', {
        value: { polluted: true }, enumerable: true, configurable: true, writable: true,
      });
      cases.push([`${label} <- own __proto__ key`, proto]);
    }
  }
  return cases;
}
