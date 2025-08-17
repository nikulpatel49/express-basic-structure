# Ultra‑Pro @ 20M Concurrent: Redis + Socket.IO + Node.js + H3

**Objective:** Architect and implement a ride‑hailing location platform that can handle **20 million concurrent drivers/riders** with **<100 ms P95 nearby-search latency** in dense metros, and **sub‑second end‑to‑end location freshness**.

---

## 0) Big‑Picture Goals & SLOs

- **Freshness SLO:** driver last update ≤ **2 s**; index lag ≤ **1 s**.
- **Search SLO:** P95 **<100 ms** for 0–3 km search; P99 **<250 ms**.
- **Availability:** 99.99% for search & updates.
- **Cost:** Stay CPU bound, not network bound; predictable Redis & egress.

**Assumptions**

- Peak **20M active sockets** (drivers + riders) across regions.
- Driver updates up to **2 Hz** (server-side throttled).
- Typical rider queries 0.5–1.0 Hz during trip/booking.

---

## 1) Architecture Overview

```
Mobile ↔ LB (NLB/ALB WS) ↔ Socket Layer (Node/uWebSockets.js + Socket.IO) ↔ Redis Cluster (hot path)
                                                         ↘ Kafka (analytics, cold path)
                                                          ↘ OLAP/ClickHouse (metrics)
```

**Why this split?**

- **Hot path (Redis)**: sub‑ms ops for location indexing & search.
- **Cold/async (Kafka/OLAP)**: geo heatmaps, long‑term stats, ML features.

**Core building blocks**

- **H3** to discretize earth into hex cells (resolution tuned per city).
- **Time‑bucketed, auto‑expiring per‑cell sets** in Redis.
- **Socket.IO + redis‑adapter** for fan‑in/out across instances.
- **Strict cross‑slot‑free key design** for Redis Cluster.

---

## 2) H3 Strategy (Resolution & Ring Expansion)

- Start with **H3 res=9** (\~174 m avg edge‑to‑edge; city‑friendly).
- Dense cores can use **dual‑indexing** (res=10) kept only for hot zones.
- Query expands as **ring K=0→6** (configurable) until enough candidates.
- Optional **hard radius** (e.g., 3 km) to filter results post‑fetch.

**Rule of thumb**

- Res 9: \~**2–3 city blocks**;
- Each +1 res → \~¼ cell area; doubles cell count; increases index ops.
- Always cap **K** to avoid pathological expansion in sparse areas.

---

## 3) Redis Keyspace Design (Cluster‑Safe & SUNION Optimization)

### 3.1 Baseline (simple & robust)

- Driver hash: `drv:{driverId}` → `HSET lat,lng,cell,car,status,lastSeen`
- Per‑cell per‑minute set: `cell:{cellId}:{car}:{YYYYMMDDHHmm}` → `SADD driverId`, `EXPIRE 180`
- **Search** reads **current + previous minute** buckets to treat recent drivers as alive.

Pros: zero cross‑slot ops (we fetch & merge client‑side). Cons: more network round trips.

### 3.2 Advanced (same‑slot minute unions)

To enable **server‑side SUNION** of the 2–3 minute buckets **within a single hash slot**, encode a **stable hash‑tag** in braces:

- `c:{cellId|car}:{mm}` where `{cellId|car}` is the hash‑tag (stays constant across minutes).
- Example keys for the same cell/car in two minutes share a slot:
  - `c:{89283082b3fffff|sedan}:202508171205`
  - `c:{89283082b3fffff|sedan}:202508171206`

**Pattern**

- Minute buckets (TTL 180 s): `SADD c:{cell|car}:{mm} driverId`
- On search per cell: `SUNIONSTORE tmp:{cell|car}:{reqId} c:{cell|car}:{mmNow} c:{cell|car}:{mmPrev}` then `SMEMBERS tmp:*` and `EXPIRE tmp:* 1s`.

> This reduces client merges by **\~2–3×**, keeps Redis work single‑slot. Never union across different cells (would break slot).

### 3.3 Optional: Per‑cell small sorted set for recency

If you need strict recency inside the cell: maintain `ZADD cz:{cell|car} ts driverId` (TTL or periodic trim). Usually not needed if minute buckets suffice.

---

## 4) Write Path (Driver Update)

**Throttle & sanitize**

