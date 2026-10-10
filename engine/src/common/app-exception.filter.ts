import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { AppError, ErrorKind, errorMessage } from './errors';

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  upstream: 502,
};

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Turns every error into a JSON body with a human-readable `message`.
 * Unexpected errors usually come from a database driver ("relation does not exist",
 * "authentication failed"). This is a local tool used by engineers, so surfacing the
 * driver message is far more useful than a generic "Internal server error".
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { status, body } = this.toHttp(exception);
    if (status >= 500) {
      this.logger.error(errorMessage(exception), exception instanceof Error ? exception.stack : undefined);
    }
    response.status(status).json(body);
  }

  private toHttp(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const body = typeof payload === 'string' ? { message: payload } : (payload as Record<string, unknown>);
      return { status: exception.getStatus(), body };
    }
    if (exception instanceof AppError) {
      return {
        status: STATUS_BY_KIND[exception.kind],
        body: { message: exception.message, details: exception.details },
      };
    }
    return { status: 500, body: { message: errorMessage(exception) } };
  }
}
