import { describe, expect, test } from "vitest";

import { MonotonicUlidGenerator, ULID_LENGTH } from "./id";

describe("MonotonicUlidGenerator", () => {
  test("creates lexicographically increasing ids at the same timestamp", () => {
    const now = 1_777_777_777_777;
    const generator = new MonotonicUlidGenerator();
    const ids = [
      generator.generate(now),
      generator.generate(now),
      generator.generate(now),
    ];

    expect([...new Set(ids)]).toHaveLength(3);
    expect([ids[0] < ids[1], ids[1] < ids[2]]).toStrictEqual([true, true]);
    expect([...ids].sort()).toStrictEqual(ids);
    expect(ids.map((id) => id.length)).toStrictEqual([
      ULID_LENGTH,
      ULID_LENGTH,
      ULID_LENGTH,
    ]);
  });

  test("keeps ids sortable when timestamps advance", () => {
    const generator = new MonotonicUlidGenerator();
    const first = generator.generate(1_777_777_777_777);
    const second = generator.generate(1_777_777_777_778);

    expect(first < second).toBe(true);
  });

  test("keeps ids monotonic when timestamps move backwards", () => {
    const generator = new MonotonicUlidGenerator();
    const first = generator.generate(1_777_777_777_777);
    const second = generator.generate(1_777_777_777_776);

    expect(first < second).toBe(true);
  });

  test("rejects timestamps outside the ULID 48-bit range", () => {
    const generator = new MonotonicUlidGenerator();

    expect(() => generator.generate(2 ** 48)).toThrowError(
      "eventhub: invalid ULID timestamp",
    );
  });
});
