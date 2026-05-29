// @summary Tests for currentEnv() — the DILIGENT_ENV-backed release env helper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { currentEnv } from "../src/env";

const KEY = "DILIGENT_ENV";

describe("currentEnv", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  test("defaults to 'prod' when DILIGENT_ENV is unset", () => {
    expect(currentEnv()).toBe("prod");
  });

  test("returns 'dev' when DILIGENT_ENV=dev", () => {
    process.env[KEY] = "dev";
    expect(currentEnv()).toBe("dev");
  });

  test("returns 'prod' when DILIGENT_ENV=prod", () => {
    process.env[KEY] = "prod";
    expect(currentEnv()).toBe("prod");
  });

  test("trims whitespace", () => {
    process.env[KEY] = "  dev  ";
    expect(currentEnv()).toBe("dev");
  });

  test("is case-insensitive for 'dev'", () => {
    process.env[KEY] = "DEV";
    expect(currentEnv()).toBe("dev");
  });

  test("falls back to 'prod' for unrecognized values", () => {
    process.env[KEY] = "staging";
    expect(currentEnv()).toBe("prod");
  });

  test("falls back to 'prod' for empty string", () => {
    process.env[KEY] = "";
    expect(currentEnv()).toBe("prod");
  });

  test("falls back to 'prod' for whitespace-only", () => {
    process.env[KEY] = "   ";
    expect(currentEnv()).toBe("prod");
  });
});
