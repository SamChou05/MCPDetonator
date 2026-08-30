#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const TEMPLATE_PATH = resolve(REPOSITORY_ROOT, "infra/aws/dashboard.yaml");
const SITE_DIRECTORY = resolve(REPOSITORY_ROOT, "dist/dashboard-site");
const BUILD_MANIFEST_PATH = resolve(REPOSITORY_ROOT, "dist/dashboard-site.manifest.json");
const EXPECTED_TEMPLATE_SHA256 =
  "7a7f08079903ad8b16ab1fd378232248bdc6d044883445cd7a7e692f3e874731";
const EXPECTED_SITE_FILES = ["index.html", "styles.css"];
const EXPECTED_OUTPUT_KEYS = [
  "DistributionDomainName",
  "DistributionId",
  "OriginAccessControlId",
  "SecurityHeadersPolicyId",
  "SiteBucketName",
  "SiteUrl",
];
const STACK_TAGS = new Map([
  ["Application", "forge-dashboard-demo"],
  ["DataClassification", "synthetic-presentation-only"],
]);
const MAX_TEMPLATE_BYTES = 51_200;
const MAX_BUILD_MANIFEST_BYTES = 4 * 1024;
const MAX_SITE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const CACHE_CONTROL = "public,max-age=300,must-revalidate";

function usage() {
  return `Usage:
  node scripts/deploy-dashboard.mjs \\
    --account <12-digit-account-id> \\
    --stack <name> \\
    --region <commercial-aws-region> \\
    [--stack-id <exact-existing-stack-arn>] \\
    --yes

Creates a new stack only when the name is absent. Updating an existing stack
also requires its exact --stack-id. The deployment publishes immutable
snapshots of exactly dist/dashboard-site/index.html and styles.css. The --yes
flag and expected AWS account are mandatory. AWS authentication stays within
the AWS CLI credential chain.`;
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { help: true };
  }

  const parsed = {
    account: undefined,
    help: false,
    region: undefined,
    stack: undefined,
    stackId: undefined,
    yes: false,
  };
  const valueArguments = new Map([
    ["--account", "account"],
    ["--region", "region"],
    ["--stack", "stack"],
    ["--stack-id", "stackId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes") {
      if (parsed.yes) fail("--yes may be supplied only once");
      parsed.yes = true;
      continue;
    }
    const key = valueArguments.get(argument);
    if (!key) fail(`unknown argument: ${argument}`);
    if (parsed[key] !== undefined) fail(`${argument} may be supplied only once`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    parsed[key] = value;
    index += 1;
  }

  if (!parsed.yes) fail("refusing to deploy without the explicit --yes flag");
  if (!parsed.account) fail("--account is required");
  if (!parsed.stack) fail("--stack is required");
  if (!parsed.region) fail("--region is required");
  if (!/^\d{12}$/.test(parsed.account)) {
    fail("--account must be the exact 12-digit AWS account ID");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(parsed.stack)) {
    fail("--stack must start with a letter and contain at most 128 letters, digits, or hyphens");
  }
  if (
    parsed.region.length > 32 ||
    !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?!gov-|iso-|isob-)[a-z0-9]+(?:-[a-z0-9]+)?-[1-9][0-9]*$/.test(
      parsed.region,
    )
  ) {
    fail("--region must be a commercial AWS Region identifier (for example, us-east-1)");
  }
  if (
    parsed.stackId !== undefined &&
    !/^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[0-9a-f-]{36}$/.test(
      parsed.stackId,
    )
  ) {
    fail("--stack-id must be an exact commercial-partition CloudFormation stack ARN");
  }
  return parsed;
}

function sha256(bytes) {
  return {
    base64: createHash("sha256").update(bytes).digest("base64"),
    hex: createHash("sha256").update(bytes).digest("hex"),
  };
}

function parseBuildManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("dashboard build manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("dashboard build manifest must be an object");
  }
  if (
    JSON.stringify(Object.keys(manifest)) !== JSON.stringify(["schemaVersion", "files"]) ||
    manifest.schemaVersion !== "forge.dashboard-build/v1" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== EXPECTED_SITE_FILES.length
  ) {
    fail("dashboard build manifest has an unexpected schema or shape");
  }
  for (let index = 0; index < EXPECTED_SITE_FILES.length; index += 1) {
    const file = manifest.files[index];
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      JSON.stringify(Object.keys(file)) !== JSON.stringify(["path", "sha256", "bytes"]) ||
      file.path !== EXPECTED_SITE_FILES[index] ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > MAX_SITE_FILE_BYTES
    ) {
      fail("dashboard build manifest contains an invalid file receipt");
    }
  }
  const canonicalBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (!canonicalBytes.equals(bytes)) {
    fail("dashboard build manifest is not the canonical builder receipt");
  }
  return manifest;
}

async function readStableRegularFile(path, label, maximumBytes) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    fail("this platform does not support no-follow file opens");
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(`${label} is unavailable for a no-follow read: ${error.message}`);
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(`${label} must be a regular file`);
    if (before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail(`${label} must contain between 1 and ${maximumBytes} bytes`);
    }

    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
      if (before[field] !== after[field]) fail(`${label} changed while it was being read`);
    }
    if (bytes.length !== Number(before.size)) fail(`${label} produced an incomplete read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function cleanupSnapshot(directory) {
  const expectedPrefix = join(tmpdir(), "forge-dashboard-deploy-");
  if (!directory.startsWith(expectedPrefix) || directory.length <= expectedPrefix.length) {
    fail("refusing to clean an unrecognized snapshot directory");
  }
  await rm(directory, { force: true, recursive: true });
}

async function snapshotLocalInputs() {
  const siteMetadata = await lstat(SITE_DIRECTORY).catch((error) => {
    fail(`validated dashboard directory is unavailable: ${error.message}`);
  });
  if (!siteMetadata.isDirectory() || siteMetadata.isSymbolicLink()) {
    fail("dist/dashboard-site must be a real directory, not a symbolic link");
  }

  const entries = await readdir(SITE_DIRECTORY, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_SITE_FILES)) {
    fail(`dist/dashboard-site must contain exactly: ${EXPECTED_SITE_FILES.join(", ")}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`dashboard entry must be a regular file: ${entry.name}`);
    }
  }

  const templateBytes = await readStableRegularFile(
    TEMPLATE_PATH,
    "CloudFormation template",
    MAX_TEMPLATE_BYTES,
  );
  const templateDigest = sha256(templateBytes);
  if (templateDigest.hex !== EXPECTED_TEMPLATE_SHA256) {
    fail("CloudFormation template hash does not match the reviewed deployment script");
  }

  const manifestBytes = await readStableRegularFile(
    BUILD_MANIFEST_PATH,
    "dashboard build manifest",
    MAX_BUILD_MANIFEST_BYTES,
  );
  const manifest = parseBuildManifest(manifestBytes);

  const sourceFiles = new Map();
  for (const receipt of manifest.files) {
    const bytes = await readStableRegularFile(
      resolve(SITE_DIRECTORY, receipt.path),
      `dashboard file ${receipt.path}`,
      MAX_SITE_FILE_BYTES,
    );
    if (bytes.length !== receipt.bytes || sha256(bytes).hex !== receipt.sha256) {
      fail(`dashboard file ${receipt.path} does not match the trusted build receipt`);
    }
    sourceFiles.set(receipt.path, bytes);
  }

  const directory = await mkdtemp(join(tmpdir(), "forge-dashboard-deploy-"));
  try {
    const snapshotTemplatePath = join(directory, "dashboard.yaml");
    await writeFile(snapshotTemplatePath, templateBytes, { flag: "wx", mode: 0o400 });
    const files = [
      { contentType: "text/css; charset=utf-8", key: "styles.css" },
      { contentType: "text/html; charset=utf-8", key: "index.html" },
    ].map((specification) => {
      const bytes = sourceFiles.get(specification.key);
      return {
        ...specification,
        bytes,
        digest: sha256(bytes),
        snapshotPath: join(directory, specification.key),
      };
    });
    for (const file of files) {
      await writeFile(file.snapshotPath, file.bytes, { flag: "wx", mode: 0o400 });
    }
    return {
      directory,
      files,
      manifestDigest: sha256(manifestBytes),
      templateDigest,
      templatePath: snapshotTemplatePath,
    };
  } catch (error) {
    await cleanupSnapshot(directory);
    throw error;
  }
}

