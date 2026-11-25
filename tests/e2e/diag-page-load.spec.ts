import { type Page, expect, test } from "@playwright/test";
import { createObservation, createProgram, createTarget } from "../../lib/odb-operations.js";
import * as ui from "../support/selectors.js";
import { StandardSession, loadStandardUser } from "../support/standard-users.js";

// Throwaway diagnostic: why does each Explore page load wait ~30 s in CI and ~2 s locally?

const pi = loadStandardUser("TEST_PI");
const domain = process.env.GPP_TEST_DOMAIN ?? "gpp-test.internal";

function timeline(label: string) {
  const start = Date.now();
  return (line: string) => console.log(`DIAG ${label} +${String(Date.now() - start).padStart(6)}ms ${line}`);
}

function watch(page: Page, log: (line: string) => void) {
  page.on("websocket", (ws) => {
    const url = ws.url();
    log(`ws created ${url}`);
    let sent = 0;
    let received = 0;
    ws.on("framesent", (f) => {
      if (sent++ < 3) log(`ws sent ${url} ${String(f.payload).slice(0, 120)}`);
    });
    ws.on("framereceived", (f) => {
      if (received++ < 3) log(`ws received ${url} ${String(f.payload).slice(0, 120)}`);
    });
    ws.on("socketerror", (e) => log(`ws error ${url} ${e}`));
    ws.on("close", () => log(`ws closed ${url} (sent ${sent}, received ${received})`));
  });
  page.on("console", (m) => log(`console ${m.type()} ${m.text().replace(/\s+/g, " ").slice(0, 160)}`));
  page.on("requestfailed", (r) => log(`request failed ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  page.on("worker", (w) => log(`worker ${w.url().slice(0, 100)}`));
}

async function rawProbe(page: Page, log: (line: string) => void) {
  for (const [name, url, protocol] of [
    ["odb", `wss://odb.${domain}/ws`, "graphql-transport-ws"],
    ["prefs", `wss://prefs.${domain}/v1/graphql`, "graphql-ws"],
  ] as const) {
    const result = await page.evaluate(
      ({ url, protocol }) =>
        new Promise<string>((resolve) => {
          const t0 = performance.now();
          const ms = () => Math.round(performance.now() - t0);
          const marks: string[] = [];
          const ws = new WebSocket(url, protocol);
          const done = (why: string) => {
            marks.push(`${why} ${ms()}ms`);
            ws.close();
            resolve(marks.join(", "));
          };
          setTimeout(() => done("gave up"), 60_000);
          ws.onopen = () => {
            marks.push(`open ${ms()}ms`);
            ws.send(JSON.stringify({ type: "connection_init", payload: {} }));
          };
          ws.onmessage = (e) => done(`first message ${String(e.data).slice(0, 60)}`);
          ws.onerror = () => marks.push(`error ${ms()}ms`);
          ws.onclose = (e) => done(`closed code ${e.code}`);
        }),
      { url, protocol },
    );
    log(`raw ${name}: ${result}`);
  }
  const idb = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const t0 = performance.now();
        const req = indexedDB.open(`diag-${Math.random()}`);
        req.onsuccess = () => resolve(`indexedDB open ${Math.round(performance.now() - t0)}ms`);
        req.onerror = () => resolve(`indexedDB error ${Math.round(performance.now() - t0)}ms`);
        req.onblocked = () => resolve(`indexedDB blocked ${Math.round(performance.now() - t0)}ms`);
      }),
  );
  log(idb);
}

test("diagnostic: where the time goes in an Explore page load", async ({ browser }) => {
  test.skip(!pi, "no fabricated standard users");
  test.setTimeout(600_000);

  const odb = new StandardSession(pi!).client();
  const program = await odb.run<{ createProgram: { program: { id: string } } }>(
    createProgram({ name: `gpp-tests diag ${Date.now()}` }),
  );
  const programId = program.createProgram.program.id;
  const target = await odb.run<{ createTarget: { target: { id: string } } }>(
    createTarget({ programId, name: "diag target" }),
  );
  const created = await odb.run<{ createObservation: { observation: { id: string } } }>(
    createObservation({ programId, targetIds: [target.createTarget.target.id], subtitle: "diag" }),
  );
  const observationId = created.createObservation.observation.id;

  const context = await browser.newContext();
  await new StandardSession(pi!).inject(context);
  const page = await context.newPage();

  try {
    let log = timeline("probe-before-explore");
    await page.goto("/environments.conf.json");
    await rawProbe(page, log);

    for (const round of [1, 2]) {
      log = timeline(`load-${round}`);
      const listener = log;
      page.removeAllListeners("websocket");
      page.removeAllListeners("console");
      page.removeAllListeners("requestfailed");
      page.removeAllListeners("worker");
      watch(page, listener);
      log("goto");
      await page.goto(`/${programId}/observation/${observationId}`);
      log("goto returned");
      await expect(ui.obsTreeAddObservationButton(page)).toBeVisible({ timeout: 120_000 });
      log("obs tree visible");
    }

    log = timeline("probe-after-explore");
    page.removeAllListeners("console");
    await rawProbe(page, log);
  } finally {
    await context.close();
  }
});
