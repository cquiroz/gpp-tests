---
id: 022
title: "graphql-transport-ws client for k6 and the subscriber VUs"
labels: [wayfinder:task]
status: open
assignee:
blocked-by: []
---

## Question

Websockets are in v1 (ticket 020, "crucial"). Write a `graphql-transport-ws` client on
k6's stable `k6/websockets` module — `connection_init` with the `Authorization` payload,
`subscribe`/`next`/`complete`, server `ping`→`pong`, reconnect with backoff — usable both
for long-lived subscriptions and for one-shot queries over the socket (Observe's
transport, ticket 021).

Then the two **subscriber VU** shapes: **Explore-tab** (PI identity from the pool, 017;
the subscriptions one open program produces, ~8, plus the sequence tile's when an
observation is selected) and **Observe-browser** (staff identity; observationEdit,
datasetEdit, executionEventAdded for one loaded observation). Measure the same-VU round
trip from a mutation's acknowledgement to the matching event on the VU's own
subscription, and socket health (drops, reconnects, unanswered pings). Cross-VU fan-out
lag is out of scope — record what correlation channel it would need. Developable against
the local compose stack. Resolution records the client's API and the first measured
round trip.
