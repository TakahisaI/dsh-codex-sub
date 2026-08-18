import { CodexError } from './errors.js'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface JsonValidationLimits {
  readonly maxDepth: number
  readonly maxKeys: number
  readonly maxArrayLength: number
  readonly maxStringLength: number
  readonly maxBytes: number
}

export const DEFAULT_JSON_VALIDATION_LIMITS: JsonValidationLimits = Object.freeze({
  maxDepth: 16,
  maxKeys: 1_024,
  maxArrayLength: 1_024,
  maxStringLength: 16_384,
  maxBytes: 65_536,
})

export type JsonValidationFailureReason =
  | 'accessor_property'
  | 'array_too_long'
  | 'cyclic_value'
  | 'invalid_limit'
  | 'invalid_number'
  | 'invalid_prototype'
  | 'key_too_long'
  | 'max_bytes'
  | 'max_depth'
  | 'max_keys'
  | 'non_enumerable_property'
  | 'sparse_array'
  | 'string_too_long'
  | 'symbol_property'
  | 'unsupported_type'

interface ValidationState {
  bytes: number
  keys: number
  readonly active: WeakSet<object>
  readonly limits: JsonValidationLimits
}

function invalidJson(reason: JsonValidationFailureReason): never {
  throw new CodexError('JSON value is not safe.', 'CODEX_AUTH_STORAGE_INVALID', {
    safeDetails: { reason },
  })
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function resolveLimits(overrides?: Partial<JsonValidationLimits>): JsonValidationLimits {
  const limits: JsonValidationLimits = {
    ...DEFAULT_JSON_VALIDATION_LIMITS,
    ...overrides,
  }

  if (
    !Number.isSafeInteger(limits.maxDepth)
    || limits.maxDepth < 0
    || !positiveSafeInteger(limits.maxKeys)
    || !positiveSafeInteger(limits.maxArrayLength)
    || !positiveSafeInteger(limits.maxStringLength)
    || !positiveSafeInteger(limits.maxBytes)
  ) {
    invalidJson('invalid_limit')
  }

  return limits
}

function validateString(value: string, state: ValidationState): string {
  if (value.length > state.limits.maxStringLength) {
    invalidJson('string_too_long')
  }
  return value
}

function jsonStringByteLength(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2
    } else if (
      codeUnit === 0x08
      || codeUnit === 0x09
      || codeUnit === 0x0a
      || codeUnit === 0x0c
      || codeUnit === 0x0d
    ) {
      bytes += 2
    } else if (codeUnit < 0x20) {
      bytes += 6
    } else if (codeUnit <= 0x7f) {
      bytes += 1
    } else if (codeUnit <= 0x7ff) {
      bytes += 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 6
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

function consumeBytes(state: ValidationState, amount: number): void {
  if (amount > state.limits.maxBytes - state.bytes) {
    invalidJson('max_bytes')
  }
  state.bytes += amount
}

function enterContainer(value: object, depth: number, state: ValidationState): void {
  if (depth > state.limits.maxDepth) {
    invalidJson('max_depth')
  }
  if (state.active.has(value)) {
    invalidJson('cyclic_value')
  }
  state.active.add(value)
}

function leaveContainer(value: object, state: ValidationState): void {
  state.active.delete(value)
}

function visitArray(value: unknown[], depth: number, state: ValidationState): JsonValue[] {
  if (value.length > state.limits.maxArrayLength) {
    invalidJson('array_too_long')
  }

  enterContainer(value, depth, state)
  try {
    consumeBytes(state, 1)
    const ownKeys = Reflect.ownKeys(value)
    for (const key of ownKeys) {
      if (typeof key === 'symbol') {
        invalidJson('symbol_property')
      }
      if (key === 'length') {
        continue
      }
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
        invalidJson('unsupported_type')
      }
    }

    const output: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        consumeBytes(state, 1)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined) {
        invalidJson('sparse_array')
      }
      if (!('value' in descriptor)) {
        invalidJson('accessor_property')
      }
      output.push(visit(descriptor.value, depth + 1, state))
    }
    consumeBytes(state, 1)
    return Object.freeze(output) as JsonValue[]
  } finally {
    leaveContainer(value, state)
  }
}

function visitObject(value: object, depth: number, state: ValidationState): JsonObject {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalidJson('invalid_prototype')
  }

  enterContainer(value, depth, state)
  try {
    const entries: Array<readonly [string, unknown]> = []
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        invalidJson('symbol_property')
      }
      if (key.length > state.limits.maxStringLength) {
        invalidJson('key_too_long')
      }

      state.keys += 1
      if (state.keys > state.limits.maxKeys) {
        invalidJson('max_keys')
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable) {
        invalidJson('non_enumerable_property')
      }
      if (!('value' in descriptor)) {
        invalidJson('accessor_property')
      }
      entries.push([key, descriptor.value])
    }

    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    consumeBytes(state, 1)
    const output = Object.create(null) as JsonObject
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index > 0) {
        consumeBytes(state, 1)
      }
      consumeBytes(state, jsonStringByteLength(key) + 1)
      output[key] = visit(entryValue, depth + 1, state)
    }
    consumeBytes(state, 1)
    return Object.freeze(output)
  } finally {
    leaveContainer(value, state)
  }
}

function visit(value: unknown, depth: number, state: ValidationState): JsonValue {
  if (value === null) {
    consumeBytes(state, 4)
    return value
  }
  if (typeof value === 'boolean') {
    consumeBytes(state, value ? 4 : 5)
    return value
  }
  if (typeof value === 'string') {
    const validated = validateString(value, state)
    consumeBytes(state, jsonStringByteLength(validated))
    return validated
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalidJson('invalid_number')
    }
    consumeBytes(state, JSON.stringify(value).length)
    return value
  }
  if (Array.isArray(value)) {
    return visitArray(value, depth, state)
  }
  if (typeof value === 'object') {
    return visitObject(value, depth, state)
  }
  invalidJson('unsupported_type')
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function validateJsonValue(
  value: unknown,
  limitOverrides?: Partial<JsonValidationLimits>,
): JsonValue {
  const limits = resolveLimits(limitOverrides)
  const validated = visit(value, 0, {
    active: new WeakSet<object>(),
    bytes: 0,
    keys: 0,
    limits,
  })
  return validated
}

export function validateJsonObject(
  value: unknown,
  limitOverrides?: Partial<JsonValidationLimits>,
): JsonObject {
  const validated = validateJsonValue(value, limitOverrides)
  if (validated === null || typeof validated !== 'object' || Array.isArray(validated)) {
    invalidJson('unsupported_type')
  }
  return validated
}

export function canonicalStringifyJson(
  value: unknown,
  limitOverrides?: Partial<JsonValidationLimits>,
): string {
  return JSON.stringify(validateJsonValue(value, limitOverrides))
}
