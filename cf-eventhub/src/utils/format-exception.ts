type FormattedException = {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
};

export function formatException(error: unknown): FormattedException | unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }
  return error;
}
