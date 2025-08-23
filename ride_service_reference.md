# Ride Service (Mongoose + ioredis) — Reference Implementation

A production-style, **single-file reference** for building an Uber-like **ride request → driver acceptance** flow at very high scale using **MongoDB (Mongoose)** and **Redis (ioredis)**. It focuses on:

- **Idempotent ride creation** (no duplicate rides on retries)
- **First-accept-wins** driver assignment (no multi-assign)
- **MongoDB sharding** on `hashed _id`
- **Safe Lua execution** with automatic fallback when Redis restarts (`NOSCRIPT` protection)

> You can copy each code block into files, or wire this into a monorepo. Commands and rationale included.

---

## 0) Quick Start

```bash
# 1) Install
npm i express mongoose ioredis dotenv

# 2) Start Mongo & Redis (examples)
# Mongo: replicaset+sharding in your infra; for local dev, a single mongod is OK
# Redis: use Redis Cluster in prod; for dev you can use single node

# 3) Configure env
cat > .env <<'ENV'
MONGO_URI=mongodb://localhost:27017/uber_clone
# For Redis Cluster, comma-separated host:port; for single node, a single entry
REDIS_NODES=127.0.0.1:6379
PORT=3000
ENV

# 4) Run
node server.js
```

---

## 1) models/Ride.js — Mongoose Schema (shard-friendly)

```js
// models/Ride.js
const mongoose = require("mongoose");

const rideSchema = new mongoose.Schema(
  {
    // Parties
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", index: true },

    // Locations (simple numeric lat/lng; use GeoJSON 2dsphere if you query Mongo by geo)
    pickup: { lat: Number, lng: Number, address: String },
    dropoff: { lat: Number, lng: Number, address: String },

    // Pricing
    estimatedFare: Number, // pre-ride estimate
    actualFare: Number,    // finalized at completion

    // Status lifecycle
    status: {
      type: String,
      enum: ["requested", "accepted", "in_progress", "completed", "cancelled"],
      default: "requested",
      index: true,
    },

    // Idempotency (prevents duplicate ride creation)
    idemKey: { type: String, unique: true, sparse: true },

    // Timestamps
    requestedAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

// ⚙️ Sharding: hashed on _id (declared here for clarity; run sharding in mongosh below)
rideSchema.index({ _id: "hashed" });

// Helpful secondary indexes for hot queries
rideSchema.index({ driverId: 1, status: 1 });           // driver current ride
rideSchema.index({ riderId: 1, createdAt: -1 });        // rider history

module.exports = mongoose.model("Ride", rideSchema);
```

**Why hashed `_id`?** Uniform write distribution across shards with zero app complexity. Reads by `_id` are targeted; other queries use secondary indexes.

---

## 2) lib/redis.js — ioredis (Single or Cluster)

```js
// lib/redis.js
const Redis = require("ioredis");

function buildRedis() {
  const nodes = process.env.REDIS_NODES?.split(",").map(s => {
    const [host, port] = s.split(":");
    return { host, port: Number(port) };
  }) || [];

  if (nodes.length > 1) {
    // Redis Cluster (recommended in production)
    return new Redis.Cluster(nodes, {
      scaleReads: "slave",
      redisOptions: { enableAutoPipelining: true },
    });
  }

  // Single-node (dev/testing)
  if (nodes.length === 1) {
    const { host, port } = nodes[0];
    return new Redis({ host, port, enableAutoPipelining: true });
  }

  // Default localhost
  return new Redis({ host: "127.0.0.1", port: 6379, enableAutoPipelining: true });
}

module.exports = buildRedis();
```

---

## 3) lib/lua.js — Lua Scripts + Safe Eval (NOSCRIPT fallback)

```js
// lib/lua.js
const redis = require("./redis");

// Lua: first-accept-wins lock
const LOCK_SCRIPT = `
if redis.call('SETNX', KEYS[1], ARGV[1]) == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
else
  return 0
end
`;

// Lua: idempotency reserve-or-return existing
const IDEM_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
return ARGV[1]
`;

async function loadScripts() {
  const [lockSha, idemSha] = await Promise.all([
    redis.script("LOAD", LOCK_SCRIPT),
    redis.script("LOAD", IDEM_SCRIPT),
  ]);
  return { lockSha, idemSha };
}

