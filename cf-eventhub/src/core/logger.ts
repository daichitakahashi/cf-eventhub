type LogData = unknown | (() => unknown);
export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
}

export class NopLogger implements Logger {
  debug(_: string, __?: LogData) {}
  info(_: string, __?: LogData) {}
  error(_: string, __?: LogData) {}
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
  private outputLogLevel: (targetLogLevel: LogLevel) => boolean;

  /**
   * @param level Lowest log level to out.
   */
  constructor(level: LogLevel) {
    this.outputLogLevel = outputLogLevel(level);
  }

  debug(message: string, data?: LogData) {
    if (this.outputLogLevel("DEBUG")) {
      console.log({
        logLevel: "DEBUG",
        message,
        data: typeof data === "function" ? data() : data,
      });
    }
  }
  info(message: string, data?: LogData) {
    if (this.outputLogLevel("INFO")) {
      console.log({
        logLevel: "INFO",
        message,
        data: typeof data === "function" ? data() : data,
      });
    }
  }
  error(message: string, data?: LogData) {
    if (this.outputLogLevel("ERROR")) {
      console.log({
        logLevel: "ERROR",
        message,
        data: typeof data === "function" ? data() : data,
      });
    }
  }
}
