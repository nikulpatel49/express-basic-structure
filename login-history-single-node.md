# LoginHistory Module — Single MongoDB Node (Pure TypeScript, Express, Mongoose)

This is a production-ready design and implementation guide for a **LoginHistory** module optimized to run on a **single MongoDB instance (no replica set, no sharding)** while supporting large scale (tens to hundreds of millions of events) through conservative schema design, bucketed alternatives, TTL, archival, and ops guidance.

> Deliverables in this document:
> - copy-pasteable TypeScript schemas, controllers, services, validation, and routes
> - examples for mobile device info (device name + model)
> - scaling and operational guidance for single-node MongoDB
> - retention / TTL options and archival recommendations

---

## Table of Contents
1. Goals & Constraints
2. Data model (simple event-per-document)
3. Alternative: monthly bucketed model (recommended for scale)
4. APIs (endpoints & examples)
5. Implementation files (TypeScript snippets)
6. Retention, TTL & Archival (pure TTL)
7. Performance & operational guidance (single node)
8. Testing examples (Jest + Supertest)
9. FAQs & common pitfalls
10. Quick checklist to ship

---

## 1) Goals & Constraints
- **Single MongoDB instance** (no replica set, no sharding). Keep the design and ops simple.
- Support mobile login metadata: `device.name`, `device.model`, `loginType` (social, passkey, phone, email).
- Keep indexes minimal to avoid RAM and I/O pressure.
- Provide optional TTL-based retention and an archival path to S3 (recommended).
- Easy integration into existing Express + TypeScript projects.

---

## 2) Data model — Simple event-per-document (small, indexed)
This is the simplest model and is workable if you control retention and index size.

```ts
// src/models/loginHistory.model.ts
import { Schema, model } from 'mongoose';

export type LoginType = 'social' | 'passkey' | 'phone' | 'email';

const LoginHistorySchema = new Schema({
  userId: { type: String, required: true, index: true }, // store as string for scale/compat
  loginType: { type: String, enum: ['social','passkey','phone','email'], required: true },
  ipAddress: { type: String },
  userAgent: { type: String },
  location: {
    country: { type: String },
    city: { type: String }
  },
  device: {
    name: { type: String },
    model: { type: String }
  },
  success: { type: Boolean, required: true }
}, { timestamps: { createdAt: 'createdAt', updatedAt: false } });

// Compound index: userId + createdAt for fast last-N queries per user
LoginHistorySchema.index({ userId: 1, createdAt: -1 });

export const LoginHistory = model('LoginHistory', LoginHistorySchema);
```

**Notes**:
- Keep `ipAddress` unindexed (or masked) unless you need fast IP lookups — indexes increase memory usage.
- Store `userId` as string if you prefer UUIDs; use ObjectId only if you need DB references.

---

## 3) Alternative (recommended for very high volume): Monthly bucketed model
If you expect many events and limited hardware (single node), bucketed documents drastically reduce index updates and document count. Use monthly buckets (or per-N events) to keep arrays small.

```ts
// src/models/loginHistoryBucket.model.ts
import { Schema, model } from 'mongoose';
const EventSchema = new Schema({
  ts: { type: Date, required: true },
  loginType: { type: String, enum: ['social','passkey','phone','email'], required: true },
  deviceId: { type: String },
  device: { name: String, model: String },
  success: { type: Boolean, required: true },
  ip: String,
  userAgent: String,
  meta: Schema.Types.Mixed
}, { _id: false });

const BucketSchema = new Schema({
  userId: { type: String, required: true },
  bucketKey: { type: String, required: true }, // "2025-08"
  seq: { type: Number, default: 0 },
  events: { type: [EventSchema], default: [] },
  eventsCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null, index: { expireAfterSeconds: 0 } },
  archived: { type: Boolean, default: false, index: true }
});
BucketSchema.index({ userId: 1, bucketKey: -1, seq: -1 });
export const LoginHistoryBucket = model('LoginHistoryBucket', BucketSchema);
```

**Bucket write approach**:
- `updateOne({ userId, bucketKey, seq }, { $push: { events: event }, $inc: { eventsCount: 1 } })` with `upsert: true`.
- Cap `eventsCount` at `MAX_EVENTS_PER_BUCKET` (e.g., 5k). On exceed, create next `seq` (seq++).
- When querying last N events, fetch the latest few buckets and merge arrays in application memory — efficient for per-user queries.

---

## 4) APIs (recommended endpoints)
- `POST /v1/login-history` — record an attempt (internal server call from your auth flow)
- `GET /v1/login-history?userId=...&limit=20&page=1` — list per-user (admin or internal)
- `GET /v1/login-history/:id` — single record or bucket lookup
- `GET /v1/login-history/export/:userId` — GDPR export (admin)
- `POST /v1/login-history/bulk-delete` — admin cleanup (soft-delete or hard-delete)

**Example payload**:
```json
{
  "userId": "123e4567-e89b-12d3-a456-426614174000",
  "loginType": "phone",
  "ipAddress": "103.45.22.11",
  "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  "location": { "country": "IN", "city": "Ahmedabad" },
  "device": { "name": "iPhone", "model": "iPhone 14 Pro" },
  "success": true,
  "meta": { "app_version": "1.2.3" }
}
```

---

