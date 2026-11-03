import {
  globalPreferences as globalPreferencesQuery,
  gridLayoutPositions as gridLayoutPositionsQuery,
  tablePreferences as tablePreferencesQuery,
} from "../../lib/prefs-operations.js";
import { endpoints } from "./odb.js";

/**
 * Explore's preferences as Hasura holds them, read over HTTPS. The stack runs Hasura with
 * no admin secret, so every request is admin and no token is needed
 * (`stack/docker-compose.yml`, the hasura service). Explore writes these over its prefs
 * websocket, fire-and-forget, so a spec that reloads right after a change races the write;
 * polling these until the row says what the UI did is what makes "survives a reload" a fair
 * assertion of the Hasura round trip.
 */
export interface GlobalPreferencesRow {
  exploreGuideButton: boolean;
  wavelengthUnits: string;
}

export interface GridLayoutRow {
  section: string;
  breakpointName: string;
  tile: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface TablePreferencesRow {
  tableId: string;
  preferences: {
    columnVisibility?: Record<string, boolean>;
    sorting?: { id: string; desc: boolean }[];
  };
}

interface Document {
  query: string;
  variables: Record<string, unknown>;
}

async function prefs<T>(document: Document): Promise<T> {
  const url = endpoints.prefsWsUrl.replace(/^ws/, "http");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document),
  });
  if (!response.ok) throw new Error(`prefs returned ${response.status}`);
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`prefs: ${body.errors[0]!.message}`);
  if (body.data === undefined) throw new Error("prefs: no data");
  return body.data;
}

/** The user's global preferences row, or null when the user has never stored one. */
export async function globalPreferences(userId: string): Promise<GlobalPreferencesRow | null> {
  const data = await prefs<{ lucumaUserPreferencesByPk: GlobalPreferencesRow | null }>(
    globalPreferencesQuery({ userId }),
  );
  return data.lucumaUserPreferencesByPk;
}

/** Every stored layout row for one tile (one per section and breakpoint Explore wrote). */
export async function gridLayoutPositions(userId: string, tile: string): Promise<GridLayoutRow[]> {
  const data = await prefs<{ lucumaGridLayoutPositions: GridLayoutRow[] }>(
    gridLayoutPositionsQuery({ userId, tile }),
  );
  return data.lucumaGridLayoutPositions;
}

/** The user's stored table states, one row per table id. */
export async function tablePreferences(userId: string): Promise<TablePreferencesRow[]> {
  const data = await prefs<{ lucumaTablePreferences: TablePreferencesRow[] }>(
    tablePreferencesQuery({ userId }),
  );
  return data.lucumaTablePreferences;
}
