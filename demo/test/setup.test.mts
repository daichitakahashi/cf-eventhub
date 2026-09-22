import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSetupNames,
  DEFAULT_SETUP_COUNT,
  MAX_SETUP_COUNT,
  parseSetupCount,
} from "../src/setup.ts";

test("parses the total setup count", () => {
  assert.equal(parseSetupCount(new URLSearchParams()), DEFAULT_SETUP_COUNT);
  assert.equal(parseSetupCount(new URLSearchParams("count=1")), 1);
  assert.equal(parseSetupCount(new URLSearchParams("count=150")), 150);
  assert.equal(
    parseSetupCount(new URLSearchParams(`count=${MAX_SETUP_COUNT}`)),
    MAX_SETUP_COUNT,
  );
});

test("rejects invalid setup counts", () => {
  for (const value of ["", "0", "-1", "1.5", "abc", "01", "1001"]) {
    assert.equal(parseSetupCount(new URLSearchParams({ count: value })), null);
  }
});

test("creates one default and distinct eight-digit hex tenant names", () => {
  const names = createSetupNames(150);
  assert.equal(names.length, 150);
  assert.equal(names[0], "default");
  assert.equal(new Set(names).size, 150);
  for (const name of names.slice(1)) {
    assert.match(name, /^tenant:[0-9a-f]{8}$/);
  }
});