- Limit to **≤2 updates/sec/driver** (Redis incr+expire counter).
- Clamp impossible jumps: drop updates if speed > 60 m/s (configurable).
- Guard rails: lat ∈ [−90, 90], lng ∈ [−180, 180].

**Flow**

1. Compute H3 cell (res 9).
2. `HSET drv:{id}` with `{lat,lng,cell,car,status,lastSeen}`.
3. Compute minute bucket key and `SADD` driver to `c:{cell|car}:{mm}` with `EXPIRE` (180s).
4. (Optional) Also index into `car=any` bucket for broad searches.

**Idempotency**

- Only accept update if `ts >= lastSeen` (reject out‑of‑order). Store client/server ts.

**Reduced RTT**

- Use **pipelining** for HSET+SADD+EXPIRE.
- Batch by socket: combine multiple drivers only on server ingest streams (e.g., GRPC/HTTP batch from gateways).

---

## 5) Read Path (Nearby Search)

**Algorithm**

1. Identify origin cell.
2. For k = 0..K:
   - List ring cells via `gridDisk`.
   - For each cell: **(fast path)** `SUNIONSTORE` current+prev minutes into a temp key (same slot) → `SMEMBERS`.
   - Dedup driverIds within request (Set in app).
   - Fetch driver hashes in **chunks of 200–500** via pipeline `HGETALL`.
   - Compute haversine; push if `distance ≤ maxMeters`.
   - Early stop when results ≥ `limit`.
3. Sort by distance, return top N.

**Optimizations**

- Maintain a small **Bloom filter** per request to skip duplicates early.
- Cache geodesic computations for same cell center using pre‑computed cell center lat/lng (micro‑opt).
- Adaptive K: if ring 0 returns >limit×2, stop at k=0 and sort.

**Memory & CPU**

- Keep driver hash minimal (floats as strings). Consider compressing field names (`lt, lg, c, ct, ls`).

---

## 6) Socket Layer @ 20M

### 6.1 Runtime

- **Node 20+**, **uWebSockets.js** transport for Engine.IO (via `@socket.io/uws`).
- **Socket.IO Adapter:** `@socket.io/redis-adapter` with **ioredis** duplicates.
- **Max Payload**: keep < 2 KB per event.

### 6.2 Process Model

- **Per AZ shard**: 200–500 pods/instances; \~40–100k sockets per instance (tune by NIC/CPU).
- Disable Node cluster; prefer **many single‑threaded pods** for isolation. Horizontal scale via K8s HPA.

### 6.3 Load Balancer (AWS)

- Prefer **NLB** (TCP/WebSocket) with idle timeout ≥ **350 s**.
- If ALB: set WS idle ≥ **400 s**, enable sticky (IP hash) if needed.
- Health checks: 10 s interval, 3 healthy threshold.

### 6.4 Engine.IO/Socket.IO Tuning

- `pingInterval=15_000`, `pingTimeout=30_000`.
- `perMessageDeflate: { threshold: 1024 }`.
- Backpressure: drop/merge redundant `driver:location` within 200 ms window.

### 6.5 Fanout Choices

- **Do NOT** use Kafka for real‑time socket fanout (adds \~10–50 ms). Use Redis adapter for instances only.
- Use **Kafka** for async analytics, fraud, surge, ETA modeling.

---

## 7) Capacity Planning (Order‑of‑Magnitude)

### 7.1 Key counts

- 20M drivers online, 2‑minute retention → up to **2 minute buckets** per cell.
- Assume avg **60 drivers/cell** at res 9 in dense cores, <5 in suburbs.
- Minute buckets per city cell active \~50% of time.

### 7.2 Memory per driver (hot path)

- Driver hash (compact): \~80–120 B (fields + overhead) → **\~2.4 GB** for 20M.
- Set membership overhead: \~50–70 B per entry × 1–2 buckets → **\~1.5–2.8 GB**.
- Temp SUNION keys: ephemeral, keep under 1% of RAM with 1 s TTL.
- **Total Redis hot path** per region: plan **8–12 GB** (excluding replicas) + headroom ×3.

### 7.3 Redis Cluster Topology

- **12–24 primary shards** (hash slots evenly), each 32–64 GB RAM nodes.
- **Replica 1:1** with `min-replicas-to-write=1`.
- **Client‑side routing** via ioredis Cluster; keep TCP keepalives.

