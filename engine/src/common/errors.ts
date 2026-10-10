export type ErrorKind = 'not_found' | 'invalid' | 'conflict' | 'upstream';

/** Base class for errors the API knows how to explain to the user. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 'not_found');
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'invalid', details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'conflict');
  }
}

/** A source or target database rejected a request or could not be reached. */
export class UpstreamError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'upstream');
    this.cause = cause;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
