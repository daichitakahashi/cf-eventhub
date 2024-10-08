import { describe, expect, test } from "vitest";
import { type LogLevel, outputLogLevel } from "./logger";

describe("outputLogLevel", () => {
  test.each([
    { logLevel: "DEBUG", target: "DEBUG", expected: true },
    { logLevel: "DEBUG", target: "INFO", expected: true },
    { logLevel: "DEBUG", target: "INFO", expected: true },
    { logLevel: "INFO", target: "DEBUG", expected: false },
    { logLevel: "INFO", target: "INFO", expected: true },
    { logLevel: "INFO", target: "ERROR", expected: true },
    { logLevel: "ERROR", target: "DEBUG", expected: false },
    { logLevel: "ERROR", target: "INFO", expected: false },
    { logLevel: "ERROR", target: "ERROR", expected: true },
    { logLevel: "UNKNOWN", target: "DEBUG", expected: false },
    { logLevel: "UNKNOWN", target: "INFO", expected: true },
    { logLevel: "UNKNOWN", target: "ERROR", expected: true },
  ])(
    "logLevel $logLevel outputs $target log -> $expected",
    ({ logLevel, target, expected }) => {
      const comparer = outputLogLevel(logLevel as LogLevel);
      expect(comparer(target as LogLevel)).toBe(expected);
    },
  );
});