---

## 8) Security & Integrity

- **Auth** on connect (JWT), map `socket.data.userId/driverId`.
- **Replay/out‑of‑order**: compare `ts >= lastSeen`.
- **Velocity caps** & geofence sanity.
- **Server‑side smoothing** (dead‑reckoning) for UI only; never index extrapolated coords.

---

## 9) Observability

- **RED metrics** (Rate, Errors, Duration) for: driver update, search ring steps, Redis RTT.
- Percentile SLIs per city; alarm at P95/P99 drift.
- **Cardinality control**: driverId labels via hashing.
- **TopK** heavy cells (H3) to spot hotspots.

---

## 10) Code — Production‑Ready Snippets

### 10.1 Key helpers (hash‑tag aware)

```js
const tag = (cell, car) => `{${cell}|${car}}`;
const minute = (d=new Date()) => d.toISOString().slice(0,16).replace(/[-:T]/g, ''); // YYYYMMDDHHmm

// minute bucket key
const bucketKey = (cell, car, mm) => `c:${tag(cell, car)}:${mm}`;
// temp key per request (short‑lived)
const tmpKey = (cell, car, reqId) => `t:${tag(cell, car)}:${reqId}`;
```

### 10.2 Update path (pipelined)

```js
async function updateDriver({id, lat, lng, car='any', status='online', ts=Date.now()}) {
  if (!await allowUpdate(id)) return {ok:false, reason:'rate_limited'};
  const cell = h3.latLngToCell(lat, lng, H3_RES);
  const mm = minute();
  const bKey = bucketKey(cell, car, mm);
  const dKey = `drv:${id}`;
  const pipe = redis.pipeline();
  pipe.hget(dKey, 'lastSeen');
  const [[, last]] = await pipe.exec();
  if (last && Number(last) > ts) return {ok:false, reason:'stale'};

  const p2 = redis.pipeline();
  p2.hset(dKey, {lt: lat, lg: lng, c: cell, ct: car, st: status, ls: ts});
  p2.sadd(bKey, id);
  p2.expire(bKey, 180);
  // also index into ANY vehicle bucket
  const bAny = bucketKey(cell, 'any', mm);
  p2.sadd(bAny, id); p2.expire(bAny, 180);
  await p2.exec();
  return {ok:true, cell};
}
```

### 10.3 Read path (server‑side SUNION when possible)

```js
async function membersForCell(cell, car) {
  const now = new Date();
  const mmNow = minute(now);
  const mmPrev = minute(new Date(now.getTime()-60_000));
  const reqId = Math.random().toString(36).slice(2);
  const tKey = tmpKey(cell, car, reqId);
  // single‑slot union → fast
  await redis.sunionstore(tKey, bucketKey(cell, car, mmNow), bucketKey(cell, car, mmPrev));
  await redis.expire(tKey, 1);
  const ids = await redis.smembers(tKey);
  return ids;
}
```

### 10.4 Rider search (adaptive rings, batched HGETALL)

```js
async function search({lat, lng, car='any', limit=50, maxMeters=3000}) {
  const origin = h3.latLngToCell(lat, lng, H3_RES);
  const seen = new Set();
  const results = [];

  for (let k=0; k<=MAX_K; k++) {
    const cells = h3.gridDisk(origin, k);
    // heuristic: prioritize cells by centroid distance from origin
    cells.sort((a,b)=>distCell(a, lat,lng)-distCell(b, lat,lng));

    for (const cell of cells) {
      const ids = await membersForCell(cell, car);
      const fresh = ids.filter(id=>!seen.has(id));
      fresh.forEach(id=>seen.add(id));
      // batched fetch
      for (let i=0; i<fresh.length; i+=300) {
        const chunk = fresh.slice(i, i+300);
        const pipe = redis.pipeline();
        chunk.forEach(id=>pipe.hgetall(`drv:${id}`));
        const rows = await pipe.exec();
        for (let j=0; j<rows.length; j++) {
          const [,d] = rows[j];
          if (!d || !d.lt) continue;
          const dd = haversine(lat,lng, +d.lt, +d.lg);
          if (dd<=maxMeters) results.push({id:chunk[j], lat:+d.lt, lng:+d.lg, car:d.ct, dist:dd, ls:+d.ls});
   
```