function spawnAws(arguments_, { capture = false } = {}) {
  const args = [...arguments_, "--no-cli-auto-prompt", "--no-cli-pager"];
  return spawnSync("aws", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: false,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function requireSuccessfulAws(result) {
  if (result.error) fail(`could not run the AWS CLI: ${result.error.message}`);
  if (result.signal) fail(`AWS CLI was terminated by signal ${result.signal}`);
  if (result.status !== 0) fail(`AWS CLI command failed with exit code ${result.status}`);
}

function parseAwsJson(result, label) {
  requireSuccessfulAws(result);
  const raw = result.stdout;
  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`AWS CLI returned an empty ${label} response`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`AWS CLI returned non-JSON or ambiguous ${label} output`);
  }
}

function runAws(arguments_) {
  const result = spawnAws(arguments_);
  requireSuccessfulAws(result);
}

function runAwsJson(arguments_, label) {
  return parseAwsJson(spawnAws([...arguments_, "--output", "json"], { capture: true }), label);
}

function assertString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`AWS returned an invalid ${label}`);
  return value;
}

function validateCallerIdentity(response, options) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail("STS returned a malformed caller identity");
  }
  const keys = Object.keys(response).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["Account", "Arn", "UserId"])) {
    fail("STS returned an unexpected or ambiguous caller identity shape");
  }
  if (response.Account !== options.account) {
    fail(`AWS CLI is authenticated to account ${response.Account ?? "unknown"}, not --account`);
  }
  if (response.Arn === `arn:aws:iam::${options.account}:root`) {
    fail("refusing to deploy as the AWS account root user; use a federated or assumed-role session");
  }
  const arnMatch = /^arn:(aws):(iam|sts)::(\d{12}):/.exec(response.Arn);
  if (!arnMatch || arnMatch[3] !== options.account) {
    fail("AWS CLI caller is not in the expected commercial AWS account/partition");
  }
  assertString(response.UserId, "STS user ID", /^[^\s\u0000-\u001f]{1,256}$/);
}

function validateStackArn(stackId, options) {
  const prefix = `arn:aws:cloudformation:${options.region}:${options.account}:stack/${options.stack}/`;
  if (!stackId.startsWith(prefix) || !/^[0-9a-f-]{36}$/.test(stackId.slice(prefix.length))) {
    fail("CloudFormation returned a stack ID outside the requested account, Region, or name");
  }
  return stackId;
}

function validateStackTags(stack) {
  if (!Array.isArray(stack.Tags)) fail("CloudFormation stack tags are missing");
  const actual = new Map();
  for (const tag of stack.Tags) {
    if (
      !tag ||
      typeof tag.Key !== "string" ||
      typeof tag.Value !== "string" ||
      actual.has(tag.Key)
    ) {
      fail("CloudFormation returned malformed or duplicate stack tags");
    }
    actual.set(tag.Key, tag.Value);
  }
  for (const [key, value] of STACK_TAGS) {
    if (actual.get(key) !== value) fail("existing stack does not carry the exact Forge ownership tags");
  }
}

function readStackRecord(response, options) {
  if (!response || !Array.isArray(response.Stacks) || response.Stacks.length !== 1) {
    fail("CloudFormation describe-stacks did not return exactly one stack");
  }
  const stack = response.Stacks[0];
  if (stack.StackName !== options.stack) {
    fail("CloudFormation returned a different stack than requested");
  }
  if (!new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]).has(stack.StackStatus)) {
    fail(`CloudFormation stack is not deploy-complete: ${stack.StackStatus ?? "missing status"}`);
  }
  const stackId = validateStackArn(stack.StackId, options);
  validateStackTags(stack);

  if (!Array.isArray(stack.Outputs) || stack.Outputs.length !== EXPECTED_OUTPUT_KEYS.length) {
    fail("CloudFormation returned a missing, extra, or ambiguous output set");
  }
  const outputs = new Map();
  for (const output of stack.Outputs) {
    if (
      !output ||
      typeof output.OutputKey !== "string" ||
      typeof output.OutputValue !== "string" ||
      outputs.has(output.OutputKey)
    ) {
      fail("CloudFormation returned a malformed or duplicate output");
    }
    outputs.set(output.OutputKey, output.OutputValue);
  }
  const actualKeys = [...outputs.keys()].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(EXPECTED_OUTPUT_KEYS)) {
    fail("CloudFormation output names do not match the reviewed template");
  }

  const bucket = assertString(
    outputs.get("SiteBucketName"),
    "S3 bucket name",
    /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  );
  const distributionId = assertString(
    outputs.get("DistributionId"),
    "CloudFront distribution ID",
    /^[A-Z0-9]{8,32}$/,
  );
  const domain = assertString(
    outputs.get("DistributionDomainName"),
    "CloudFront domain name",
    /^[a-z0-9-]+\.cloudfront\.net$/,
  );
  const siteUrl = outputs.get("SiteUrl");
  if (siteUrl !== `https://${domain}`) {
    fail("CloudFormation site URL does not exactly match its CloudFront domain");
  }
  assertString(outputs.get("OriginAccessControlId"), "origin access control ID", /^[A-Z0-9]{8,32}$/);
  assertString(
    outputs.get("SecurityHeadersPolicyId"),
    "response headers policy ID",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  return { bucket, distributionId, domain, outputs, siteUrl, stackId };
}

