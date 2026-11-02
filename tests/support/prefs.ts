import { globalPreferences as globalPreferencesQuery } from "../../lib/prefs-operations.js";
import { endpoints } from "./odb.js";

/**
 * A user's global preferences row as Hasura holds it, read over HTTPS. The stack runs Hasura
 * with no admin secret, so every request is admin and no token is needed
 * (`stack/docker-compose.yml`, the hasura service). Explore writes these over its prefs
 * websocket, fire-and-forget, so a spec that reloads right after a change races the write;
 * polling this until the row says what the UI did is what makes "survives a reload" a fair
 * assertion of the Hasura round trip.
 */
export interface GlobalPreferencesRow {
  exploreGuideButton: boolean;
  wavelengthUnits: string;
}

export async function globalPreferences(userId: string): Promise<GlobalPreferencesRow | null> {
  const url = endpoints.prefsWsUrl.replace(/^ws/, "http");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(globalPreferencesQuery({ userId })),
  });
  if (!response.ok) throw new Error(`prefs returned ${response.status}`);
  const body = (await response.json()) as {
    data?: { lucumaUserPreferencesByPk: GlobalPreferencesRow | null };
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`prefs: ${body.errors[0]!.message}`);
  return body.data?.lucumaUserPreferencesByPk ?? null;
}
