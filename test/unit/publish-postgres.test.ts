import { describe, expect, it } from "vitest";

import {
  PostgresPublicationRepository,
  type BeginPublicationInput,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResultLike,
  type PublishedArtifactInput,
  type PublishedFindingInput,
} from "../../src/publish/postgres.js";
import {
  MAX_PUBLICATION_ARTIFACT_COUNT,
  MAX_PUBLICATION_FINDING_COUNT,
} from "../../src/publish/limits.js";

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

type QueryHandler = (
  text: string,
  values: readonly unknown[],
) => Promise<PgQueryResultLike> | PgQueryResultLike;

function queryResult(
  rows: readonly Record<string, unknown>[] = [],
): PgQueryResultLike {
  return { rows, rowCount: rows.length };
}

class FakeClient implements PgClientLike {
  public readonly calls: QueryCall[] = [];
  public releaseCount = 0;

  public constructor(private readonly handler: QueryHandler) {}

  public async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResultLike> {
    this.calls.push({ text, values });
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SET LOCAL lock_timeout")
    ) {
      return queryResult();
    }
    return this.handler(text, values);
  }

  public release(): void {
    this.releaseCount += 1;
  }
}

class FakePool implements PgPoolLike {
  public readonly calls: QueryCall[] = [];
  public endCount = 0;

  public constructor(
    public readonly client: FakeClient,
    private readonly handler: QueryHandler = () => queryResult(),
  ) {}

  public async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResultLike> {
    this.calls.push({ text, values });
    return this.handler(text, values);
  }

  public async connect(): Promise<PgClientLike> {
    return this.client;
  }

  public async end(): Promise<void> {
    this.endCount += 1;
  }
}

const manifestSha256 = "a".repeat(64);
const artifactSha256 = "b".repeat(64);

const beginInput: BeginPublicationInput = {
  runId: "run-20260830-test",
  targetId: "fixture-target",
  manifestSchema: "forge.run/v1",
  manifestSha256,
  storageBucket: "forge-evidence",
  storagePrefix: "forge/v1",
  runCreatedAt: "2026-08-30T18:00:00.000Z",
  runCompletedAt: "2026-08-30T18:01:00.000Z",
  publicMetadata: { source: "verified-local-bundle", retry: 0 },
};

const artifact: PublishedArtifactInput = {
  path: "report.json",
  sha256: artifactSha256,
  sizeBytes: 412,
  mediaType: "application/json",
  storageBucket: "forge-evidence",
  objectKey: `forge/v1/artifacts/sha256/${artifactSha256}`,
  etag: '"artifact-etag"',
  publicMetadata: { role: "report" },
};

const finding: PublishedFindingInput = {
  findingId: "finding-1",
  ruleId: "rule-1",
  title: "Synthetic finding",
  summary: "A bounded, non-secret finding summary.",
  severity: "medium",
  confidence: "high",
  publicMetadata: {
    eventIds: ["event-1"],
    limitations: ["selected-input evidence only"],
  },
};

function runRow(
  status: "publishing" | "published",
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    runId: beginInput.runId,
    targetId: beginInput.targetId,
    manifestSchema: beginInput.manifestSchema,
    manifestSha256: beginInput.manifestSha256,
    storageBucket: beginInput.storageBucket,
    storagePrefix: beginInput.storagePrefix,
    manifestObjectKey:
      status === "published" ? "forge/v1/runs/run-20260830-test/run.json" : null,
    status,
    runCreatedAt: beginInput.runCreatedAt,
    runCompletedAt: beginInput.runCompletedAt,
    publicationStartedAt: "2026-08-30T18:02:00.000Z",
    publishedAt: status === "published" ? "2026-08-30T18:03:00.000Z" : null,
    publicMetadata: beginInput.publicMetadata,
    ...overrides,
  };
}

function artifactRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    path: artifact.path,
    sha256: artifact.sha256,
    sizeBytes: String(artifact.sizeBytes),
    mediaType: artifact.mediaType,
    storageBucket: artifact.storageBucket,
    objectKey: artifact.objectKey,
    etag: artifact.etag,
    publicMetadata: artifact.publicMetadata,
    ...overrides,
  };
}

function findingRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    ruleId: finding.ruleId,
    title: finding.title,
    summary: finding.summary,
    severity: finding.severity,
    confidence: finding.confidence,
    publicMetadata: finding.publicMetadata,
    ...overrides,
  };
}