function isMissingStackResponse(result, stackName) {
  if (result.error || result.signal || result.status === 0 || typeof result.stderr !== "string") {
    return false;
  }
  const expectedSuffix = `Stack with id ${stackName} does not exist`;
  const message = result.stderr.trim();
  return message.includes("(ValidationError)") && message.endsWith(expectedSuffix);
}

function preflightStack(options) {
  const result = spawnAws(
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      options.stack,
      "--region",
      options.region,
      "--output",
      "json",
    ],
    { capture: true },
  );

  if (isMissingStackResponse(result, options.stack)) {
    if (options.stackId) fail("--stack-id was supplied but the named stack does not exist");
    return { exists: false };
  }
  const existing = readStackRecord(parseAwsJson(result, "existing stack"), options);
  if (!options.stackId) {
    fail(`stack already exists; review it and rerun with --stack-id ${existing.stackId}`);
  }
  if (options.stackId !== existing.stackId) fail("--stack-id does not match the existing stack");
  return { exists: true, stack: existing };
}

function readObjectInventory(response, bucket) {
  if (!response || response.Name !== bucket || response.IsTruncated !== false) {
    fail("S3 returned an incomplete or mismatched object inventory");
  }
  const contents = response.Contents ?? [];
  if (!Array.isArray(contents) || response.KeyCount !== contents.length) {
    fail("S3 returned an ambiguous object count");
  }
  const objects = new Map();
  for (const object of contents) {
    if (
      !object ||
      typeof object.Key !== "string" ||
      typeof object.Size !== "number" ||
      !Number.isSafeInteger(object.Size) ||
      object.Size < 0 ||
      objects.has(object.Key)
    ) {
      fail("S3 returned a malformed or duplicate object inventory entry");
    }
    objects.set(object.Key, object.Size);
  }
  return objects;
}

function listObjects(bucket, region) {
  return readObjectInventory(
    runAwsJson(
      [
        "s3api",
        "list-objects-v2",
        "--bucket",
        bucket,
        "--max-keys",
        "3",
        "--region",
        region,
      ],
      "S3 object inventory",
    ),
    bucket,
  );
}

function requireAllowedInventory(objects, { exact }) {
  const actualKeys = [...objects.keys()].sort();
  const unexpected = actualKeys.filter((key) => !EXPECTED_SITE_FILES.includes(key));
  if (unexpected.length > 0) fail("private site bucket contains an unexpected object; refusing mutation");
  if (exact && JSON.stringify(actualKeys) !== JSON.stringify(EXPECTED_SITE_FILES)) {
    fail("private site bucket does not contain exactly the two reviewed keys");
  }
}

function verifyObjectMetadata(response, file) {
  if (
    response.ContentLength !== file.bytes.length ||
    response.ContentType !== file.contentType ||
    response.CacheControl !== CACHE_CONTROL ||
    response.ServerSideEncryption !== "AES256" ||
    response.ChecksumSHA256 !== file.digest.base64
  ) {
    fail(`S3 metadata/checksum verification failed for ${file.key}`);
  }
}

