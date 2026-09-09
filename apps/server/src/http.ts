import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  throw new HttpError(
    400,
    'Validation failed.',
    result.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  );
}
