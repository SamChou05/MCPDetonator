import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  mkdtemp,
  open,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";

import {
  S3ArtifactStore,
  S3ArtifactStoreError,
  type S3CommandClient,
} from "../../src/publish/s3.js";

const temporaryDirectories: string[] = [];
const temporaryHandles: FileHandle[] = [];

async function temporarySnapshot(contents: Uint8Array): Promise<FileHandle> {
  const directory = await mkdtemp(join(tmpdir(), "forge-publish-s3-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "artifact.bin");
  await writeFile(path, contents);
  const handle = await open(path, "r");
  temporaryHandles.push(handle);
  return handle;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

class FakeS3Client implements S3CommandClient {
  public readonly commands: Array<PutObjectCommand | HeadObjectCommand> = [];

  readonly #handler: (
    command: PutObjectCommand | HeadObjectCommand,
  ) => Promise<unknown>;

  public constructor(
    handler: (command: PutObjectCommand | HeadObjectCommand) => Promise<unknown>,
  ) {
    this.#handler = handler;
  }

  public async send(
    command: PutObjectCommand | HeadObjectCommand,
  ): Promise<unknown> {
    this.commands.push(command);
    return this.#handler(command);
  }
}

afterEach(async () => {
  await Promise.allSettled(
    temporaryHandles.splice(0).map(async (handle) => handle.close()),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("S3ArtifactStore", () => {
  it("streams a first artifact upload with immutable command inputs", async () => {
    const contents = Buffer.from("exact artifact bytes\n", "utf8");
    const digest = sha256(contents);
    const sourceHandle = await temporarySnapshot(contents);
    let uploaded = Buffer.alloc(0);

    const client = new FakeS3Client(async (command) => {
      if (command instanceof HeadObjectCommand) {
        throw Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      if (!(command instanceof PutObjectCommand)) {
        throw new Error("unexpected command");
      }

      expect(command.input).toMatchObject({
        Bucket: "forge-runs",
        Key: `tenant-a/objects/sha256/${digest.slice(0, 2)}/${digest}`,
        ContentLength: contents.byteLength,
        ContentType: "application/octet-stream",
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
        IfNoneMatch: "*",
        Metadata: {
          "forge-sha256": digest,
          "forge-size-bytes": String(contents.byteLength),
        },
      });
      expect(command.input.Body).toBeInstanceOf(Readable);

      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body as Readable) {
        chunks.push(Buffer.from(chunk));
      }
      uploaded = Buffer.concat(chunks);
      return { ETag: '"etag"' };
    });
    const store = new S3ArtifactStore({
      client,
      bucket: "forge-runs",
      prefix: "/tenant-a/",
    });

    const result = await store.putArtifact({
      sourceHandle,
      sha256: digest.toUpperCase(),
      sizeBytes: contents.byteLength,
      contentType: "application/octet-stream",
    });

    expect(uploaded).toEqual(contents);
    expect(result).toEqual({
      bucket: "forge-runs",
      key: `tenant-a/objects/sha256/${digest.slice(0, 2)}/${digest}`,
      sha256: digest,
      sizeBytes: contents.byteLength,
      created: true,
    });
  });

  it("uploads exact manifest bytes to the stable per-run key", async () => {
    const bytes = Buffer.from('{"schema":"forge.run/v1"}\n', "utf8");
    const digest = sha256(bytes);
    let sentBody: Uint8Array | undefined;
    const client = new FakeS3Client(async (command) => {
      if (command instanceof HeadObjectCommand) {
        throw Object.assign(new Error("missing"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        });
      }
      expect(command).toBeInstanceOf(PutObjectCommand);
      if (!(command instanceof PutObjectCommand)) {
        throw new Error("unexpected command");
      }
      sentBody = command.input.Body as Uint8Array;
      expect(command.input).toMatchObject({
        Bucket: "forge-runs",
        Key: "forge/evidence/runs/run-20260830-abcd/run.json",
        ContentLength: bytes.byteLength,
        ContentType: "application/json",
        IfNoneMatch: "*",
      });
      return {};
    });
    const store = new S3ArtifactStore({
      client,
      bucket: "forge-runs",
      prefix: "forge//evidence/",
    });

    const result = await store.putManifest({
      runId: "run-20260830-abcd",
      bytes,
      sha256: digest,
    });

    expect(Buffer.from(sentBody ?? [])).toEqual(bytes);
    expect(result.key).toBe("forge/evidence/runs/run-20260830-abcd/run.json");
    expect(result.created).toBe(true);
  });

  it("normalizes safe prefixes and rejects unsafe key components", () => {
    const client = new FakeS3Client(async () => ({}));
    const digest = "A".repeat(64);
    const store = new S3ArtifactStore({
      client,
      bucket: "forge-runs",
      prefix: "/forge///evidence/",
    });

    expect(store.prefix).toBe("forge/evidence");
    expect(store.artifactKey(digest)).toBe(
      `forge/evidence/objects/sha256/aa/${digest.toLowerCase()}`,
    );
    expect(store.manifestKey("run-1")).toBe(
      "forge/evidence/runs/run-1/run.json",
    );

    expect(
      () =>
        new S3ArtifactStore({
          client,
          bucket: "forge-runs",
          prefix: "forge/../escape",
        }),
    ).toThrow(S3ArtifactStoreError);
    expect(
      () =>
        new S3ArtifactStore({
          client,
          bucket: "forge-runs",
          prefix: "forge\\escape",
        }),
    ).toThrow(S3ArtifactStoreError);
    expect(() => store.artifactKey("not-a-digest")).toThrow(
      S3ArtifactStoreError,
    );
    expect(() => store.manifestKey("../run")).toThrow(S3ArtifactStoreError);
    expect(() => store.manifestKey("run/escape")).toThrow(S3ArtifactStoreError);
  });

  it("uses a HEAD fast path for an idempotent retry when the object matches", async () => {
    const bytes = Buffer.from("retry artifact", "utf8");
    const digest = sha256(bytes);
    const sourceHandle = await temporarySnapshot(bytes);
    const client = new FakeS3Client(async (command) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return {
        ContentLength: bytes.byteLength,
        Metadata: { "forge-sha256": digest },
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
      };
    });
    const store = new S3ArtifactStore({ client, bucket: "forge-runs" });

    await expect(
      store.putArtifact({
        sourceHandle,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
      }),
    ).resolves.toEqual({
      bucket: "forge-runs",
      key: `objects/sha256/${digest.slice(0, 2)}/${digest}`,
      sha256: digest,
      sizeBytes: bytes.byteLength,
      created: false,
    });
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect((client.commands[0] as HeadObjectCommand).input.ChecksumMode).toBe(
      "ENABLED",
    );
  });

  it("rejects matching user metadata when the service checksum is absent", async () => {
    const bytes = Buffer.from("metadata is not integrity", "utf8");
    const digest = sha256(bytes);
    const sourceHandle = await temporarySnapshot(bytes);
    const client = new FakeS3Client(async () => ({
      ContentLength: bytes.byteLength,
      Metadata: { "forge-sha256": digest },
    }));
    const store = new S3ArtifactStore({ client, bucket: "forge-runs" });

    await expect(
      store.putArtifact({
        sourceHandle,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow("existing digest, service checksum, or length does not match");
  });

  it("recovers a conditional-create race by verifying the winner", async () => {
    const bytes = Buffer.from("racing artifact", "utf8");
    const digest = sha256(bytes);
    const sourceHandle = await temporarySnapshot(bytes);
    let headCalls = 0;
    const client = new FakeS3Client(async (command) => {
      if (command instanceof HeadObjectCommand) {
        headCalls += 1;
        if (headCalls === 1) {
          throw Object.assign(new Error("missing"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return {
          ContentLength: bytes.byteLength,
          Metadata: { "forge-sha256": digest },
          ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
        };
      }
      throw Object.assign(new Error("exists"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      });
    });
    const store = new S3ArtifactStore({ client, bucket: "forge-runs" });

    await expect(
      store.putArtifact({
        sourceHandle,
        sha256: digest,
        sizeBytes: bytes.byteLength,
        contentType: "application/octet-stream",
      }),
    ).resolves.toMatchObject({ created: false, sha256: digest });
    expect(client.commands.map((command) => command.constructor)).toEqual([
      HeadObjectCommand,
      PutObjectCommand,
      HeadObjectCommand,
    ]);
  });

  it.each([
    {
      name: "digest",
      head: {
        ContentLength: 4,
        Metadata: { "forge-sha256": "f".repeat(64) },
        ChecksumSHA256: Buffer.from(
          sha256(Buffer.from("same", "utf8")),
          "hex",
        ).toString("base64"),
      },
    },
    {
      name: "length",
      head: {
        ContentLength: 5,
        Metadata: { "forge-sha256": sha256(Buffer.from("same", "utf8")) },
        ChecksumSHA256: Buffer.from(
          sha256(Buffer.from("same", "utf8")),
          "hex",
        ).toString("base64"),
      },
    },
  ])(
    "rejects a conflicting existing object with mismatched $name",
    async ({ head }) => {
      const bytes = Buffer.from("same", "utf8");
      const digest = sha256(bytes);
      const sourceHandle = await temporarySnapshot(bytes);
      const client = new FakeS3Client(async () => head);
      const store = new S3ArtifactStore({ client, bucket: "forge-runs" });

      await expect(
        store.putArtifact({
          sourceHandle,
          sha256: digest,
          sizeBytes: bytes.byteLength,
          contentType: "application/octet-stream",
        }),
      ).rejects.toThrow("existing digest, service checksum, or length does not match");
    },
  );

  it("rejects changed source sizes and mismatched manifest digests before upload", async () => {
    const bytes = Buffer.from("bytes", "utf8");
    const sourceHandle = await temporarySnapshot(bytes);
    const client = new FakeS3Client(async () => {
      throw new Error("should not send");
    });
    const store = new S3ArtifactStore({ client, bucket: "forge-runs" });

    await expect(
      store.putArtifact({
        sourceHandle,
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength + 1,
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow("artifact snapshot size changed before upload");

    await expect(
      store.putManifest({
        runId: "run-1",
        bytes,
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("manifest SHA-256 mismatch");
    expect(client.commands).toHaveLength(0);
  });
});
