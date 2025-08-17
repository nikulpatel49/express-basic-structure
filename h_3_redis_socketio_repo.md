# H3 + Redis + Socket.IO — Production Boilerplate Repo

This single Markdown file contains the full production-ready repo contents for the ultra-pro H3 + Redis + Socket.IO driver location & nearby-search system (New Jersey / large metro focus). Copy each section into files in a repo and follow the README to run.

---

## 1) `package.json`

```json
{
  "name": "h3-redis-socketio-prod",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon --watch src --exec node src/server.js",
    "precompute": "node src/precompute.js",
    "bench": "node src/benchmark.js",
    "lint": "eslint . --ext .js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.8.1",
    "ioredis": "^5.3.2",
    "h3-js": "^4.1.0",
    "nanoid": "^4.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.22",
    "eslint": "^8.40.0"
  }
}
```

---

## 2) `.env.example`

```
# Redis
REDIS_URL=redis://127.0.0.1:6379
REDIS_CLUSTER=0

# App
PORT=3000
H3_RES=9
HOT_H3_RES=10
BUCKET_TTL_SEC=180
CHUNK_SIZE=300
MAX_K=4
EDGE_CACHE_MS=200

# Region/City (for precompute bounds if needed)
CITY_NAME=New_Jersey_Metro
CITY_BOUNDS_JSON=./data/nj-bounds.json
```

---

## 3) `src/config.js`

```js
import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  REDIS_CLUSTER: Number(process.env.REDIS_CLUSTER || 0),
  PORT: Number(process.env.PORT || 3000),
  H3_RES: Number(process.env.H3_RES || 9),
  HOT_H3_RES: Number(process.env.HOT_H3_RES || 10),
  MAX_K: Number(process.env.MAX_K || 4),
  BUCKET_TTL_SEC: Number(process.env.BUCKET_TTL_SEC || 180),
  CHUNK_SIZE: Number(process.env.CHUNK_SIZE || 300),
  DRIVER_UPDATE_RATE_PER_SEC: 2,
  EDGE_CACHE_MS: Number(process.env.EDGE_CACHE_MS || 200)
};
```

---

## 4) `src/redis.js`

```js
import Redis from 'ioredis';
import { CONFIG } from './config.js';

const isCluster = CONFIG.REDIS_CLUSTER === 1 || CONFIG.REDIS_CLUSTER === true;

export const redis = isCluster
  ? new Redis.Cluster([/* configure cluster nodes via env or config */], { redisOptions: { enableAutoPipelining: true } })
  : new Redis(CONFIG.REDIS_URL, { enableAutoPipelining: true });

export const pub = redis.duplicate();
export const sub = redis.duplicate();

export const pipeline = () => redis.pipeline();

redis.on('error', (err) => console.error('Redis error', err));
redis.on('connect', () => console.log('Redis connected'));
```

---

## 5) `src/h3.js`

```js
import * as h3 from 'h3-js';
import { CONFIG } from './config.js';

export const RES9 = CONFIG.H3_RES;
export const RES10 = CONFIG.HOT_H3_RES;

export function latLngToCell(lat, lng, res = RES9) {
  return h3.latLngToCell(lat, lng, res);
}

export function gridDisk(cell, k) {
  return h3.gridDisk(cell, k);
}

export function cellToLatLng(cell) {
  return h3.cellToLatLng(cell);
}

// compute centroid distance helper
export function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}
```

---

## 6) `lua/union.lua`

```lua
-- union.lua
-- KEYS: minute bucket keys (same hash-tag slot)
-- ARGV[1]: maxReturn
local maxR = tonumber(ARGV[1]) or 500
local tmp = {}
for i=1,#KEYS do
  local members = redis.call('SMEMBERS', KEYS[i])
  for _,m in ipairs(members) do tmp[m] = true end
end
local out = {}
local c = 0
for id,_ in pairs(tmp) do
  table.insert(out, id)
  c = c + 1
  if c >= maxR then break end
end
return out
```

---

## 7) `src/driverIndex.js`

```js
import fs from 'fs';
import { redis } from './redis.js';
import { latLngToCell } from './h3.js';
import { CONFIG } from './config.js';

const luaScript = fs.readFileSync(new URL('../lua/union.lua', import.meta.url));
const luaShaPromise = redis.script('load', luaScript.toString());

function minuteKeyFor(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${y}${m}${d}${hh}${mm}`;
}

