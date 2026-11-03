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

/**
 * The stored grid layout rows for one tile, every section and breakpoint Explore wrote.
 * Filtered on the tile name (a plain string) rather than the section enum, whose casing
 * differs between Explore's codecs and what the server exposes.
 * @param {{ userId: string, tile: string }} args
 */
export function gridLayoutPositions({ userId, tile }) {
  return {
    operationName: "GridLayoutPositions",
    query: `query GridLayoutPositions($userId: String!, $tile: String!) {
  lucumaGridLayoutPositions(where: { userId: { _eq: $userId }, tile: { _eq: $tile } }) {
    section breakpointName tile width height x y
  }
}`,
    variables: { userId, tile },
  };
}

/**
 * A user's stored table states (TanStack `TableState` as JSON: columnVisibility, sorting, ...).
 * @param {{ userId: string }} args
 */
export function tablePreferences({ userId }) {
  return {
    operationName: "TablePreferences",
    query: `query TablePreferences($userId: String!) {
  lucumaTablePreferences(where: { userId: { _eq: $userId } }) { tableId preferences }
}`,
    variables: { userId },
  };
}