describe("PostgresPublicationRepository", () => {
  it("initializes the bounded relational schema under a transaction and advisory lock", async () => {
    const client = new FakeClient(() => queryResult());
    const pool = new FakePool(client);
    const repository = new PostgresPublicationRepository(pool);

    await repository.ensureSchema();
    await repository.ensureSchema();

    expect(client.calls[0]?.text).toBe("BEGIN");
    expect(client.calls[2]).toMatchObject({
      text: "SELECT pg_advisory_xact_lock($1)",
    });
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
    expect(client.calls.filter((call) => call.text === "BEGIN")).toHaveLength(1);
    expect(client.releaseCount).toBe(1);

    const ddl = client.calls.map((call) => call.text).join("\n");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS forge_published_runs");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS forge_published_artifacts");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS forge_published_findings");
    expect(ddl).toContain("REFERENCES forge_published_runs(run_id) ON DELETE CASCADE");
    expect(ddl).toContain("public_metadata JSONB");
    expect(ddl).toContain("status IN ('publishing', 'published')");
    expect(ddl).toContain("forge_published_runs_target_completed_idx");
    expect(ddl).toContain("forge_published_findings_rule_severity_idx");
  });

  it("begins a new publication with parameterized SQL", async () => {
    const client = new FakeClient((text) => {
      if (text.includes("INSERT INTO forge_published_runs")) {
        return queryResult([runRow("publishing")]);
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const pool = new FakePool(client);
    const repository = new PostgresPublicationRepository(pool);

    const result = await repository.beginPublication(beginInput);

    expect(result.disposition).toBe("created");
    expect(result.run).toMatchObject({
      runId: beginInput.runId,
      status: "publishing",
      manifestSha256,
    });
    const dataCalls = client.calls.filter(
      (candidate) => candidate.text.includes("forge_published_runs"),
    );
    expect(dataCalls).toHaveLength(1);
    const call = dataCalls[0];
    expect(call?.text).toContain("ON CONFLICT (run_id) DO NOTHING");
    expect(call?.text).not.toContain(beginInput.runId);
    expect(call?.text).not.toContain(beginInput.storageBucket);
    expect(call?.values.slice(0, 6)).toEqual([
      beginInput.runId,
      beginInput.targetId,
      beginInput.manifestSchema,
      beginInput.manifestSha256,
      beginInput.storageBucket,
      beginInput.storagePrefix,
    ]);
    expect(call?.values[8]).toBe(
      '{"retry":0,"source":"verified-local-bundle"}',
    );
  });

  it.each([
    ["publishing", "resumed"],
    ["published", "already_published"],
  ] as const)(
    "returns %s rows as %s without duplicating the run",
    async (status, disposition) => {
      let callCount = 0;
      const client = new FakeClient((text) => {
        callCount += 1;
        if (callCount === 1 && text.includes("INSERT INTO forge_published_runs")) {
          return queryResult();
        }
        if (callCount === 2 && text.includes("FROM forge_published_runs")) {
          return queryResult([runRow(status)]);
        }
        throw new Error(`unexpected client query: ${text}`);
      });
      const pool = new FakePool(client);
      const repository = new PostgresPublicationRepository(pool);

      await expect(repository.beginPublication(beginInput)).resolves.toMatchObject({
        disposition,
        run: { status },
      });
      expect(callCount).toBe(2);
    },
  );

  it("rejects reuse of a run ID with a different manifest digest", async () => {
    const client = new FakeClient((text) =>
      text.includes("INSERT INTO forge_published_runs")
        ? queryResult()
        : queryResult([runRow("publishing", { manifestSha256: "c".repeat(64) })]),
    );
    const pool = new FakePool(client);
    const repository = new PostgresPublicationRepository(pool);

    await expect(repository.beginPublication(beginInput)).rejects.toMatchObject({
      name: "PublicationRepositoryError",
      code: "identity_conflict",
    });
  });

  it("finalizes artifacts and findings before making the run queryably published", async () => {
    const manifestObjectKey = "forge/v1/runs/run-20260830-test/run.json";
    const client = new FakeClient((text) => {
      if (text === "BEGIN" || text === "COMMIT") {
        return queryResult();
      }
      if (text.includes("FOR UPDATE")) {
        return queryResult([runRow("publishing")]);
      }
      if (text.includes("INSERT INTO forge_published_artifacts")) {
        return queryResult([artifactRow()]);
      }
      if (text.includes("INSERT INTO forge_published_findings")) {
        return queryResult([findingRow()]);
      }
      if (text.includes("COUNT(*)") && text.includes("artifacts")) {
        return queryResult([{ count: 1 }]);
      }
      if (text.includes("COUNT(*)") && text.includes("findings")) {
        return queryResult([{ count: 1 }]);
      }
      if (text.includes("UPDATE forge_published_runs")) {
        return queryResult([
          runRow("published", { manifestObjectKey }),
        ]);
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const pool = new FakePool(client);
    const repository = new PostgresPublicationRepository(pool);

    const result = await repository.finalizePublication({
      runId: beginInput.runId,
      manifestSha256,
      manifestObjectKey,
      artifacts: [artifact],
      findings: [finding],
    });

    expect(result).toMatchObject({
      disposition: "published",
      artifactCount: 1,
      findingCount: 1,
      run: { status: "published", manifestObjectKey },
    });
    const statements = client.calls.map((call) => call.text);
    const artifactInsertIndex = statements.findIndex((text) =>
      text.includes("INSERT INTO forge_published_artifacts"),
    );
    const findingInsertIndex = statements.findIndex((text) =>
      text.includes("INSERT INTO forge_published_findings"),
    );
    const publishUpdateIndex = statements.findIndex((text) =>
      text.includes("UPDATE forge_published_runs"),
    );
    expect(statements[0]).toBe("BEGIN");
    expect(artifactInsertIndex).toBeGreaterThan(0);
    expect(findingInsertIndex).toBeGreaterThan(artifactInsertIndex);
    expect(publishUpdateIndex).toBeGreaterThan(findingInsertIndex);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.releaseCount).toBe(1);

    const artifactCall = client.calls[artifactInsertIndex];
    expect(artifactCall?.text).not.toContain(artifact.objectKey);
    expect(artifactCall?.values).toContain(artifact.objectKey);
    const findingCall = client.calls[findingInsertIndex];
    expect(findingCall?.text).not.toContain(finding.summary);
    expect(findingCall?.values).toContain(finding.summary);
  });

  it("replays identical metadata idempotently and reports an already-published disposition", async () => {
    const manifestObjectKey = "forge/v1/runs/run-20260830-test/run.json";
    const client = new FakeClient((text) => {
      if (text === "BEGIN" || text === "COMMIT") {
        return queryResult();
      }
      if (text.includes("FOR UPDATE")) {
        return queryResult([runRow("published", { manifestObjectKey })]);
      }
      if (
        text.includes("FROM forge_published_artifacts") &&
        !text.includes("COUNT(*)")
      ) {
        return queryResult([artifactRow()]);
      }
      if (
        text.includes("FROM forge_published_findings") &&
        !text.includes("COUNT(*)")
      ) {
        return queryResult([findingRow()]);
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const repository = new PostgresPublicationRepository(new FakePool(client));

    const result = await repository.finalizePublication({
      runId: beginInput.runId,
      manifestSha256,
      manifestObjectKey,
      artifacts: [artifact],
      findings: [finding],
    });

    expect(result.disposition).toBe("already_published");
    expect(
      client.calls.some((call) =>
        call.text.includes("FROM forge_published_artifacts"),
      ),
    ).toBe(true);
    expect(
      client.calls.some((call) =>
        call.text.includes("FROM forge_published_findings"),
      ),
    ).toBe(true);
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO forge_published_")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("UPDATE forge_published_runs")),
    ).toBe(false);
  });

  it("rolls back and withholds published state when a metadata write fails", async () => {
    const client = new FakeClient((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") {
        return queryResult();
      }
      if (text.includes("FOR UPDATE")) {
        return queryResult([runRow("publishing")]);
      }
      if (text.includes("INSERT INTO forge_published_artifacts")) {
        return queryResult([artifactRow()]);
      }
      if (text.includes("INSERT INTO forge_published_findings")) {
        throw new Error("simulated finding insert failure");
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const repository = new PostgresPublicationRepository(new FakePool(client));

    await expect(
      repository.finalizePublication({
        runId: beginInput.runId,
        manifestSha256,
        manifestObjectKey: "forge/v1/runs/run-20260830-test/run.json",
        artifacts: [artifact],
        findings: [finding],
      }),
    ).rejects.toThrow("simulated finding insert failure");

    expect(client.calls.map((call) => call.text).at(-1)).toBe("ROLLBACK");
    expect(
      client.calls.some((call) => call.text.includes("UPDATE forge_published_runs")),
    ).toBe(false);
    expect(client.calls.some((call) => call.text === "COMMIT")).toBe(false);
    expect(client.releaseCount).toBe(1);
  });

  it("rolls back when an idempotency key resolves to different artifact metadata", async () => {
    const client = new FakeClient((text) => {
      if (text === "BEGIN" || text === "ROLLBACK") {
        return queryResult();
      }
      if (text.includes("FOR UPDATE")) {
        return queryResult([runRow("publishing")]);
      }
      if (text.includes("INSERT INTO forge_published_artifacts")) {
        return queryResult();
      }
      if (text.includes("FROM forge_published_artifacts")) {
        return queryResult([artifactRow({ sha256: "d".repeat(64) })]);
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const repository = new PostgresPublicationRepository(new FakePool(client));

    await expect(
      repository.finalizePublication({
        runId: beginInput.runId,
        manifestSha256,
        manifestObjectKey: "forge/v1/runs/run-20260830-test/run.json",
        artifacts: [artifact],
        findings: [],
      }),
    ).rejects.toMatchObject({
      code: "metadata_conflict",
    });
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("bounds public JSON metadata before issuing SQL", async () => {
    const client = new FakeClient(() => queryResult());
    const pool = new FakePool(client);
    const repository = new PostgresPublicationRepository(pool);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(
      repository.beginPublication({
        ...beginInput,
        publicMetadata: cyclic as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(pool.calls).toHaveLength(0);
  });

  it.each([
    {
      name: "NUL metadata",
      input: {
        ...beginInput,
        publicMetadata: { nested: { value: "\0" } },
      },
    },
    {
      name: "unpaired surrogate text",
      input: { ...beginInput, targetId: `target-\ud800` },
    },
    {
      name: "jsonb expansion headroom",
      input: {
        ...beginInput,
        publicMetadata: { value: "😀".repeat(16_382) },
      },
    },
  ])("rejects PostgreSQL-incompatible $name before SQL", async ({ input }) => {
    const client = new FakeClient(() => queryResult());
    const pool = new FakePool(client);
    const repository = new PostgresPublicationRepository(pool);

    await expect(
      repository.beginPublication(input as BeginPublicationInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(client.calls).toHaveLength(0);
    expect(pool.calls).toHaveLength(0);
  });

  it("bounds artifact and finding row counts during pure preflight", () => {
    const repository = new PostgresPublicationRepository(
      new FakePool(new FakeClient(() => queryResult())),
    );
    expect(() =>
      repository.validateFinalization({
        runId: beginInput.runId,
        manifestSha256,
        manifestObjectKey: "forge/v1/runs/run-20260830-test/run.json",
        artifacts: Array.from(
          { length: MAX_PUBLICATION_ARTIFACT_COUNT + 1 },
          () => artifact,
        ),
        findings: [],
      }),
    ).toThrow("artifacts must contain at most");
    expect(() =>
      repository.validateFinalization({
        runId: beginInput.runId,
        manifestSha256,
        manifestObjectKey: "forge/v1/runs/run-20260830-test/run.json",
        artifacts: [],
        findings: Array.from(
          { length: MAX_PUBLICATION_FINDING_COUNT + 1 },
          () => finding,
        ),
      }),
    ).toThrow("findings must contain at most");
  });

  it("rejects an extra row on a published retry without mutating the set", async () => {
    const manifestObjectKey = "forge/v1/runs/run-20260830-test/run.json";
    const ghostArtifact = artifactRow({
      path: "ghost.json",
      objectKey: "forge/v1/objects/ghost",
    });
    const client = new FakeClient((text) => {
      if (text.includes("FOR UPDATE")) {
        return queryResult([runRow("published", { manifestObjectKey })]);
      }
      if (text.includes("FROM forge_published_artifacts")) {
        return queryResult([artifactRow(), ghostArtifact]);
      }
      if (text.includes("FROM forge_published_findings")) {
        return queryResult([findingRow()]);
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const repository = new PostgresPublicationRepository(new FakePool(client));

    await expect(
      repository.finalizePublication({
        runId: beginInput.runId,
        manifestSha256,
        manifestObjectKey,
        artifacts: [artifact],
        findings: [finding],
      }),
    ).rejects.toMatchObject({ code: "metadata_conflict" });
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(
      client.calls.some((call) => call.text.includes("INSERT INTO forge_published_")),
    ).toBe(false);
    expect(
      client.calls.some((call) => call.text.includes("UPDATE forge_published_runs")),
    ).toBe(false);
  });

  it("only closes pools explicitly owned by the repository", async () => {
    const injectedPool = new FakePool(new FakeClient(() => queryResult()));
    const injected = new PostgresPublicationRepository(injectedPool);
    await injected.close();
    expect(injectedPool.endCount).toBe(0);
    await expect(injected.getPublication(beginInput.runId)).rejects.toMatchObject({
      code: "repository_closed",
    });

    const ownedPool = new FakePool(new FakeClient(() => queryResult()));
    const owned = new PostgresPublicationRepository(ownedPool, {
      ownsPool: true,
    });
    await owned.close();
    await owned.close();
    expect(ownedPool.endCount).toBe(1);
  });
});
