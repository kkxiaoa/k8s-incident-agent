import assert from "node:assert/strict";
import test from "node:test";

import { EvaluationError } from "../../src/shared/errors.ts";
import {
  canonicalJson,
  hasExactKeys,
  isNormalizedString,
  isPlainObject,
  isUuid,
  parseInstant,
  requireDate,
} from "../../src/shared/guards.ts";

const UPSTREAM_INVALID = (error: unknown) =>
  error instanceof EvaluationError && error.code === "upstream_contract_invalid";

test("plain objects exclude null, arrays, class instances and null prototypes", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(JSON.parse('{"a":1}')), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date(0)), false);
  assert.equal(isPlainObject(Object.create(null)), false);
  assert.equal(isPlainObject("{}"), false);
});

test("exact keys ignore order but reject missing and extra keys", () => {
  assert.equal(hasExactKeys({ b: 1, a: 2 }, ["a", "b"]), true);
  assert.equal(hasExactKeys({ a: 2 }, ["a", "b"]), false);
  assert.equal(hasExactKeys({ a: 2, b: 1, c: 0 }, ["a", "b"]), false);
  assert.equal(hasExactKeys(["a", "b"], ["0", "1"]), false);
});

test("normalized strings are non-empty, trimmed and free of control characters", () => {
  assert.equal(isNormalizedString("kind-evaluation"), true);
  assert.equal(isNormalizedString(""), false);
  assert.equal(isNormalizedString(" padded"), false);
  assert.equal(isNormalizedString("padded\n"), false);
  assert.equal(isNormalizedString("tab\tinside"), false);
  assert.equal(isNormalizedString("del\u007finside"), false);
  assert.equal(isNormalizedString(42), false);
});

test("UUIDs must be lowercase RFC 4122 variant 1 identifiers", () => {
  assert.equal(isUuid("0f5a2f6e-3c3b-4d2e-9a1b-2c3d4e5f6a7b"), true);
  assert.equal(isUuid("0F5A2F6E-3C3B-4D2E-9A1B-2C3D4E5F6A7B"), false);
  assert.equal(isUuid("0f5a2f6e-3c3b-0d2e-9a1b-2c3d4e5f6a7b"), false);
  assert.equal(isUuid("0f5a2f6e-3c3b-4d2e-1a1b-2c3d4e5f6a7b"), false);
  assert.equal(isUuid(undefined), false);
});

test("instants parse only normalized date strings", () => {
  assert.equal(parseInstant("2026-09-28T00:00:00Z"), Date.UTC(2026, 8, 28));
  assert.equal(parseInstant(" 2026-09-28T00:00:00Z"), undefined);
  assert.equal(parseInstant("not a date"), undefined);
  assert.equal(parseInstant(1_700_000_000_000), undefined);
});

test("dates must be valid Date instances", () => {
  const date = new Date("2026-09-28T00:00:00Z");
  assert.equal(requireDate(date), date);
  assert.throws(() => requireDate(new Date("invalid")), UPSTREAM_INVALID);
  assert.throws(() => requireDate("2026-09-28T00:00:00Z"), UPSTREAM_INVALID);
});

test("canonical JSON sorts keys recursively and rejects non-JSON values", () => {
  assert.equal(
    canonicalJson({ b: [true, null, { d: "x", c: 1.5 }], a: "z" }),
    '{"a":"z","b":[true,null,{"c":1.5,"d":"x"}]}',
  );
  assert.equal(canonicalJson("quote\"d"), '"quote\\"d"');
  assert.throws(() => canonicalJson(Number.NaN), UPSTREAM_INVALID);
  assert.throws(() => canonicalJson(undefined), UPSTREAM_INVALID);
  assert.throws(() => canonicalJson({ when: new Date(0) }), UPSTREAM_INVALID);
  assert.throws(() => canonicalJson(Object.create(null)), UPSTREAM_INVALID);
});
