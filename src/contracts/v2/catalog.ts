import { z } from "zod";

import { nonnegativeSafeIntegerV2Schema, sha256V2Schema } from "./common.js";

export const catalogIdentityV2Schema = z
  .object({
    canonicalization: z.literal("rfc8785-jcs"),
    rawProjection: z.literal("forge.mcp-raw-discovery/v2"),
    planProjection: z.literal("forge.mcp-plan-catalog/v2"),
    rawDiscoveryDigest: sha256V2Schema,
    planCatalogDigest: sha256V2Schema,
    toolCount: nonnegativeSafeIntegerV2Schema.max(10_000),
  })
  .strict();

export type CatalogIdentityV2 = z.infer<typeof catalogIdentityV2Schema>;
