// GraphQL documents for Explore's preferences service (Hasura over the `prefs` database),
// kept out of the specs for the same reason lib/odb-operations.js holds the ODB's: one place
// to read what the suite sends. Field names follow Hasura's graphql-default convention as
// production's v2.12 produces it (stack/docker-compose.yml, the hasura service).

/**
 * A user's global preferences row; null when the user has never stored one.
 * @param {{ userId: string }} args
 */
export function globalPreferences({ userId }) {
  return {
    operationName: "GlobalPreferences",
    query: `query GlobalPreferences($id: String!) {
  lucumaUserPreferencesByPk(userId: $id) { exploreGuideButton wavelengthUnits }
}`,
    variables: { id: userId },
  };
}
