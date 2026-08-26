import { defineJourney, guestIdentity } from "../support/journey.js";

/**
 * The canonical v1 regression journey, as a guest (spec §5). The scenario titles here are
 * ledger rows with history — they must not change. The journey body lives in
 * tests/support/journey.ts, shared with the standard-user variants (journey-pi, journey-staff).
 */
defineJourney(guestIdentity());
