import { createHash } from 'node:crypto';

export const NORMALIZER_VERSION = 1;

export function stableValue(value) {
  if (value === undefined) throw new TypeError('undefined is not canonical JSON');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = stableValue(value[key]);
    }
    return output;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('non-finite numbers are not canonical JSON');
  }
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${typeof value} is not canonical JSON`);
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function commandHash(command) {
  return canonicalHash({
    normalizer_version: NORMALIZER_VERSION,
    name: command.name,
    version: command.version,
    target: command.target,
    affected_targets: command.affected_targets || [command.target],
    input: command.input,
    provenance: command.provenance || null,
    preconditions: command.preconditions,
  });
}

export function commandSetHash({ registryVersion, commands, provenance = null }) {
  return canonicalHash({
    normalizer_version: NORMALIZER_VERSION,
    registry_version: registryVersion,
    command_hashes: commands.map(command => command.command_hash || commandHash(command)),
    provenance,
  });
}
