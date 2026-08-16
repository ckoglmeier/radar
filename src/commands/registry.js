import Ajv from 'ajv';
import { canonicalHash, NORMALIZER_VERSION, stableValue } from './canonical.js';
import { CommandError, CommandValidationError } from './errors.js';

const RISKS = new Set([
  'additive_reporting_fact',
  'metadata_change',
  'reconciliation',
  'corrective',
  'lifecycle',
  'sensitive_basis',
  'destructive',
  'explicit_override',
]);
const DOMAIN_ATOMICITY = new Set(['single_statement', 'multi_statement']);
const NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function clone(value) {
  return structuredClone(stableValue(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredFunction(definition, key) {
  if (typeof definition[key] !== 'function') {
    throw new TypeError(`command ${definition.name || '<unknown>'} requires ${key}()`);
  }
}

function semanticMetadata(definition) {
  return {
    name: definition.name,
    version: definition.version,
    risk: definition.risk,
    tier: definition.tier || 'A',
    domainAtomicity: definition.domainAtomicity,
    proposeCapabilities: definition.proposeCapabilities,
    applyCapabilities: definition.applyCapabilities,
    inputSchema: definition.inputSchema,
    resultSchema: definition.resultSchema,
  };
}

export class CommandRegistry {
  #definitions = new Map();
  #validators = new Map();
  #resultValidators = new Map();
  #ajv;

  constructor() {
    this.#ajv = new Ajv({
      allErrors: true,
      strict: true,
      allowUnionTypes: false,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
    });
    this.#ajv.addFormat('date', {
      type: 'string',
      validate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      },
    });
    this.#ajv.addFormat('uuid', {
      type: 'string',
      validate: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    });
  }

  register(definition) {
    if (!definition || typeof definition !== 'object') throw new TypeError('command definition is required');
    if (!NAME_PATTERN.test(definition.name || '')) throw new TypeError(`invalid command name: ${definition.name}`);
    if (!Number.isInteger(definition.version) || definition.version <= 0) {
      throw new TypeError(`invalid command version for ${definition.name}`);
    }
    if (!RISKS.has(definition.risk)) throw new TypeError(`invalid command risk: ${definition.risk}`);
    if (!DOMAIN_ATOMICITY.has(definition.domainAtomicity)) {
      throw new TypeError(`invalid command atomicity: ${definition.domainAtomicity}`);
    }
    if (!Array.isArray(definition.proposeCapabilities) || !Array.isArray(definition.applyCapabilities)) {
      throw new TypeError(`command ${definition.name} requires propose/apply capability arrays`);
    }
    for (const key of ['availability', 'resolve', 'inspect', 'preview', 'preconditions', 'affectedResources']) {
      requiredFunction(definition, key);
    }
    const key = `${definition.name}@${definition.version}`;
    if (this.#definitions.has(key)) throw new TypeError(`duplicate command definition: ${key}`);

    let inputValidator;
    let resultValidator;
    try {
      inputValidator = this.#ajv.compile(definition.inputSchema);
      resultValidator = this.#ajv.compile(definition.resultSchema);
    } catch (error) {
      throw new TypeError(`invalid schema for ${key}: ${error.message}`);
    }

    const stored = deepFreeze({ ...definition });
    this.#definitions.set(key, stored);
    this.#validators.set(key, inputValidator);
    this.#resultValidators.set(key, resultValidator);
    return stored;
  }

  get(name, version) {
    const definition = this.#definitions.get(`${name}@${version}`);
    if (!definition) throw new CommandError('COMMAND_UNSUPPORTED', `unsupported command: ${name}@${version}`);
    return definition;
  }

  validateInput(name, version, input) {
    const key = `${name}@${version}`;
    this.get(name, version);
    const candidate = clone(input);
    const validator = this.#validators.get(key);
    if (!validator(candidate)) {
      throw new CommandValidationError(`invalid input for ${key}`, clone(validator.errors || []));
    }
    return candidate;
  }

  validateResult(name, version, result) {
    const key = `${name}@${version}`;
    this.get(name, version);
    const candidate = clone(result);
    const validator = this.#resultValidators.get(key);
    if (!validator(candidate)) {
      throw new CommandValidationError(`invalid result for ${key}`, clone(validator.errors || []));
    }
    return candidate;
  }

  definitions() {
    return [...this.#definitions.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.version - b.version,
    );
  }

  metadata() {
    return this.definitions().map(definition => clone({
      ...semanticMetadata(definition),
      title: definition.title,
      description: definition.description,
    }));
  }

  registryVersion() {
    return canonicalHash({
      normalizer_version: NORMALIZER_VERSION,
      commands: this.definitions().map(semanticMetadata),
    });
  }
}

export function createCommandRegistry(definitions = []) {
  const registry = new CommandRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}
