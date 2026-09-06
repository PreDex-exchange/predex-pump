# Persistent testnet runtime handoff

This runtime deliberately supervises one process for each application role:

- `predex-api.service` — REST and WebSocket API on `127.0.0.1:3001`;
- `predex-indexer.service` — the only Arc indexer;
- `predex-operator.service` — the only transaction-signing migration/matcher operator;
- `predex-frontend.service` — the production Next.js server on `127.0.0.1:3002`;
- `predex-data.service` — Postgres, Qdrant, and disposable Redis in the exact
  `continuity-deadline` Compose project.

There is no second API worker, proxy, HTTPS termination, QA signer, or custom
process supervisor in this slice. API and indexer share the same Redis URL and
key prefix so indexed WebSocket events can cross the process boundary.

## Operator sequence

Run these commands from the Mac checkout. They never accept a private key on
the command line.

```sh
./scripts/cloudlab/sync.sh
./scripts/cloudlab/verify.sh
./scripts/cloudlab/runtime.sh install
./scripts/cloudlab/runtime.sh provision-operator
./scripts/cloudlab/runtime.sh up
./scripts/cloudlab/runtime.sh status
```

`provision-operator` parses exactly one `privKey=` record from the local
mode-0400/0600 `../.credentials/.arc` file and sends only its value on SSH stdin.
CloudLab stores it outside the source tree as a mode-0600 systemd credential
source. The operator receives only the credential-file path.

`up` refuses to start unless the current source ID has a fully passing
verification manifest and a production `.next` build. The operator starts only
after API reachability plus `chainState.ready`, balance reconciliation, and
zero indexer lag.

Until HTTPS is added, open the loopback-only runtime through one SSH tunnel:

```sh
ssh -i ~/.ssh/cloudlab -N \
  -L 3001:127.0.0.1:3001 \
  -L 3002:127.0.0.1:3002 \
  span14@c220g1-031117.wisc.cloudlab.us
```

Then open `http://localhost:3002`. The services remain bound to the remote
loopback interface; `localhost:3002` is also the API allowlisted origin and the
SIWE domain/URI for this pre-HTTPS access path.

## Operations

```sh
./scripts/cloudlab/runtime.sh restart api
./scripts/cloudlab/runtime.sh restart indexer
./scripts/cloudlab/runtime.sh restart operator
./scripts/cloudlab/runtime.sh restart frontend
./scripts/cloudlab/runtime.sh logs all 200
./scripts/cloudlab/runtime.sh down
```

An indexer restart temporarily stops the operator, waits for the indexer to
return to the healthy chain boundary, and restores the operator only if it was
previously active. `down` uses `docker compose stop`; it never removes the
continuity Postgres/Qdrant volumes or the operator credential. Docker's
`unless-stopped` policy recovers unexpected data-container exits but respects
this deliberate stop.

While `runtime/active` exists on CloudLab, `sync.sh` refuses to replace the
mutable source mirror. Stop the runtime before syncing and run the complete
verification gate again before the next `up`.
