// @summary Verify selection of the newest Windows Release/Shipping Studio archive from object metadata.

import { describe, expect, test } from "bun:test";
import { selectLatestWindowsStudioRelease } from "./studio-smoke/release-selection";

describe("Studio release selection", () => {
  test("selects the most recently modified Windows Release/Shipping archive", () => {
    const latest = selectLatestWindowsStudioRelease([
      {
        key: "Sandbox/Windows/37.1.0-release-37.3579.1_Sandbox_Shipping.zip",
        lastModified: "2026-07-29T09:00:00.000Z",
      },
      {
        key: "Sandbox/Windows/37.1.0-release-37.3580.1379000_Sandbox_Shipping.zip",
        lastModified: "2026-07-30T09:00:00.000Z",
      },
    ]);

    expect(latest.key).toBe("Sandbox/Windows/37.1.0-release-37.3580.1379000_Sandbox_Shipping.zip");
  });

  test("ignores Development, non-release, non-Windows, and empty objects", () => {
    expect(() =>
      selectLatestWindowsStudioRelease([
        {
          key: "Sandbox/Windows/1.29.0-sandbox-ovdr-6944.2364.6a27f32_Sandbox_Development.zip",
          lastModified: "2026-07-30T10:00:00.000Z",
        },
        {
          key: "Sandbox/Windows/37.1.0-release-37.3580.1_Sandbox_Development.zip",
          lastModified: "2026-07-30T10:00:00.000Z",
        },
        {
          key: "Sandbox/Mac/37.1.0-release-37.3580.1_Sandbox_Shipping.zip",
          lastModified: "2026-07-30T10:00:00.000Z",
        },
        {
          key: "Sandbox/Windows/37.1.0-release-37.3580.1_Sandbox_Shipping.zip",
          lastModified: "2026-07-30T10:00:00.000Z",
          size: 0,
        },
      ]),
    ).toThrow("No Windows Release/Shipping Studio archive");
  });

  test("ignores invalid timestamps and resolves ties deterministically", () => {
    const latest = selectLatestWindowsStudioRelease([
      {
        key: "Sandbox/Windows/99.0.0-release-invalid_Sandbox_Shipping.zip",
        lastModified: "not-a-date",
      },
      {
        key: "Sandbox/Windows/37.1.0-release-37.3580.1_Sandbox_Shipping.zip",
        lastModified: "2026-07-30T09:00:00.000Z",
      },
      {
        key: "Sandbox/Windows/37.1.0-release-37.3580.2_Sandbox_Shipping.zip",
        lastModified: "2026-07-30T09:00:00.000Z",
      },
    ]);

    expect(latest.key).toBe("Sandbox/Windows/37.1.0-release-37.3580.2_Sandbox_Shipping.zip");
  });

  test("supports the configured S3 prefix", () => {
    const latest = selectLatestWindowsStudioRelease(
      [
        {
          key: "custom/windows/37.1.0-release-37.3580.2_Sandbox_Shipping.zip",
          lastModified: "2026-07-30T09:00:00.000Z",
        },
      ],
      "custom/windows/",
    );

    expect(latest.key).toBe("custom/windows/37.1.0-release-37.3580.2_Sandbox_Shipping.zip");
  });
});
