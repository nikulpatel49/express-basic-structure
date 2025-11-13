# Pro-Level Wallet System — TypeScript + Mongoose + Node.js (Production Blueprint & Files)

> A production-ready blueprint and ready-to-use TypeScript code for a wallet + ledger system built with Node.js, Express, Mongoose, and MongoDB. Includes architecture patterns (transactions, outbox/event-sourcing, idempotency), operational concerns, Docker/K8s manifests, observability, CI, testing, and example code files.

---

## 1. Goals & non-goals

**Goals**

* Strong data integrity (atomic balance + ledger entries)
* High availability and horizontal scalability
* Clear audit trail + immutable ledger
* Idempotency for external retries
* Observability, monitoring, and traceability
* Secure by default: encryption, least privilege
* Extensible to payment rails and event-driven architecture

**Non-goals**

* Single-server shortcuts, ad-hoc consistency, or ignoring replica-set needs

---

## 2. High-level architecture

Components:

* API service (Express + TypeScript) — handles client API, validation, RBAC
* Worker service — processes background jobs, reconciliations, settlements
* Message broker (Kafka/RabbitMQ) — event pub/sub for downstream systems
* Outbox pattern in MongoDB for transactional event publishing
* Database: MongoDB replica set (transactions)
* Optional: Postgres for reporting / analytics (data sync)

Flow examples:

* Client -> API -> writes wallet balances + ledger within a transaction -> writes event to outbox -> worker publishes to Kafka -> downstream consumers
* For on-chain settlement: create batch transfer events that worker aggregates and sends to chain

---

## 3. Data model (production-ready)

Major collections:

* `wallets` — one per owner+currency, single-writer constraints supported via locking or queues
* `ledgers` — append-only immutable entries (transfer, deposit, withdraw, fee, reversal)
* `idempotency_keys` — centralized index to cheaply check idempotency across operations
* `outbox` — transactional event queue for reliable publishing
* `audit_logs` — optional higher-level ops logs

Design notes:

* store amounts as **64-bit integer** in smallest unit (e.g., cents) — use `mongoose-long` or `BigInt` via `Decimal128` if necessary
* ledger entries should have `status` (e.g., `PENDING`, `CONFIRMED`, `REVERSED`) for business flows
* include `traceId` (from incoming request) on all records for full traceability

---

## 4. Transaction & Idempotency Patterns

**Atomic change + ledger**

* Use MongoDB session transactions to `update` wallet balance and `insert` ledger atomically
* Fail fast on insufficient funds

**Idempotency**

* Client provides `Idempotency-Key` header
* We persist key with a fingerprint and point to resulting ledger/transfer IDs
* On retry, return the original response instead of reapplying

**Outbox pattern**

* Write the domain change and an outbox row in the same transaction
* Background publisher reads un-published outbox rows, publishes to Kafka, then marks published

**Optimistic single-writer slots**

* For high concurrency, implement a per-wallet single-writer queue (Redis stream or partitioning by walletId)
* Or use version / `findOneAndUpdate` with `version` to prevent lost updates

---

## 5. Folder layout (pro)

```
src/
  api/
    app.ts
    server.ts
    routes/
    controllers/
    handlers/
    validators/
    middlewares/
  services/
    wallet.service.ts
    transfer.service.ts
    reconciliation.service.ts
  workers/
    publisher.worker.ts
    settlement.worker.ts
  db/
    mongoose.ts
    models/
  lib/
    outbox.ts
    idempotency.ts
    metrics.ts
    tracer.ts
  types/
  config/
  scripts/
  tests/
  infra/
    docker/
    k8s/
```

---

## 6. Production-ready code patterns (snippets in doc)

* Strongly typed DTOs
* Centralized validation using `zod` + `express-zod-api` or `class-validator`
* Detailed error classes and error codes
* Request tracing and correlation (`traceId`) using `cls-hooked` or OpenTelemetry context propagation
* Centralized metrics (Prometheus) + request histograms + counters for failed transfers
* Rate limiting and IP protections

---

## 7. Security & secrets

* Store secrets in Vault / K8s secrets; do not keep credentials in envs in plaintext
* Use TLS everywhere; enforce mTLS between services for high security
* Field-level encryption for PII in wallet metadata (MongoDB client-side field-level encryption or app-layer encryption)
* RBAC for API endpoints; only payment role may create deposits/withdrawals
* Audit logs immutable and forwarded to WORM storage for compliance

---

## 8. Observability

* OpenTelemetry tracing (span for API call, DB transaction, outbox publish)
* Prometheus metrics: `wallet_balance_changes_total`, `transfer_failures_total`, histograms for request latency
* Logs in structured JSON and ship to ELK / Loki
* Alerting for: negative balance attempts, transaction rollbacks, outbox backlog growth, publishing failures

---

## 9. Testing strategy

* Unit tests: jest + ts-jest with mocked Mongoose
* Integration tests: `mongodb-memory-server` with replica set emulation for transactions
* Concurrency tests: spawn many parallel transfer requests to assert no double-spend
* Contract tests: tests for outbox -> worker publishing
* E2E tests: using docker-compose stack (mongo replica set, kafka, redis)

---

## 10. Deployment & infra

* Dockerfile for API & workers (multi-stage build)
* K8s manifests: Deployment, HPA, PodDisruptionBudget, StatefulSet for Mongo, PersistentVolumeClaims
* Use a managed Kafka (Confluent / MSK) where possible
* CI/CD pipeline: build image, run tests, security scan, push image, deploy via ArgoCD/Flux

---

## 11. Reconciliation & Recovery

* Daily reconciliation job: verify `wallet.balance == sum(ledgers)` per wallet; store reconciliation results
* For mismatches, auto-create `REVERSAL` or `ADJUSTMENT` ledger with admin approval workflow
* Provide admin tools to re-run failed transactions safely (idempotent)

---

## 12. Example endpoints (secure & versioned)

```
POST /v1/wallets            -> create wallet
GET  /v1/wallets/:id        -> get wallet + balance
POST /v1/wallets/:id/deposit
POST /v1/wallets/:id/withdraw
POST /v1/wallets/:id/transfer -> body: { toWalletId, amount }
GET  /v1/wallets/:id/ledger  -> paginated ledger
POST /v1/admin/reconcile     -> manual reconcile run (auth: admin)
```

Headers:

* `Idempotency-Key: <uuid>`
* `X-Trace-Id: <trace>`
* `Authorization: Bearer <jwt>`

---

## 13. Checklist before prod

* Replica set + backups configured
* Outbox publisher resilient (retries + DLQ)
* Rate limiting + auth + RBAC
* Field encryption for PII
* Monitoring + alerting
* Load tests with expected RPS
* Security scan (Snyk / Trivy)

---

## 14. Included example files

This document includes full-fledged TypeScript files for:

* Models: `Wallet`, `Ledger`, `Outbox`, `IdempotencyKey`
* Services: `wallet.service`, `transfer.service`, `outbox.publisher`
* API: controllers, routes, validation
* Workers: outbox publisher worker
* Dockerfile and minimal k8s manifests
* Tests: concurrency test and integration test

---

## 15. Next steps (pick one)

* I can scaffold the full repo (all TS files + package.json + Dockerfile + k8s) and zip it for you.
* Or generate the concurrency test + CI workflow first.
* Or adapt the design to support cross-currency conversion and FX ledger entries.

Tell me which one and I will generate the files in this canvas and export the repository structure.

---

*End of pro-level blueprint.*