async function publishAndVerifySite(snapshot, deployed, region) {
  const versioning = runAwsJson(
    [
      "s3api",
      "get-bucket-versioning",
      "--bucket",
      deployed.bucket,
      "--region",
      region,
      "--query",
      "{Status: Status, MFADelete: MFADelete}",
    ],
    "S3 bucket versioning",
  );
  if (
    !versioning ||
    typeof versioning !== "object" ||
    Array.isArray(versioning) ||
    JSON.stringify(Object.keys(versioning).sort()) !== JSON.stringify(["MFADelete", "Status"]) ||
    versioning.Status !== null ||
    versioning.MFADelete !== null
  ) {
    fail("private site bucket versioning changed from the reviewed unversioned configuration");
  }
  requireAllowedInventory(listObjects(deployed.bucket, region), { exact: false });

  for (const file of snapshot.files) {
    const putResponse = runAwsJson(
      [
        "s3api",
        "put-object",
        "--bucket",
        deployed.bucket,
        "--key",
        file.key,
        "--body",
        file.snapshotPath,
        "--content-type",
        file.contentType,
        "--cache-control",
        CACHE_CONTROL,
        "--server-side-encryption",
        "AES256",
        "--checksum-algorithm",
        "SHA256",
        "--checksum-sha256",
        file.digest.base64,
        "--region",
        region,
      ],
      `S3 put ${file.key}`,
    );
    if (
      putResponse?.ChecksumSHA256 !== file.digest.base64 ||
      putResponse?.ServerSideEncryption !== "AES256"
    ) {
      fail(`S3 returned an ambiguous put result for ${file.key}`);
    }
  }

  const finalObjects = listObjects(deployed.bucket, region);
  requireAllowedInventory(finalObjects, { exact: true });
  for (const file of snapshot.files) {
    if (finalObjects.get(file.key) !== file.bytes.length) {
      fail(`S3 returned the wrong object length for ${file.key}`);
    }
    const headResponse = runAwsJson(
      [
        "s3api",
        "head-object",
        "--bucket",
        deployed.bucket,
        "--key",
        file.key,
        "--checksum-mode",
        "ENABLED",
        "--region",
        region,
      ],
      `S3 head ${file.key}`,
    );
    verifyObjectMetadata(headResponse, file);

    const downloadedPath = join(snapshot.directory, `remote-${file.key}`);
    const getResponse = runAwsJson(
      [
        "s3api",
        "get-object",
        "--bucket",
        deployed.bucket,
        "--key",
        file.key,
        "--checksum-mode",
        "ENABLED",
        "--region",
        region,
        downloadedPath,
      ],
      `S3 get ${file.key}`,
    );
    verifyObjectMetadata(getResponse, file);
    const downloadedBytes = await readStableRegularFile(
      downloadedPath,
      `downloaded dashboard file ${file.key}`,
      MAX_SITE_FILE_BYTES,
    );
    if (sha256(downloadedBytes).hex !== file.digest.hex) {
      fail(`downloaded S3 bytes do not match the snapshot for ${file.key}`);
    }
  }
}

function readInvalidation(response) {
  const invalidation = response?.Invalidation;
  const id = assertString(invalidation?.Id, "CloudFront invalidation ID", /^[A-Z0-9]{8,32}$/);
  if (!new Set(["InProgress", "Completed"]).has(invalidation.Status)) {
    fail("CloudFront returned an invalid invalidation status");
  }
  const paths = invalidation.InvalidationBatch?.Paths;
  if (paths?.Quantity !== 1 || !Array.isArray(paths.Items) || paths.Items.length !== 1) {
    fail("CloudFront returned an ambiguous invalidation path set");
  }
  if (paths.Items[0] !== "/*") fail("CloudFront invalidation targeted an unexpected path");
  return { id, status: invalidation.Status };
}