## 5) Implementation snippets (controllers, validation, routes)

### Controller (simple event-per-document)
```ts
// src/controllers/loginHistory.controller.ts
import { Request, Response } from 'express';
import { LoginHistory } from '../models/loginHistory.model';

export async function recordLogin(req: Request, res: Response) {
  const body = req.body;
  // basic validation should be done via Zod/Joi before calling this
  const doc = await LoginHistory.create({
    userId: body.userId,
    loginType: body.loginType,
    ipAddress: body.ipAddress || req.ip,
    userAgent: body.userAgent || req.get('user-agent'),
    location: body.location,
    device: body.device,
    success: body.success
  });
  res.status(201).json({ id: doc._id, createdAt: doc.createdAt });
}
```

### Route
```ts
// src/routes/loginHistory.routes.ts
import { Router } from 'express';
import { recordLogin } from '../controllers/loginHistory.controller';
const router = Router();
router.post('/v1/login-history', recordLogin);
// add admin routes for listing/exporting with auth middleware in your app
export default router;
```

### Validation (Zod)
```ts
import { z } from 'zod';

export const RecordLoginSchema = z.object({
  userId: z.string().min(1),
  loginType: z.enum(['social','passkey','phone','email']),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  location: z.object({ country: z.string().optional(), city: z.string().optional() }).optional(),
  device: z.object({ name: z.string().optional(), model: z.string().optional() }).optional(),
  success: z.boolean(),
  meta: z.record(z.any()).optional()
});
```

---

## 6) Retention, TTL & Archival (pure TTL)
- For **event-per-document**: add TTL index on `createdAt` if you want auto-expiration:
```ts
LoginHistorySchema.index({ createdAt: 1 }, { expireAfterSeconds: 60*60*24*365 }); // expire after 1 year
```
- For **bucket model**: set `expiresAt` per bucket and use TTL index `{ expiresAt: 1 }` with `expireAfterSeconds: 0` (already in bucket schema above). Mongo's TTL monitor runs periodically — not immediate.

**Archival recommendation**:
- Daily batch job: find buckets/rows older than cutoff, write to S3 (Parquet or NDJSON), verify, then delete in batches.
- Use streaming to avoid reading huge data into memory.

---

## 7) Performance & operational guidance (single Mongo node)
- **Hardware**: use fast NVMe SSD, adequate RAM (aim to hold indexes + hot buckets), CPU with good single-thread performance.
- **Disk**: provision IOPS for peaks. Monitor disk queue and latency.
- **RAM**: indexes should fit in RAM for best performance. Keep index count minimal.
- **Indexes**: only `{ userId:1, createdAt:-1 }` and a few small ones. Avoid indexing arrays / large texts.
- **Backups**: regular snapshots; test restore workflows.
- **Monitoring**: track writes/sec, page faults, free disk, CPU, lock time. Alert on spikes in failed logins.
- **Concurrency**: tune Mongo connection pool and Node.js cluster/workers to match CPU cores.
- **Bulk deletes**: delete in batches (e.g., 1000 docs per batch) to avoid huge write loads.
- **Scale path**: if single-node becomes a bottleneck later, migrate to replica set → sharded cluster (non-trivial migration but straightforward with planning).

---

## 8) Testing examples (Jest + Supertest)
- Create a simple e2e test that inserts a login and reads it back.
- Reuse patterns from your other tests (setup/teardown DB).

Example test skeleton:
```ts
import request from 'supertest';
import app from '../app';
test('record login', async () => {
  const payload = { userId: 'u1', loginType: 'email', success: true };
  const res = await request(app).post('/v1/login-history').send(payload).expect(201);
  expect(res.body.id).toBeTruthy();
});
```

---

## 9) FAQs & common pitfalls
**Q: Will a single node handle 300M events/year?** — Possibly, with bucketed model, TTL/archival, fast disks, and indexes in RAM. But monitor closely.  
**Q: Should I index `ipAddress`?** — Avoid unless necessary; large index on IPs increases RAM pressure. Mask IPs or keep them unindexed.  
**Q: How to export user's history?** — Stream from DB (or S3 archive) and provide JSON/CSV download. For large volumes, fetch from S3.  
**Q: How to detect new device logins?** — Compare incoming `device.model` + `device.name` + `fingerprint` against recent entries. Use small `DeviceIndex` collection to keep latest device per user if you need quick queries.

---

## 10) Quick checklist to ship
- [ ] Add `LoginHistory` model (choose event or bucket model)
- [ ] Add `recordLogin` endpoint and wire to auth flow (server-side only)
- [ ] Add Zod validation middleware
- [ ] Add TTL or archival job (decide retentionDays)
- [ ] Add admin endpoints (list/export/delete) behind auth
- [ ] Add monitoring and alerts (failed login spikes)
- [ ] Load-test with realistic samples (simulate bursts)

---

**Done.** This .md contains everything you need to implement a high-scale—but single-node—LoginHistory system with mobile device details (name & model) and multiple login types. If you want, I can now:  
- generate ready-to-drop TypeScript files for your repo, OR  
- produce an S3 archival worker skeleton (Node.js) and add example scripts for batch deletion, OR  
- create a sample load-test script that simulates realistic login traffic for 10M users.

Tell me which and I’ll produce it next.
