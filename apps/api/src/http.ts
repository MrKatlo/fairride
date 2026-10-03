import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';

import { type AuthUser, bearerToken, verifyJwt } from './auth.ts';
import type { Env } from './env.ts';

/** Hono environment: our bindings plus the authenticated caller. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: AuthUser;
  };
}

export interface ProblemDetail {
  path: string;
  message: string;
}

/** An error that maps cleanly onto an HTTP response. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly details: ProblemDetail[] | undefined;

  constructor(status: ContentfulStatusCode, message: string, details?: ProblemDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, message);
}

/**
 * Parses and validates a JSON body. A validation failure returns 422 with the
 * offending paths, so the mobile client can highlight the exact field.
 */
export async function readJson<T>(c: { req: { json: () => Promise<unknown> } }, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      422,
      'Request failed validation.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(body)',
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/**
 * Verifies the JWT from the `Authorization` header, or from `?token=` for the
 * WebSocket route, where a header is awkward for some clients.
 *
 * Never trust anything else on the request - role and id come only from here.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization')) ?? c.req.query('token') ?? null;
  if (!token) throw new ApiError(401, 'Missing bearer token.');

  const user = await verifyJwt(token, c.env.JWT_SECRET);
  if (!user) throw new ApiError(401, 'Invalid or expired token.');

  c.set('user', user);
  await next();
});

/** Restricts a route to one or more persisted roles. */
export function requireRole(...roles: AuthUser['role'][]): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    if (!roles.includes(user.role)) throw forbidden(`This action requires role: ${roles.join(' or ')}.`);
    await next();
  });
}
