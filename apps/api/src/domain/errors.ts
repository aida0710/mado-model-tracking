export class DomainError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 422 | 429 | 502 | 503,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function notFound(entity: string): never {
  throw new DomainError(404, `${entity}が見つかりません`, 'not_found');
}

export function conflict(message: string): never {
  throw new DomainError(409, message, 'conflict');
}
