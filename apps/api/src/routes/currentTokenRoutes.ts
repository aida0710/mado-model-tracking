import { Hono } from "hono";
import type { CurrentApiToken } from "@mmt/contracts";
import { DomainError } from "../domain/errors.js";
import { principal, type ApiEnvironment } from "../http/request.js";

// Lets a token holder (e.g. `mado-tracking-worker doctor`) see its own scopes without listing tokens.
export function currentTokenRoutes(): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get("/", (context) => {
    const { token } = principal(context);
    if (!token)
      throw new DomainError(
        400,
        "API tokenで認証してください",
        "api_token_required",
      );
    const current: CurrentApiToken = {
      id: token.id,
      projectId: token.projectId,
      scopes: token.scopes,
      job: token.job !== undefined,
    };
    return context.json(current);
  });
  return routes;
}
