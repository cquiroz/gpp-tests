import { defineJourney, standardIdentity } from "../support/journey.js";

/**
 * The same four scenarios as the guest journey, driven by the fabricated standard PI
 * (stack/scripts/create-standard-users.sh; research/orcid-auth-testing-strategy.md tier 3).
 * Skips, naming the fix, when the fabrication script has not been run against this stack.
 */
defineJourney(standardIdentity("TEST_PI", "pi", /test\s+pi/i));
