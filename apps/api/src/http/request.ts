import type { Context } from 'hono';
import type { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { DomainError } from '../domain/errors.js';
import { uuidSchema } from '../domain/validation.js';

export interface ApiEnvironment {
  Variables: { principal: Principal | null };
}
export type ApiContext = Context<ApiEnvironment>;

export function principal(context: ApiContext): Principal {
  const identity = context.get('principal');
  if (!identity) throw new DomainError(401, 'Loginが必要です', 'authentication_required');
  return identity;
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      422,
      `入力が不正です: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'body').join(', ')}`,
      'invalid_request',
    );
  return parsed.data;
}

export async function jsonBody<T>(context: ApiContext, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new DomainError(400, 'JSONを読み込めません', 'invalid_json');
  }
  return parse(schema, body);
}

export function uuidParam(context: ApiContext, name: string): string {
  return parse(uuidSchema, context.req.param(name));
}