function checkAwsCliV2() {
  const result = spawnSync("aws", ["--version"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const versionText = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
  if (result.error || result.status !== 0 || !/(?:^|\s)aws-cli\/2\./.test(versionText)) {
    fail("AWS CLI v2 must be installed and available as `aws`");
  }
}

async function deploy(snapshot, options) {
  checkAwsCliV2();
  validateCallerIdentity(
    runAwsJson(["sts", "get-caller-identity", "--region", options.region], "STS caller identity"),
    options,
  );
  const before = preflightStack(options);

  let targetStackId;
  if (before.exists) {
    targetStackId = before.stack.stackId;
    runAws([
      "cloudformation",
      "deploy",
      "--template-file",
      snapshot.templatePath,
      "--stack-name",
      targetStackId,
      "--region",
      options.region,
      "--no-fail-on-empty-changeset",
      "--tags",
      "Application=forge-dashboard-demo",
      "DataClassification=synthetic-presentation-only",
    ]);
  } else {
    const creation = runAwsJson(
      [
        "cloudformation",
        "create-stack",
        "--stack-name",
        options.stack,
        "--template-body",
        `file://${snapshot.templatePath}`,
        "--region",
        options.region,
        "--tags",
        "Key=Application,Value=forge-dashboard-demo",
        "Key=DataClassification,Value=synthetic-presentation-only",
      ],
      "created stack",
    );
    if (
      !creation ||
      typeof creation !== "object" ||
      Array.isArray(creation) ||
      JSON.stringify(Object.keys(creation)) !== JSON.stringify(["StackId"])
    ) {
      fail("CloudFormation returned an ambiguous create-stack response");
    }
    targetStackId = validateStackArn(creation.StackId, options);
    runAws([
      "cloudformation",
      "wait",
      "stack-create-complete",
      "--stack-name",
      targetStackId,
      "--region",
      options.region,
    ]);
  }

  const after = readStackRecord(
    runAwsJson(
      [
        "cloudformation",
        "describe-stacks",
        "--stack-name",
        targetStackId,
        "--region",
        options.region,
      ],
      "deployed stack",
    ),
    options,
  );
  if (after.stackId !== targetStackId) {
    fail("the deployed stack identity changed after the atomic target selection");
  }

  await publishAndVerifySite(snapshot, after, options.region);
  const invalidation = readInvalidation(
    runAwsJson(
      [
        "cloudfront",
        "create-invalidation",
        "--distribution-id",
        after.distributionId,
        "--paths",
        "/*",
        "--region",
        options.region,
      ],
      "CloudFront invalidation",
    ),
  );
  runAws([
    "cloudfront",
    "wait",
    "invalidation-completed",
    "--distribution-id",
    after.distributionId,
    "--id",
    invalidation.id,
    "--region",
    options.region,
  ]);
  const finalInvalidation = readInvalidation(
    runAwsJson(
      [
        "cloudfront",
        "get-invalidation",
        "--distribution-id",
        after.distributionId,
        "--id",
        invalidation.id,
        "--region",
        options.region,
      ],
      "completed CloudFront invalidation",
    ),
  );
  if (finalInvalidation.id !== invalidation.id || finalInvalidation.status !== "Completed") {
    fail("CloudFront invalidation did not complete unambiguously");
  }
  return { deployed: after, invalidation: finalInvalidation };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const snapshot = await snapshotLocalInputs();
  let result;
  try {
    result = await deploy(snapshot, options);
  } finally {
    await cleanupSnapshot(snapshot.directory);
  }

  const deployed = result.deployed;
  process.stdout.write(`\nForge dashboard deployment complete\n`);
  process.stdout.write(`AWS account: ${options.account}\n`);
  process.stdout.write(`Stack ID: ${deployed.stackId}\n`);
  process.stdout.write(`Site URL: ${deployed.siteUrl}\n`);
  process.stdout.write(`CloudFront domain: ${deployed.domain}\n`);
  process.stdout.write(`CloudFront distribution ID: ${deployed.distributionId}\n`);
  process.stdout.write(`Private S3 origin bucket: ${deployed.bucket}\n`);
  process.stdout.write(`Origin access control ID: ${deployed.outputs.get("OriginAccessControlId")}\n`);
  process.stdout.write(
    `Security headers policy ID: ${deployed.outputs.get("SecurityHeadersPolicyId")}\n`,
  );
  for (const file of snapshot.files) {
    process.stdout.write(`${file.key} SHA-256: ${file.digest.hex}\n`);
  }
  process.stdout.write(`Template SHA-256: ${snapshot.templateDigest.hex}\n`);
  process.stdout.write(`Build manifest SHA-256: ${snapshot.manifestDigest.hex}\n`);
  process.stdout.write(`Completed invalidation ID: ${result.invalidation.id}\n`);
}

main().catch((error) => {
  process.stderr.write(`Dashboard deployment failed: ${error.message}\n`);
  process.exitCode = 1;
});
