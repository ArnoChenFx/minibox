import type { Quotas } from "./model";

/**
 * The scope of a box's own agent (the `self` token). No token grant maps to it, so `requiredScopes` leaves it to the
 * `box-self` principal alone, and the owner is refused the self operations.
 *
 * Kept apart from `model.ts`, which imports the host registry: the registry must reach the self store without a cycle.
 */
export const SELF_SCOPE = "self";

/** A box's self token: twenty checkpoints it may take itself, and sixty requests a minute. */
export const SELF_QUOTA: Quotas = {
  maxBoxes: null,
  maxCpus: null,
  maxMemoryMb: null,
  maxTtlSec: null,
  rateLimit: 60,
  rateWindowSec: 60,
  maxCheckpoints: 20,
};
