# Glossary

- **odb** — the backend: Postgres database fronted by a GraphQL server, source of truth
  for programs and observations.
- **Explore** — the React web frontend through which users manipulate odb data.
- **Observe** — the sequence-execution application at each telescope. It reports
  execution progress to the odb as execution events and refetches the sequence as it
  goes. Production runs one instance per site; a few more may exist for engineering.
- **SSO** — the authentication service; issues JWTs (and a remember-me cookie) and
  exposes an API for obtaining tokens without a browser.
- **Scenario** — one end-to-end user flow expressed as an automated test (e.g. "create a
  program"). A scenario may have a browser variant and a GraphQL-level variant.
- **Regression subset** — the fast set of scenarios run frequently to detect breakage.
- **Performance set** — the load-test scenarios run against a deployed environment,
  simulating concurrent users. Runs as two profiles: the nightly **trend run** and the
  on-demand **surge run**.
- **Test run** — one execution of a suite against one environment, starting from a fresh
  database for regression runs; the unit that dashboards and traces are grouped by.
- **Fresh database** — an empty Postgres brought to schema by migrations alone; no
  reference data. Scenarios create all data they need.
- **Guest VU** — a load-test virtual user whose identity is a fresh SSO guest, created
  via `auth-as-guest` at ramp start; it self-seeds its own working set and refreshes its
  JWT via its session cookie. Carries the regular-operations mix.
- **Standard-user pool** — the PI and staff identities fabricated per run for VUs that
  need a real role: PIs submit proposals and hold Explore subscriptions, staff drive
  Observe's browser. One identity per VU; identities are never shared across VUs, and the
  people submitting proposals are never the people operating Observe.
- **Execution VU** — a load-test virtual user impersonating one Observe server instance:
  service identity, faithful per-step call order and transport split, cadence as a
  parameter.
- **Subscriber VU** — a load-test virtual user holding a live websocket with continuous
  subscriptions. Two shapes: the **Explore-tab subscriber** (PI identity, the
  subscriptions one open program produces) and the **Observe-browser subscriber** (staff
  identity, the subscriptions one loaded observation produces).
- **Ephemeral stack** — the throwaway deployment (odb + Postgres + Explore + auth) booted
  inside CI for a regression run and discarded after.
- **Load target** — the deployed environment the performance set points at. The surge
  run iterates on a self-hosted cloud target; the capacity claim is read on a
  production-shaped target, because numbers from one say nothing about the other.
- **Per-merge run** — a regression-subset test run triggered by an upstream merge to main,
  pinned to exactly what that merge built, its verdict reported back on the merge commit.
  Advisory: it attributes breakage to a commit, it never blocks one.
- **Release-confidence run** — a regression-subset test run pinned to the exact artifacts a
  promotion to staging would ship, executed before promoting. Advisory: the promoter reads
  the verdict and decides.
- **Advisory** — a test verdict that informs developers (commit status, alert) but can
  never block a merge or a promotion. Every cross-system verdict is advisory until the
  suites earn blocking through a proven track record.
- **Testid contract** — the set of stable `data-testid` identifiers Explore ships, owned
  and versioned by lucuma-apps and consumed by this repo's selectors. The contract is the
  boundary: Explore devs promise the ids exist; scenarios promise to locate elements only
  through them.
- **Trend run** — the nightly load-test profile whose claim is "tonight is slower than
  last night": night-over-night regression trending, not absolute capacity.
- **Surge run** — the on-demand load-test profile simulating the end of a Call for
  Proposals while the telescopes observe: proposal submission at deadline rate, Explore
  subscribers, Observe execution, and the regular-operations mix, all at once. Its claim is
  that observation execution stays within its stall budget, proposal submission stays
  usable, and regular operations stay within spec. Runs in two tiers.
- **Realistic tier** — the surge tier sized from evidence: the submission rate and
  concurrency a real deadline is expected to produce, and the real number of telescopes.
- **Ceiling tier** — the surge tier sized from the stated stress ceiling (500 proposals in
  the final hour) with engineering Observe instances added. A pass here is headroom, not
  a prediction.
- **Step ODB overhead** — the time one executed step spends waiting on the odb: the sum of
  the moments at which Observe cannot proceed until the odb answers. The telescope's
  stall metric; per-mutation latency alone does not capture it.
- **Surge SLO** — an absolute pass criterion for one class of surge traffic (execution,
  proposals, regular operations, subscriptions). Absolute because the surge claim is
  absolute; the trend run's baseline-relative thresholds are a different thing.
  _Avoid_: threshold (reserved for the trend run's ledger-derived limits).
- **Surge verdict** — the surge run's pass/fail, one line per surge SLO, published with
  the run.
- **gpp-tests** — the production testing repository (`gemini-hlsw/gpp-tests`, public)
  that graduates this prototype; all three suites live there, separated internally with
  the load suite as the front door. This repo is its prototype (`cquiroz/gpp-tests`), kept
  as the frozen archive of the wayfinding and research once the surge branch has moved
  across.
