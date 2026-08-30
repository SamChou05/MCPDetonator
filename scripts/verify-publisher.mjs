import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

import {
  reportV1Schema,
  runManifestV1Schema,
} from "../dist/contracts/v1.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(projectRoot, "compose.publisher-demo.yml");
const deceptiveReportPath = resolve(
  projectRoot,
  "examples/reports/deceptive-control.report.json",
);
const officialReportPath = resolve(
  projectRoot,
  "examples/reports/official-filesystem.report.json",
);
const dashboardIndexPath = resolve(
  projectRoot,
  "dist/dashboard-site/index.html",
);
const targetConfigDigests = new Map([
  [
    "deceptive-document-summarizer",
    "fa4839a21415c8990e5d0de59ba6c063755fd01f5b1d723445573b019647cd89",
  ],
  [
    "official-filesystem",
    "6f82c83aa0734dd7635397b42447bf2bfafc735692ed2980f949ebbddb099d20",
  ],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function reservePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      invariant(
        typeof address === "object" && address !== null,
        "failed to reserve a local verification port",
      );
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolveClose) => server.close(resolveClose)),
      ),
    );
  }
}

async function createRunFixture(root, reportPath, tamperEvidence = false) {
  const report = reportV1Schema.parse(
    JSON.parse(await readFile(reportPath, "utf8")),
  );
  // This storage verifier uses generic synthetic evidence. Optional
  // observation-health cross-binding has dedicated bundle tests, so remove it
  // when checked-in sample reports happen to include that artifact reference.
  delete report.observationHealth;
  delete report.evidence.observationHealth;
  const runId = report.runId;
  const configSha256 = targetConfigDigests.get(report.targetId);
  invariant(configSha256 !== undefined, "publisher fixture target is not allowlisted");
  const runDirectory = join(root, runId);
  await mkdir(runDirectory);

  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const evidenceBytes = Buffer.from("bounded publisher verification evidence\n", "utf8");
  await Promise.all([
    writeFile(join(runDirectory, "report.json"), reportBytes),
    writeFile(join(runDirectory, "publisher-evidence.txt"), evidenceBytes),
  ]);
  const referencedPaths = [
    report.evidence.events,
    report.evidence.phases,
    report.evidence.attributions,
    report.evidence.findings,
    report.evidence.targetProvenance,
    report.evidence.staticInspection,
    report.evidence.preInstallStaticInspection,
    report.evidence.semanticInspection,
    report.evidence.preInstallSemanticInspection,
    report.evidence.installDelta,
    report.evidence.advertisedClaims,
    ...report.runtimeObservations.flatMap((observation) => {
      const refs = observation.filesystemStateDelta?.artifactRefs;
      return refs === undefined ? [] : [refs.before, refs.after, refs.delta];
    }),
  ].filter((path) => path !== undefined);
  const referencedArtifacts = await Promise.all(
    [...new Set(referencedPaths)].map(async (path) => {
      const bytes = Buffer.from(`synthetic referenced evidence: ${path}\n`, "utf8");
      const outputPath = join(runDirectory, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
      return { path, bytes, sha256: sha256(bytes) };
    }),
  );

  const manifest = runManifestV1Schema.parse({
    schema: "forge.run/v1",
    runId,
    targetId: report.targetId,
    configSha256,
    status: "completed",
    createdAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    sandboxPolicy: {
      profile: "developer-v1",
      network: "blocked",
      timeoutMs: 10_000,
    },
    toolchain: {
      forgeVersion: "0.1.0",
      nodeVersion: process.version,
      observerImageReference: "forge-publisher-verifier:test",
      observerImageId: `sha256:${"d".repeat(64)}`,
    },
    limitations: ["Synthetic storage publication verifier."],
    artifacts: [
      {
        path: "report.json",
        sha256: sha256(reportBytes),
        mediaType: "application/json",
      },
      {
        path: "publisher-evidence.txt",
        sha256: sha256(evidenceBytes),
        mediaType: "text/plain",
      },
      ...referencedArtifacts.map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
        mediaType: "application/octet-stream",
      })),
    ],
  });
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(runDirectory, "run.json"), manifestBytes);
  if (tamperEvidence) {
    await writeFile(
      join(runDirectory, "publisher-evidence.txt"),
      "tampered after manifest creation\n",
    );
  }

  return {
    runDirectory,
    runId,
    findingCount: report.findings.length,
    manifestBytes,
    artifacts: [
      {
        path: "report.json",
        bytes: reportBytes,
        sha256: sha256(reportBytes),
      },
      {
        path: "publisher-evidence.txt",
        bytes: evidenceBytes,
        sha256: sha256(evidenceBytes),
      },
      ...referencedArtifacts,
    ],
    manifestSha256: sha256(manifestBytes),
  };
}