// Safe eval: tries EVALSHA, falls back to EVAL on NOSCRIPT
async function safeEval(sha, script, keys = [], args = []) {
  try {
    return await redis.evalsha(sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (String(err && err.message).includes("NOSCRIPT")) {
      return await redis.eval(script, keys.length, ...keys, ...args);
    }
    throw err;
  }
}

module.exports = { loadScripts, safeEval, LOCK_SCRIPT, IDEM_SCRIPT };
```

---

## 4) services/rideService.js — Create (idempotent) & Accept (atomic)

```js
// services/rideService.js
const crypto = require("crypto");
const mongoose = require("mongoose");
const redis = require("../lib/redis");
const { safeEval, LOCK_SCRIPT, IDEM_SCRIPT } = require("../lib/lua");
const Ride = require("../models/Ride");

// In-memory SHAs loaded at app start
let SHAS = { lock: null, idem: null };
function setShas({ lockSha, idemSha }) { SHAS.lock = lockSha; SHAS.idem = idemSha; }

// --- Fare calc placeholder (replace with your real logic) ---
function calcEstimatedFare(pickup, dropoff) {
  // Example: base 50 + per-km 10 + per-min 2 (dummy ETA)
  const distanceKm = 5; // TODO: haversine or routing engine
  const minutes = 12;   // TODO: ETA engine
  return 50 + distanceKm * 10 + minutes * 2;
}

// --- Create ride with idempotency (Redis-first) ---
async function createRide({ riderId, pickup, dropoff, idemKey }) {
  if (!idemKey) idemKey = crypto.randomUUID();

  // Pre-generate ObjectId so retries can reference the same rideId
  const rideId = new mongoose.Types.ObjectId().toString();

  const key = `idem:ride:${idemKey}`;

  // Reserve or return existing rideId (TTL 15m)
  const idemVal = await safeEval(
    SHAS.idem,
    IDEM_SCRIPT,
    [key],
    [rideId, 900]
  );

  if (idemVal !== rideId) {
    // Duplicate; return existing (may still be inserting, so handle null carefully)
    const existing = await Ride.findById(idemVal).lean();
    return { ride: existing, idemKey };
  }

  // First time → persist to Mongo
  try {
    const ride = await Ride.create({
      _id: rideId,
      riderId,
      pickup,
      dropoff,
      estimatedFare: calcEstimatedFare(pickup, dropoff),
      status: "requested",
      idemKey,
      requestedAt: new Date(),
    });
    return { ride: ride.toObject(), idemKey };
  } catch (e) {
    // Roll back reservation so client can retry cleanly
    await redis.del(key);
    throw e;
  }
}

// --- Driver accepts: Redis lock + Mongo conditional update ---
async function acceptRide({ rideId, driverId }) {
  const lockKey = `lock:ride:${rideId}`;

  // Acquire lock (15s)
  const locked = await safeEval(
    SHAS.lock,
    LOCK_SCRIPT,
    [lockKey],
    [driverId, 15000]
  );

  if (Number(locked) !== 1) {
    throw new Error("Ride already locked by another driver");
  }

  // Finalize in Mongo (first-accept-wins)
  const ride = await Ride.findOneAndUpdate(
    { _id: rideId, status: "requested" },
    { $set: { driverId, status: "accepted", acceptedAt: new Date() } },
    { new: true }
  ).lean();

  if (!ride) {
    // Either already accepted/cancelled or ride doesn't exist
    throw new Error("Ride already accepted or not found");
  }

  return ride;
}

module.exports = { createRide, acceptRide, setShas };
```

---

## 5) routes/rides.js — HTTP API (Express)

```js
// routes/rides.js
const express = require("express");
const { createRide, acceptRide } = require("../services/rideService");

const router = express.Router();

// Create ride (idempotent)
router.post("/request", async (req, res) => {
  try {
    const { riderId, pickup, dropoff } = req.body;
    const idemKey = req.header("x-idempotency-key") || req.body.idemKey;

    const { ride, idemKey: returnedKey } = await createRide({
      riderId,
      pickup,
      dropoff,
      idemKey,
    });

    if (!ride) return res.status(202).json({ status: "pending", idemKey: returnedKey });
    res.json({ rideId: ride._id, status: ride.status, idemKey: returnedKey, estimatedFare: ride.estimatedFare });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Driver accepts ride (first-accept-wins)
router.post("/:rideId/accept", async (req, res) => {
  try {
    const ride = await acceptRide({ rideId: req.params.rideId, driverId: req.body.driverId });
    res.json({ rideId: ride._id, status: ride.status, driverId: ride.driverId, acceptedAt: ride.acceptedAt });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

module.exports = router;
```

---

## 6) app.js — Bootstrap (deterministic init)

```js
// app.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const ridesRouter = require("./routes/rides");
const { loadScripts } = require("./lib/lua");
const { setShas } = require("./services/rideService");

async function bootstrap() {
  // Mongo
  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 200,
    minPoolSize: 10,
    retryWrites: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 20000,
  });
  console.log("✅ Mongo connected");

  // Redis Lua scripts
  const { lockSha, idemSha } = await loadScripts();
  setShas({ lockSha, idemSha });
  console.log("✅ Redis Lua scripts loaded");

  // Express app
  const app = express();
  app.use(express.json());
  app.use("/rides", ridesRouter);

  return app;
}

module.exports = bootstrap;
```

---

## 7) server.js — Start HTTP Server

```js
// server.js
const bootstrap = require("./app");

(async () => {
  const app = await bootstrap();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`🚖 Ride service running on :${port}`));
})();
```

---

## 8) MongoDB Sharding — Commands (run once in mongosh)

```js
use uber_clone
sh.enableSharding("uber_clone")
sh.shardCollection("uber_clone.rides", { _id: "hashed" })
```

**Indexes are in the schema**; ensure they’re created after sharding is enabled (Mongoose will create them on startup). For production, manage indexes explicitly with migrations.

---

## 9) REST Testing (cURL)

```bash
# Create ride (idempotent). Repeat the same idem key to test dedupe
curl -s -X POST http://localhost:3000/rides/request \
  -H 'Content-Type: application/json' \
  -H 'x-idempotency-key: 11111111-1111-4111-8111-111111111111' \
  -d '{
    "riderId": "66c7a4e7f96c9e6b2f6d1111",
    "pickup": {"lat":40.73,"lng":-74.00,"address":"SoHo"},
    "dropoff": {"lat":40.75,"lng":-73.99,"address":"Hudson Yards"}
  }' | jq

# Driver accepts (first-accept-wins). Try calling twice or with a second driverId
curl -s -X POST http://localhost:3000/rides/<RIDE_ID>/accept \
  -H 'Content-Type: application/json' \
  -d '{"driverId":"66c7a4e7f96c9e6b2f6d2222"}' | jq
```

---

## 10) Scalability & Performance Notes

- **Redis first**: idempotency + locks in Redis avoid DB overload.
- **TTL strategy**: `idem:ride:*` 15m, `lock:ride:*` 10–15s. All hot keys must expire.
- **Retry safety**: `safeEval` auto-falls back to `EVAL` on `NOSCRIPT` after Redis restart.
- **Mongo writes**: keep documents small (avoid growing arrays); cap any arrays with `$push + $slice`.
- **Pool sizing**: Node → Mongo pool `200` is a good start; tune with load tests.
- **Observability**: instrument p95/p99 for Redis eval and Mongo `findOneAndUpdate` latency.
- **Sharding**: `_id: hashed` yields uniform write distribution—perfect if your hot queries are by `_id`, `driverId+status`, `riderId`.

---

## 11) Optional: Redis 7 Functions (no SHA juggling)

If you run Redis 7+, you can register functions once and invoke by name.

```lua
-- redis-cli (example module named 'ride')
FUNCTION LOAD LUA "\
redis.register_function('lock_ride', function(keys, args) \
  if redis.call('SETNX', keys[1], args[1]) == 1 then \
    redis.call('PEXPIRE', keys[1], args[2]); return 1 \
  else return 0 end \
end) \
redis.register_function('idem_ride', function(keys, args) \
  local v = redis.call('GET', keys[1]); \
  if v then return v end; \
  redis.call('SET', keys[1], args[1], 'EX', args[2], 'NX'); \
  return args[1] \
end)" REPLACE
```

Then call via ioredis `fcall('lock_ride', 1, key, driverId, ttl)`.

---

## 12) What’s Next?

- Add **Socket.IO** to notify riders/drivers on state changes.
- Add **Redis GEO** for driver discovery (tiles + GEOSEARCH).
- Move pricing to a dedicated microservice if logic grows (surge, promos, taxes).
- Add **Streams** or Kafka to queue ride requests + audit trail.

---

**Done.** This single markdown captures the core files and logic for a high-scale ride service using Mongoose + ioredis with safe Lua handling and hashed sharding. Copy, paste, and extend. 🚀

