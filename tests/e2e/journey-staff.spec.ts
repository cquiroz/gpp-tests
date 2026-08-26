import { defineJourney, standardIdentity } from "../support/journey.js";

/**
 * The same four scenarios as the guest journey, driven by the fabricated staff user — the
 * first role-diverse coverage (spec §12's "role-diverse scenarios"). Skips, naming the fix,
 * when the fabrication script has not been run against this stack.
 */
defineJourney(standardIdentity("TEST_STAFF", "staff", /test\s+staff/i));
