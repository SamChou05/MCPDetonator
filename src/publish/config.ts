export interface PublishConfiguration {
  databaseUrl: string;
  s3Bucket: string;
  s3Region: string;
  s3Prefix: string;
  s3ForcePathStyle: boolean;
  s3Endpoint?: string;
}

export class PublishConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublishConfigurationError";
  }
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new PublishConfigurationError(
      `${name} is required for publication (publish-run or analyze --publish)`,
    );
  }

  return value;
}

function optionalEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === "") {
    throw new PublishConfigurationError(`${name} must not be blank when set`);
  }

  return value;
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false" || value === "0") {
    return false;
  }
  if (value === "true" || value === "1") {
    return true;
  }

  throw new PublishConfigurationError(
    `${name} must be one of true, false, 1, or 0`,
  );
}

function validateDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublishConfigurationError(
      "FORGE_PUBLISH_DATABASE_URL must be a valid PostgreSQL URL",
    );
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new PublishConfigurationError(
      "FORGE_PUBLISH_DATABASE_URL must use the postgres or postgresql scheme",
    );
  }

  return value;
}

function validateEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublishConfigurationError(
      "FORGE_PUBLISH_S3_ENDPOINT must be a valid HTTP(S) URL",
    );
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new PublishConfigurationError(
      "FORGE_PUBLISH_S3_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }

  return parsed.toString().replace(/\/$/u, "");
}

export function loadPublishConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PublishConfiguration {
  const databaseUrl = validateDatabaseUrl(
    requiredEnvironmentValue(environment, "FORGE_PUBLISH_DATABASE_URL"),
  );
  const s3Bucket = requiredEnvironmentValue(
    environment,
    "FORGE_PUBLISH_S3_BUCKET",
  );
  const s3Region =
    optionalEnvironmentValue(environment, "FORGE_PUBLISH_S3_REGION") ??
    optionalEnvironmentValue(environment, "AWS_REGION") ??
    optionalEnvironmentValue(environment, "AWS_DEFAULT_REGION") ??
    "us-east-1";
  const s3Prefix = environment["FORGE_PUBLISH_S3_PREFIX"] ?? "forge";
  const endpoint = optionalEnvironmentValue(
    environment,
    "FORGE_PUBLISH_S3_ENDPOINT",
  );

  return {
    databaseUrl,
    s3Bucket,
    s3Region,
    s3Prefix,
    s3ForcePathStyle: parseBoolean(
      environment["FORGE_PUBLISH_S3_FORCE_PATH_STYLE"],
      "FORGE_PUBLISH_S3_FORCE_PATH_STYLE",
    ),
    ...(endpoint === undefined ? {} : { s3Endpoint: validateEndpoint(endpoint) }),
  };
}
