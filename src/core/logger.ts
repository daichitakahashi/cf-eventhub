export interface Logger {
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

export class NopLogger implements Logger {
  debug(..._data: unknown[]) {}
  info(..._data: unknown[]) {}
  error(..._data: unknown[]) {}
}

export type LogLevel = "DEBUG" | "INFO" | "ERROR";

const logLevels: Record<LogLevel, number> = {
  DEBUG: 1,
  INFO: 2,
  ERROR: 3,
};

export const outputLogLevel =
  (logLevel: LogLevel) => (targetLogLevel: LogLevel) => {
    const l = logLevels[logLevel] || logLevels.INFO;
    return l <= logLevels[targetLogLevel];
  };

export class DefaultLogger implements Logger {
  /**
   * @param level Lowest log level to out.
   */
  constructor(private level: LogLevel) {}
  private get outputLogLevel() {
    return logLevels[this.level];
  }
  debug(...data: unknown[]) {
    if (this.outputLogLevel <= logLevels.DEBUG) {
      console.log("[DEBUG]:", ...data);
    }
  }
  info(...data: unknown[]) {
    if (logLevels.INFO <= this.outputLogLevel) {
      console.log("[INFO]:", ...data);
    }
  }
  error(...data: unknown[]) {
    if (logLevels.ERROR <= this.outputLogLevel) {
      console.error("[ERROR]", ...data);
    }
  }
}