function bucketKey(cell, car, mm) {
  return `C:{${cell}|${car}}:${mm}`; // hash-tag ensures same slot per cell+car
}

export async function updateDriver({ id, lat, lng, car = 'any', status = 'online', ts = Date.now() }) {
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, reason: 'bad_coords' };
  const cell = latLngToCell(lat, lng, CONFIG.H3_RES);
  const mm = minuteKeyFor();
  const bKey = bucketKey(cell, car, mm);
  const dKey = `D:${id}`;
  const pipe = redis.pipeline();
  pipe.hset(dKey, 'lt', Math.round(lat * 1e6), 'lg', Math.round(lng * 1e6), 'c9', cell, 'ct', car, 'ls', ts);
  pipe.sadd(bKey, id);
  pipe.expire(bKey, CONFIG.BUCKET_TTL_SEC);
  const bAny = bucketKey(cell, 'any', mm);
  pipe.sadd(bAny, id);
  pipe.expire(bAny, CONFIG.BUCKET_TTL_SEC);
  await pipe.exec();
  return { ok: true, cell };
}

export async function luaUnion(keys, maxReturn = 500) {
  const sha = await luaShaPromise;
  try {
    return await redis.evalsha(sha, keys.length, ...keys, String(maxReturn));
  } catch (e) {
    return await redis.sunion(...keys);
  }
}

export async function membersForCell(cell, car, maxReturn = 500) {
  const now = new Date();
  const mmNow = minuteKeyFor(now);
  const mmPrev = minuteKeyFor(new Date(now.getTime() - 60_000));
  const k1 = bucketKey(cell, car, mmNow);
  const k2 = bucketKey(cell, car, mmPrev);
  const ids = await luaUnion([k1, k2], maxReturn);
  return ids || [];
}

export async function fetchDrivers(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += CONFIG.CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CONFIG.CHUNK_SIZE);
    const pipe = redis.pipeline();
    chunk.forEach((id) => pipe.hgetall(`D:${id}`));
    const res = await pipe.exec();
    for (let j = 0; j < res.length; j++) {
      const [, d] = res[j];
      if (d && d.lt) out.push({ id: chunk[j], lt: Number(d.lt) / 1e6, lg: Number(d.lg) / 1e6, ct: d.ct, ls: Number(d.ls) });
    }
  }
  return out;
}
```

---

## 8) `src/server.js`

```js
import http from 'http';
import express from 'express';
import { attachSocket } from './socket.js';
import { updateDriver, membersForCell, fetchDrivers } from './driverIndex.js';
import { CONFIG } from './config.js';

const app = express();
app.use(express.json());

app.post('/driver/location', async (req, res) => {
  try {
    const out = await updateDriver(req.body);
    res.json(out);
  } catch (e) {
    console.error('driver update error', e);
    res.status(500).json({ ok: false });
  }
});

app.get('/rider/search', async (req, res) => {
  try {
    const { lat, lng, car = 'any', limit = 30 } = req.query;
    if (!lat || !lng) return res.status(400).json({ ok: false, reason: 'missing_coords' });
    const h3 = (await import('./h3.js')).latLngToCell;
    const origin = h3(Number(lat), Number(lng));

    // get candidate ids from origin cell (bounded)
    const ids = await membersForCell(origin, car, 1500);
    const drivers = await fetchDrivers(ids.slice(0, 1000));

    const hav = (aLat, aLng, bLat, bLng) => {
      const R = 6371000; const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(bLat - aLat); const dLng = toRad(bLng - aLng);
      const s1 = Math.sin(dLat / 2); const s2 = Math.sin(dLng / 2);
      const c = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
    };

    const list = drivers.map(d => ({ ...d, dist: hav(Number(lat), Number(lng), d.lt, d.lg) })).sort((a, b) => a.dist - b.dist).slice(0, Number(limit));
    res.json({ ok: true, drivers: list });
  } catch (e) {
    console.error('search error', e);
    res.status(500).json({ ok: false });
  }
});

const server = http.createServer(app);
attachSocket(server).then(() => {
  server.listen(CONFIG.PORT, () => console.log(`listening ${CONFIG.PORT}`));
});
```

---

## 9) `src/socket.js`

```js
import { Server } from 'socket.io';
import { pub, sub } from './redis.js';
import { updateDriver } from './driverIndex.js';
import { CONFIG } from './config.js';

