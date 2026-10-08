import { getConnInfo } from '@hono/node-server/conninfo';
import type { ApiContext } from './request.js';

export interface RequestMetadata {
  ip: string | null;
  userAgent: string | null;
}

// Matches the audit_events column limits so oversized client headers cannot fail the INSERT.
const MAX_USER_AGENT_LENGTH = 1000;

// Forwarded headers are client-controlled unless a trusted proxy is configured, so only the socket address is used.
function socketAddress(context: ApiContext): string | null {
  try {
    return getConnInfo(context).remote.address ?? null;
  } catch {
    // In-process requests such as app.request() in tests have no Node socket.
    return null;
  }
}

export function requestMetadata(context: ApiContext): RequestMetadata {
  const userAgent = context.req.header('User-Agent');
  return {
    ip: socketAddress(context),
    userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}
