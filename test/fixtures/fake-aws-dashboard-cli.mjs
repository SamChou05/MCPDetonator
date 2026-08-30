#!/usr/bin/env node

import {
  appendFileSync,
  copyFileSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const stateDirectory = process.env.FAKE_AWS_STATE_DIRECTORY;
if (!stateDirectory) {
  process.stderr.write("FAKE_AWS_STATE_DIRECTORY is required\n");
  process.exit(90);
}

appendFileSync(join(stateDirectory, "commands.jsonl"), `${JSON.stringify(args)}\n`);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("aws-cli/2.17.0 Python/3.12 fake\n");
  process.exit(0);
}

const statePath = join(stateDirectory, "state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));

function saveState() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function value(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || args[index + 1] === undefined) {
    process.stderr.write(`missing fake AWS argument ${flag}\n`);
    process.exit(91);
  }
  return args[index + 1];
}

function emit(document) {
  process.stdout.write(`${JSON.stringify(document)}\n`);
  process.exit(0);
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function metadata(key) {
  const object = state.objects[key];
  if (!object) fail(92, `unknown fake S3 key ${key}`);
  return {
    CacheControl: object.cacheControl,
    ChecksumSHA256: object.checksumSha256,
    ContentLength: statSync(object.path).size,
    ContentType: object.contentType,
    ETag: object.etag,
    ServerSideEncryption: "AES256",
  };
}

const [service, operation] = args;

if (service === "sts" && operation === "get-caller-identity") {
  emit({
    Account: state.account,
    Arn: `arn:aws:sts::${state.account}:assumed-role/ForgeDemo/deployer`,
    UserId: "AROATEST:deployer",
  });
}

if (service === "cloudformation" && operation === "describe-stacks") {
  emit({
    Stacks: [
      {
        Outputs: [
          { OutputKey: "SiteUrl", OutputValue: `https://${state.domain}` },
          { OutputKey: "SiteBucketName", OutputValue: state.bucket },
          { OutputKey: "DistributionId", OutputValue: state.distributionId },
          {
            OutputKey: "DistributionDomainName",
            OutputValue: state.domain,
          },
          {
            OutputKey: "OriginAccessControlId",
            OutputValue: "E123456789ABCD",
          },
          {
            OutputKey: "SecurityHeadersPolicyId",
            OutputValue: "12345678-1234-1234-1234-123456789abc",
          },
        ],
        StackId: state.stackId,
        StackName: state.stackName,
        StackStatus: "UPDATE_COMPLETE",
        Tags: [
          { Key: "Application", Value: "forge-dashboard-demo" },
          {
            Key: "DataClassification",
            Value: "synthetic-presentation-only",
          },
        ],
      },
    ],
  });
}

if (service === "cloudformation") {
  fail(93, `unexpected CloudFormation mutation: ${operation}`);
}

if (service === "s3api" && operation === "get-bucket-versioning") {
  emit({ MFADelete: null, Status: null });
}

if (service === "s3api" && operation === "list-objects-v2") {
  const contents = Object.entries(state.objects)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([Key, object]) => ({ Key, Size: statSync(object.path).size }));
  emit({
    Contents: contents,
    IsTruncated: false,
    KeyCount: contents.length,
    Name: state.bucket,
  });
}

if (service === "s3api" && operation === "head-object") {
  emit(metadata(value("--key")));
}

if (service === "s3api" && operation === "put-object") {
  state.putCount = (state.putCount ?? 0) + 1;
  saveState();
  if (state.mode === "etag-conflict" && state.putCount === 1) {
    fail(94, "synthetic S3 precondition failure");
  }
  const key = value("--key");
  const object = state.objects[key];
  if (!object) fail(92, `unknown fake S3 key ${key}`);
  if (!args.includes("--if-match")) {
    fail(95, "content-only upload omitted --if-match");
  }
  copyFileSync(value("--body"), object.path);
  object.cacheControl = value("--cache-control");
  object.checksumSha256 = value("--checksum-sha256");
  object.contentType = value("--content-type");
  object.etag = `"${String(state.putCount).padStart(32, "c")}"`;
  saveState();
  emit({
    ChecksumSHA256: object.checksumSha256,
    ServerSideEncryption: "AES256",
  });
}

if (service === "s3api" && operation === "get-object") {
  const key = value("--key");
  const regionIndex = args.indexOf("--region");
  const destination = args[regionIndex + 2];
  if (!destination || destination.startsWith("--")) {
    fail(96, "fake get-object destination is missing");
  }
  copyFileSync(state.objects[key].path, destination);
  emit(metadata(key));
}

function invalidation(status) {
  return {
    Invalidation: {
      Id: "I123456789ABCD",
      InvalidationBatch: { Paths: { Items: ["/*"], Quantity: 1 } },
      Status: status,
    },
  };
}

if (service === "cloudfront" && operation === "create-invalidation") {
  emit(invalidation("InProgress"));
}

if (service === "cloudfront" && operation === "wait") {
  if (state.mode === "invalidation-wait-failure") {
    fail(97, "synthetic invalidation wait failure");
  }
  process.exit(0);
}

if (service === "cloudfront" && operation === "get-invalidation") {
  emit(invalidation("Completed"));
}

fail(98, `unexpected fake AWS command: ${service ?? ""} ${operation ?? ""}`);