export async function attachSocket(server) {
  const io = new Server(server, { transports: ['websocket', 'polling'], cors: { origin: '*' } });
  const { createAdapter } = await import('@socket.io/redis-adapter');
  io.adapter(createAdapter(pub, sub));

  io.on('connection', (socket) => {
    socket.on('driver:location', async (payload, cb) => {
      try {
        // server-side basic throttling and validation can go here
        const out = await updateDriver(payload);
        cb?.(out);
      } catch (e) {
        console.error('driver:location err', e);
        cb?.({ ok: false });
      }
    });

    socket.on('rider:search', async (payload, cb) => {
      // For demo, we rely on REST endpoint. For lower latency, call internal functions.
      cb?.({ ok: true });
    });
  });

  return io;
}
```

---

## 10) `src/precompute.js`

```js
// For production: precompute ring arrays and cell centroid distances for the city boundary.
// This demo file shows a simple on-demand cache approach.
import * as h3 from 'h3-js';
import fs from 'fs';

const cache = new Map();
export function getRings(cell, maxK) {
  const key = `${cell}:${maxK}`;
  if (cache.has(key)) return cache.get(key);
  const arr = [];
  for (let k = 0; k <= maxK; k++) arr.push(h3.gridDisk(cell, k));
  cache.set(key, arr);
  return arr;
}

console.log('Precompute module loaded — runtime caching active');
```

---

## 11) `src/benchmark.js`

```js
import fetch from 'node-fetch';

const BASE = `http://localhost:${process.env.PORT || 3000}`;

async function seedDrivers(n = 5000) {
  const promises = [];
  for (let i = 0; i < n; i++) {
    const lat = 40.7 + Math.random() * 0.3; const lng = -74.2 + Math.random() * 0.4;
    promises.push(fetch(BASE + '/driver/location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'd' + i, lat, lng, car: 'sedan' }) }));
    if (promises.length >= 200) { await Promise.all(promises); promises.length = 0; }
  }
  console.log('seeded drivers');
}

async function searchOnce() {
  const lat = 40.75; const lng = -74.0;
  const r = await fetch(BASE + `/rider/search?lat=${lat}&lng=${lng}&limit=30`);
  const j = await r.json();
  console.log('found', j.drivers?.length || 0);
}

(async () => {
  await seedDrivers(20000);
  for (let i = 0; i < 10; i++) { await searchOnce(); }
})();
```

---

## 12) `Dockerfile`

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY src ./src
COPY lua ./lua
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
```

---

## 13) `docker-compose.yml`

```yaml
version: '3.8'
services:
  redis:
    image: redis:7
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    ports:
      - '6379:6379'
    volumes:
      - redis-data:/data

  app:
    build: .
    environment:
      - REDIS_URL=redis://redis:6379
      - PORT=3000
    ports:
      - '3000:3000'
    depends_on:
      - redis

volumes:
  redis-data:
```

---

## 14) `README.md`

```md
# H3 + Redis + Socket.IO — Production Boilerplate (NJ Metro)

This repo demonstrates a production-ready blueprint for driver location indexing and nearby search using H3 + Redis + Socket.IO. It contains a demo server, Lua union script, and a small benchmark.

## Quick start (local)

1. Copy files into a directory.
2. Create `.env` from `.env.example` and tune values.
3. Start with Docker Compose (recommended for local testing):

```bash
docker compose up --build
```

4. Seed drivers and run benchmark:

```bash
npm run bench
```

## Production notes
- Use Redis Cluster with 6–24 primaries depending on traffic.
- Ensure hash-tag key scheme stays consistent when moving to cluster (so unions are slot-safe).
- Load precomputed ring lists and cell centroids on boot for lower CPU usage.
- Implement auth on Socket.IO connect and validate driver ownership of driverId.

## Scaling & tuning
- Use Lua script (lua/union.lua) to perform limited unions server-side to reduce data movement.
- Enable RES10 for hotspot cells only.
- Add local edge cache (100–300ms) for popular pickup points.
- Monitor Redis slowlog, SUNION frequency, and top cell sizes.
```

---

## 15) Notes & Next Steps
- This bundle is intentionally opinionated toward a single-city, high-density setup (New Jersey / NYC metro). For multi-city, add region prefixes and separate clusters.
- Want me to also generate the ZIP file for download (with these files pre-populated), or commit this to a GitHub gist or repo for you? Let me know which and I’ll produce it next.

---

*End of file.*