async function objectBytes(output, label) {
  invariant(output.Body !== undefined, `${label} GET returned no body`);
  if (typeof output.Body.transformToByteArray === "function") {
    return Buffer.from(await output.Body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of output.Body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function runForgePublish(
  runDirectory,
  environment,
  expectSuccess = true,
  refreshDashboard = false,
) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        resolve(projectRoot, "dist/cli.js"),
        "publish-run",
        runDirectory,
        ...(refreshDashboard ? ["--refresh-dashboard"] : []),
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, ...environment },
        maxBuffer: 2 * 1_024 * 1_024,
      },
    );
    if (!expectSuccess) {
      throw new Error("tampered run publication unexpectedly succeeded");
    }
    return JSON.parse(result.stdout);
  } catch (error) {
    if (expectSuccess) throw error;
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    invariant(
      stderr.includes("SHA-256 does not match run.json"),
      `tampered publication failed for an unexpected reason: ${stderr}`,
    );
    return undefined;
  }
}

function isMissingObject(error) {
  return (
    error?.name === "NotFound" ||
    error?.name === "NoSuchKey" ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function main() {
  const [postgresPort, s3Port, consolePort] = await reservePorts(3);
  const identifier = randomUUID().replaceAll("-", "");
  const composeProject = `forge-publisher-verify-${identifier}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "forge-publisher-verify-"));
  const databaseUrl = `postgresql://forge:forge-demo-only@127.0.0.1:${postgresPort}/forge`;
  const s3Endpoint = `http://127.0.0.1:${s3Port}`;
  const composeEnvironment = {
    ...process.env,
    FORGE_PUBLISH_DEMO_POSTGRES_PORT: String(postgresPort),
    FORGE_PUBLISH_DEMO_S3_PORT: String(s3Port),
    FORGE_PUBLISH_DEMO_CONSOLE_PORT: String(consolePort),
  };
  const publisherEnvironment = {
    AWS_ACCESS_KEY_ID: "forge_demo",
    AWS_SECRET_ACCESS_KEY: "forge-demo-secret",
    AWS_REGION: "us-east-1",
    FORGE_PUBLISH_S3_BUCKET: "forge-evidence",
    FORGE_PUBLISH_S3_ENDPOINT: s3Endpoint,
    FORGE_PUBLISH_S3_FORCE_PATH_STYLE: "true",
    FORGE_PUBLISH_S3_PREFIX: "verify",
    FORGE_PUBLISH_DATABASE_URL: databaseUrl,
  };
  const composeArguments = [
    "compose",
    "-p",
    composeProject,
    "-f",
    composeFile,
  ];
  let stackMayExist = false;
  let pool;
  let s3Client;

  try {
    await execFileAsync(
      process.execPath,
      [resolve(projectRoot, "scripts/build-dashboard.mjs")],
      { cwd: projectRoot, maxBuffer: 2 * 1_024 * 1_024 },
    );
    const initialDashboard = await readFile(dashboardIndexPath, "utf8");
    invariant(
      !initialDashboard.includes("Published 2026-"),
      "dashboard verifier did not start from the pinned sample build",
    );
    stackMayExist = true;
    await execFileAsync(
      "docker",
      [...composeArguments, "up", "-d", "--wait", "postgres", "minio"],
      { cwd: projectRoot, env: composeEnvironment, maxBuffer: 8 * 1_024 * 1_024 },
    );
    await execFileAsync(
      "docker",
      [...composeArguments, "run", "--rm", "create-bucket"],
      { cwd: projectRoot, env: composeEnvironment, maxBuffer: 8 * 1_024 * 1_024 },
    );

    const successful = await createRunFixture(temporaryRoot, deceptiveReportPath);
    const first = await runForgePublish(
      successful.runDirectory,
      publisherEnvironment,
      true,
      true,
    );
    invariant(first.status === "published", "first publication did not succeed");
    invariant(first.retry.begin === "created", "first publication was not new");
    invariant(
      first.retry.finalize === "published",
      "first publication did not finalize",
    );
    invariant(
      first.manifestSha256 === successful.manifestSha256,
      "published manifest digest differs from the local bundle",
    );
    invariant(
      first.dashboard?.status === "refreshed" &&
        first.dashboard?.disposition === "changed",
      "first publication did not refresh the local dashboard",
    );
    const publishedDashboard = await readFile(dashboardIndexPath, "utf8");
    invariant(
      publishedDashboard !== initialDashboard &&
        publishedDashboard.includes("Published 2026-") &&
        publishedDashboard.includes("Pinned sample") &&
        publishedDashboard.includes("Recent published runs") &&
        publishedDashboard.includes("1 published run") &&
        publishedDashboard.includes('<details class="history-run" open>') &&
        !publishedDashboard.includes("Interpretation limits"),
      "dashboard did not show the published run, history, and sample fallback",
    );
    invariant(
      !publishedDashboard.includes(successful.runId) &&
        !publishedDashboard.includes(successful.manifestSha256),
      "dashboard leaked a private publication identity",
    );
    const expectedManifestKey = `verify/runs/${successful.runId}/run.json`;
    invariant(
      first.manifestObject?.key === expectedManifestKey,
      "CLI returned an unexpected manifest object key",
    );

    const retry = await runForgePublish(
      successful.runDirectory,
      publisherEnvironment,
      true,
      true,
    );
    invariant(
      retry.retry.begin === "already_published" &&
        retry.retry.finalize === "already_published" &&
        retry.manifestObject.created === false,
      "identical retry was not idempotent",
    );
    invariant(
      retry.dashboard?.status === "refreshed" &&
        retry.dashboard?.disposition === "unchanged" &&
        (await readFile(dashboardIndexPath, "utf8")) === publishedDashboard,
      "identical retry did not converge on the same dashboard bytes",
    );

    pool = new pg.Pool({ connectionString: databaseUrl });
    const runRows = await pool.query(
      `SELECT status, manifest_sha256 AS "manifestSha256",
              manifest_object_key AS "manifestObjectKey"
       FROM forge_published_runs WHERE run_id = $1`,
      [successful.runId],
    );
    invariant(runRows.rowCount === 1, "Postgres is missing the published run");
    invariant(runRows.rows[0]?.status === "published", "run is not published");
    invariant(
      runRows.rows[0]?.manifestSha256 === successful.manifestSha256,
      "Postgres has the wrong manifest digest",
    );
    invariant(
      runRows.rows[0]?.manifestObjectKey === expectedManifestKey,
      "Postgres has the wrong manifest object key",
    );
    const artifactRows = await pool.query(
      `SELECT artifact_path AS path, sha256, size_bytes::integer AS "sizeBytes",
              object_key AS "objectKey"
       FROM forge_published_artifacts
       WHERE run_id = $1
       ORDER BY artifact_path`,
      [successful.runId],
    );
    const findingRows = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM forge_published_findings WHERE run_id = $1",
      [successful.runId],
    );
    invariant(
      artifactRows.rowCount === successful.artifacts.length,
      "Postgres artifact count differs",
    );
    const expectedArtifactsByPath = new Map(
      successful.artifacts.map((artifact) => [artifact.path, artifact]),
    );
    for (const row of artifactRows.rows) {
      const expected = expectedArtifactsByPath.get(row.path);
      invariant(expected !== undefined, "Postgres contains an unexpected artifact row");
      const expectedKey = `verify/objects/sha256/${expected.sha256.slice(0, 2)}/${expected.sha256}`;
      invariant(row.sha256 === expected.sha256, `Postgres digest differs for ${row.path}`);
      invariant(row.sizeBytes === expected.bytes.byteLength, `Postgres size differs for ${row.path}`);
      invariant(row.objectKey === expectedKey, `Postgres object key differs for ${row.path}`);
    }
    invariant(
      findingRows.rows[0]?.count === successful.findingCount,
      "Postgres finding count differs",
    );
    const dashboardRows = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM forge_dashboard_projections p
       JOIN forge_published_runs r ON r.run_id = p.run_id
       WHERE p.run_id = $1 AND r.status = 'published'`,
      [successful.runId],
    );
    invariant(
      dashboardRows.rows[0]?.count === 1,
      "Postgres is missing the sanitized published dashboard projection",
    );

    s3Client = new S3Client({
      region: "us-east-1",
      endpoint: s3Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: "forge_demo",
        secretAccessKey: "forge-demo-secret",
      },
    });
    const manifestHead = await s3Client.send(
      new HeadObjectCommand({
        Bucket: "forge-evidence",
        Key: expectedManifestKey,
        ChecksumMode: "ENABLED",
      }),
    );
    invariant(
      manifestHead.Metadata?.["forge-sha256"] === successful.manifestSha256,
      "S3 manifest metadata has the wrong digest",
    );
    invariant(
      manifestHead.ChecksumSHA256 ===
        Buffer.from(successful.manifestSha256, "hex").toString("base64"),
      "S3 manifest service checksum has the wrong digest",
    );
    const manifestGet = await s3Client.send(
      new GetObjectCommand({
        Bucket: "forge-evidence",
        Key: expectedManifestKey,
        ChecksumMode: "ENABLED",
      }),
    );
    invariant(
      (await objectBytes(manifestGet, "manifest")).equals(successful.manifestBytes),
      "S3 manifest bytes differ from the exact local run.json",
    );

    for (const artifact of successful.artifacts) {
      const key = `verify/objects/sha256/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`;
      const head = await s3Client.send(
        new HeadObjectCommand({
          Bucket: "forge-evidence",
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      invariant(
        head.ContentLength === artifact.bytes.byteLength,
        `S3 artifact length differs for ${artifact.path}`,
      );
      invariant(
        head.ChecksumSHA256 ===
          Buffer.from(artifact.sha256, "hex").toString("base64"),
        `S3 artifact service checksum differs for ${artifact.path}`,
      );
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: "forge-evidence",
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      invariant(
        sha256(await objectBytes(object, artifact.path)) === artifact.sha256,
        `S3 artifact bytes differ for ${artifact.path}`,
      );
    }

    const tampered = await createRunFixture(
      temporaryRoot,
      officialReportPath,
      true,
    );
    await runForgePublish(tampered.runDirectory, publisherEnvironment, false);
    const tamperedRows = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM forge_published_runs WHERE run_id = $1",
      [tampered.runId],
    );
    invariant(
      tamperedRows.rows[0]?.count === 0,
      "tampered run created Postgres publication metadata",
    );
    invariant(
      (await readFile(dashboardIndexPath, "utf8")) === publishedDashboard,
      "tampered publication changed the dashboard",
    );
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: "forge-evidence",
          Key: `verify/runs/${tampered.runId}/run.json`,
        }),
      );
      throw new Error("tampered run created a remote manifest");
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: "verified",
          runId: successful.runId,
          artifactCount: successful.artifacts.length,
          findingCount: successful.findingCount,
          retry: "idempotent",
          dashboardRefresh: "publish-driven-and-idempotent",
          tamperRejection: "verified-before-publication",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    s3Client?.destroy();
    await pool?.end().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
    if (stackMayExist) {
      await execFileAsync(
        "docker",
        [...composeArguments, "down", "--volumes", "--remove-orphans"],
        {
          cwd: projectRoot,
          env: composeEnvironment,
          maxBuffer: 8 * 1_024 * 1_024,
        },
      );
    }
    await execFileAsync(
      process.execPath,
      [resolve(projectRoot, "scripts/build-dashboard.mjs")],
      { cwd: projectRoot, maxBuffer: 2 * 1_024 * 1_024 },
    ).catch(() => undefined);
  }
}

await main();
