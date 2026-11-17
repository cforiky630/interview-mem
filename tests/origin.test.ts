import { after, test } from "node:test";
import assert from "node:assert/strict";
import { checkOrigin } from "../src/server/api";
import { AppError } from "../src/server/errors";

const originalBaseURL = process.env.BETTER_AUTH_URL;
const originalTrustedOrigins = process.env.BETTER_AUTH_TRUSTED_ORIGINS;

after(() => {
  for (const [key, value] of Object.entries({
    BETTER_AUTH_URL: originalBaseURL,
    BETTER_AUTH_TRUSTED_ORIGINS: originalTrustedOrigins,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("LAN access permits configured origins and rejects untrusted or spoofed origins", () => {
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "http://192.168.1.10:3000";
  const request = (origin?: string) =>
    new Request("http://192.168.1.10:3000/api/decks", {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
      },
    });

  for (const origin of ["http://localhost:3000", "http://192.168.1.10:3000"])
    assert.doesNotThrow(() => checkOrigin(request(origin)));

  for (const origin of [
    undefined,
    "null",
    "http://192.168.1.11:3000",
    "http://192.168.1.10:3001",
    "http://192.168.1.10:3000.attacker.example",
    "http://attacker.example",
  ])
    assert.throws(
      () => checkOrigin(request(origin)),
      (error) => error instanceof AppError && error.code === "INVALID_ORIGIN",
    );

  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  assert.throws(() => checkOrigin(request("http://192.168.1.10:3000")));
  assert.doesNotThrow(() => checkOrigin(request("http://localhost:3000")));
});
