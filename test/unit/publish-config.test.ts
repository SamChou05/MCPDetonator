import { describe, expect, it } from "vitest";

import {
  loadPublishConfiguration,
  PublishConfigurationError,
} from "../../src/publish/config.js";

describe("loadPublishConfiguration", () => {
  it("loads the required destinations and safe defaults", () => {
    expect(
      loadPublishConfiguration({
        FORGE_PUBLISH_DATABASE_URL: "postgresql://forge:secret@db.example/forge",
        FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
      }),
    ).toEqual({
      databaseUrl: "postgresql://forge:secret@db.example/forge",
      s3Bucket: "forge-evidence",
      s3Region: "us-east-1",
      s3Prefix: "forge",
      s3ForcePathStyle: false,
    });
  });

  it("supports an S3-compatible local endpoint without embedding credentials", () => {
    expect(
      loadPublishConfiguration({
        FORGE_PUBLISH_DATABASE_URL: "postgres://forge:secret@localhost:55432/forge",
        FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
        FORGE_PUBLISH_S3_REGION: "local-1",
        FORGE_PUBLISH_S3_PREFIX: "demo",
        FORGE_PUBLISH_S3_ENDPOINT: "http://127.0.0.1:59000/",
        FORGE_PUBLISH_S3_FORCE_PATH_STYLE: "true",
      }),
    ).toEqual({
      databaseUrl: "postgres://forge:secret@localhost:55432/forge",
      s3Bucket: "forge-evidence",
      s3Region: "local-1",
      s3Prefix: "demo",
      s3ForcePathStyle: true,
      s3Endpoint: "http://127.0.0.1:59000",
    });
  });

  it("falls back to the standard AWS region variables", () => {
    const base = {
      FORGE_PUBLISH_DATABASE_URL: "postgresql://forge:secret@db.example/forge",
      FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
    };

    expect(
      loadPublishConfiguration({ ...base, AWS_REGION: "us-west-2" }).s3Region,
    ).toBe("us-west-2");
    expect(
      loadPublishConfiguration({
        ...base,
        AWS_DEFAULT_REGION: "eu-west-1",
      }).s3Region,
    ).toBe("eu-west-1");
  });

  it("rejects missing destinations and malformed non-secret settings", () => {
    expect(() => loadPublishConfiguration({})).toThrow(
      "FORGE_PUBLISH_DATABASE_URL is required",
    );
    expect(() =>
      loadPublishConfiguration({
        FORGE_PUBLISH_DATABASE_URL: "https://db.example/forge",
        FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
      }),
    ).toThrow(PublishConfigurationError);
    expect(() =>
      loadPublishConfiguration({
        FORGE_PUBLISH_DATABASE_URL: "postgresql://forge:secret@db.example/forge",
        FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
        FORGE_PUBLISH_S3_ENDPOINT: "https://user:secret@s3.example/bucket",
      }),
    ).toThrow("without credentials");
    expect(() =>
      loadPublishConfiguration({
        FORGE_PUBLISH_DATABASE_URL: "postgresql://forge:secret@db.example/forge",
        FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
        FORGE_PUBLISH_S3_FORCE_PATH_STYLE: "yes",
      }),
    ).toThrow("must be one of true, false, 1, or 0");
  });
});
