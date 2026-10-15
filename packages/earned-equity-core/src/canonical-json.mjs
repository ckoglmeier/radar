// Deterministic JSON: object keys sorted recursively, no insignificant whitespace.
import { CoreInputError } from './decimal.mjs';

export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CoreInputError('non_finite_number', 'Cannot canonicalize a non-finite number.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new CoreInputError('unsupported_value', `Cannot canonicalize a value of type ${typeof value}.`);
  }
}

export function sortedUnique(codes) {
  return [...new Set(codes)].sort();
}
