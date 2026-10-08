import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentApiToken } from "@mmt/contracts";
import {
  createHarness,
  entity,
  request,
  testDatabaseUrl,
  type Harness,
} from "./harness.js";
import { projectFixture } from "./fixtures.js";

describe.skipIf(!testDatabaseUrl)(
  "認証に使ったAPI token自身の確認（独立PostgreSQL）",
  () => {
    let harness: Harness;
    beforeAll(async () => {
      harness = await createHarness();
    });
    beforeEach(async () => {
      await harness.reset();
    });
    afterAll(async () => {
      await harness?.close();
    });

    it("service tokenで呼ぶと、そのtokenのprojectとscopeが返る", async () => {
      const fixture = await projectFixture(harness);
      const minted = await entity<{ token: string; item: { id: string } }>(
        await request(harness.app, "/api/tokens", {
          method: "POST",
          cookie: fixture.administrator.cookie,
          body: {
            name: "Doctor Worker",
            kind: "service",
            projectId: fixture.project.id,
            scopes: ["read", "worker:execute"],
          },
        }),
      );
      const current = await entity<CurrentApiToken>(
        await request(harness.app, "/api/auth/token", { token: minted.token }),
        200,
      );
      expect(current).toEqual({
        id: minted.item.id,
        projectId: fixture.project.id,
        scopes: ["read", "worker:execute"],
        job: false,
      });
    });

    it("sessionでは400、未認証では401になる", async () => {
      const fixture = await projectFixture(harness);
      const withSession = await request(harness.app, "/api/auth/token", {
        cookie: fixture.viewer.cookie,
      });
      expect(withSession.status).toBe(400);
      expect(await withSession.json()).toMatchObject({
        code: "api_token_required",
      });
      expect((await request(harness.app, "/api/auth/token")).status).toBe(401);
    });
  },
);
