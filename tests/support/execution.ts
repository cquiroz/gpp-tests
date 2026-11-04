import {
  DATASET_STAGES,
  addDatasetEvent,
  addSequenceEvent,
  addStepEvent,
  executionConfig,
  recordDataset,
  recordVisit,
} from "../../lib/odb-operations.js";
import { OdbClient, eventually } from "./odb.js";

/**
 * Executes the first acquisition step of an observation the way the k6 execution VU and
 * `tools/verify-operations.js` do (ticket 021): a visit, the sequence started, the step's
 * events around one dataset, the sequence stopped. That is what turns an observation into
 * an "executed" one for Explore: its sequence is materialized, its execution state ONGOING,
 * and the step's time is charged to the program.
 *
 * The execution mutations are service-role only; the stack's service JWT is in the generated
 * env as ODB_SERVICE_JWT (`stack/scripts/bootstrap.sh`). Specs skip when it is absent.
 */
export const serviceJwt: string | undefined = process.env.ODB_SERVICE_JWT;

export function serviceClient(): OdbClient {
  if (!serviceJwt) throw new Error("ODB_SERVICE_JWT is not set");
  return new OdbClient(async () => serviceJwt);
}

interface Step {
  id: string;
}

interface InstrumentConfig {
  acquisition?: { nextAtom?: { steps: Step[] } } | null;
}

interface ExecutionConfigResult {
  executionConfig: {
    gmosNorth?: InstrumentConfig | null;
    gmosSouth?: InstrumentConfig | null;
    flamingos2?: InstrumentConfig | null;
  } | null;
}

export interface ExecutedStep {
  visitId: string;
  stepId: string;
  datasetId: string;
}

/**
 * Records one executed acquisition step. `exposureMs` is real wall-clock time spent between
 * the dataset's first and last events, so the charged time is measurably above zero.
 */
export async function executeFirstStep(
  observationId: string,
  { exposureMs = 2_000 } = {},
): Promise<ExecutedStep> {
  const odb = serviceClient();
  const key = () => crypto.randomUUID();
  const at = () => new Date().toISOString();

  const visit = await odb.run<{ recordVisit: { visit: { id: string } } }>(
    recordVisit({ observationId, idempotencyKey: key(), clientTime: at() }),
  );
  const visitId = visit.recordVisit.visit.id;
  await odb.run(addSequenceEvent({ visitId, command: "START", idempotencyKey: key(), clientTime: at() }));

  // obscalc generates the sequence in the background; until then the ODB answers
  // `sequence_unavailable`, which `eventually` retries.
  const step = await eventually(
    `obscalc to produce the first acquisition step of ${observationId}`,
    async () => {
      const data = await odb.run<ExecutionConfigResult>(
        executionConfig({ observationId, futureLimit: 0 }),
      );
      const config = data.executionConfig;
      const instrument = config?.gmosNorth ?? config?.gmosSouth ?? config?.flamingos2;
      return instrument?.acquisition?.nextAtom?.steps?.[0];
    },
    { timeoutMs: 180_000, intervalMs: 3_000 },
  );

  const stepEvent = (stepStage: string) =>
    odb.run(addStepEvent({ visitId, stepId: step.id, stepStage, idempotencyKey: key(), clientTime: at() }));
  const datasetEvent = (datasetId: string, datasetStage: string) =>
    odb.run(addDatasetEvent({ datasetId, datasetStage, idempotencyKey: key(), clientTime: at() }));

  await stepEvent("START_STEP");
  await stepEvent("START_CONFIGURE");
  await stepEvent("END_CONFIGURE");
  await stepEvent("START_OBSERVE");
  const day = at().slice(0, 10).replaceAll("-", "");
  const dataset = await odb.run<{ recordDataset: { dataset: { id: string } } }>(
    recordDataset({
      visitId,
      stepId: step.id,
      filename: `N${day}S${String(Date.now() % 100_000_000).padStart(4, "0")}.fits`,
      idempotencyKey: key(),
    }),
  );
  const datasetId = dataset.recordDataset.dataset.id;
  await datasetEvent(datasetId, DATASET_STAGES[0]);
  await new Promise((resolve) => setTimeout(resolve, exposureMs));
  for (const stage of DATASET_STAGES.slice(1)) await datasetEvent(datasetId, stage);
  await stepEvent("END_OBSERVE");
  await stepEvent("END_STEP");
  await odb.run(addSequenceEvent({ visitId, command: "STOP", idempotencyKey: key(), clientTime: at() }));

  return { visitId, stepId: step.id, datasetId };
}
