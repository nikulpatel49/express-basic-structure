
# 🚖 Ultra-Scalable Cab Service Backend with Node.js, Redis Cluster, Google S2 & Socket.IO

This guide covers an **ultra-pro-level architecture** to handle **20M concurrent connections** in a real-time cab matching service using:
- ⚙️ Node.js
- 📍 Google S2 for geolocation sharding
- 🧠 Redis Cluster for fast driver lookups
- 🔌 Socket.IO for real-time communication

---

## 📁 Project Structure

```
cab-service/
├── src/
│   ├── config/
│   │   └── redis.ts
│   ├── libs/
│   │   └── s2.ts
│   ├── services/
│   │   ├── driverGeo.service.ts
│   │   └── matching.service.ts
│   ├── sockets/
│   │   └── index.ts
│   └── server.ts
├── package.json
└── tsconfig.json
```

---

## 1️⃣ `config/redis.ts` — Redis Cluster Connection

```ts
import Redis from 'ioredis';

const redis = new Redis.Cluster([
  { host: 'redis-node-1', port: 6379 },
  { host: 'redis-node-2', port: 6379 },
  { host: 'redis-node-3', port: 6379 },
], {
  slotsRefreshTimeout: 2000,
  redisOptions: {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
  },
});

export default redis;
```

✅ **Tips**:
- Use consistent DNS/SRV records for redis nodes
- Disable offline queue to avoid memory leaks on pressure

---

## 2️⃣ `libs/s2.ts` — Google S2 Helpers

```ts
import S2 from 's2-geometry';

export function getS2CellId(lat: number, lng: number, level = 14): string {
  return S2.latLngToKey(lat, lng, level);
}

export function getNeighborCellIds(cellId: string): string[] {
  const neighbors = S2.latLngNeighbors(cellId);
  return neighbors;
}
```

✅ **Tricks**:
- Use S2 level 14 for cities, 12 for rural zones
- Only keep S2 token short for performance

---

## 3️⃣ `services/driverGeo.service.ts` — Driver Location Caching

```ts
import redis from '../config/redis';
import { getS2CellId } from '../libs/s2';

export async function updateDriverLocation(driverId: string, lat: number, lng: number, carType = 'sedan') {
  const s2Token = getS2CellId(lat, lng);
  const key = `geo:cell:{${s2Token}}:${carType}`;
  await redis.zadd(key, Date.now(), driverId);
  await redis.expire(key, 60);
}
```

✅ **Tips**:
- Set 1-min expiry per key to auto-clean stale data
- Use ZSETs with timestamps as scores for time-based queries

---

## 4️⃣ `services/matching.service.ts` — Driver Matching Logic

```ts
import redis from '../config/redis';
import { getS2CellId, getNeighborCellIds } from '../libs/s2';

export async function findNearbyDrivers(lat: number, lng: number, carType = 'sedan'): Promise<string[]> {
  const centerCell = getS2CellId(lat, lng);
  const cells = [centerCell, ...getNeighborCellIds(centerCell)];
  const now = Date.now();
  const cutoff = now - 60000;

  const pipeline = redis.pipeline();
  for (const cell of cells) {
    const key = `geo:cell:{${cell}}:${carType}`;
    pipeline.zrangebyscore(key, cutoff, now);
  }

  const results = await pipeline.exec();
  const drivers = results.flatMap(res => res[1] || []);
  return Array.from(new Set(drivers));
}
```

✅ **Tips**:
- Use `.pipeline()` to reduce round trips
- Deduplicate driver IDs across neighbor cells

---

## 5️⃣ `sockets/index.ts` — Socket.IO with Redis Adapter

```ts
import { Server } from 'socket.io';
import http from 'http';
import redisAdapter from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { updateDriverLocation } from '../services/driverGeo.service';
import { findNearbyDrivers } from '../services/matching.service';

export function initSocket(server: http.Server) {
  const io = new Server(server, { cors: { origin: '*' } });

  const pubClient = createClient({ url: 'redis://redis-pub:6379' });
  const subClient = pubClient.duplicate();

  Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    io.adapter(redisAdapter(pubClient, subClient));
  });

  io.on('connection', socket => {
    socket.on('driver_location', async (data) => {
      const { driverId, lat, lng, carType } = data;
      await updateDriverLocation(driverId, lat, lng, carType);
    });

    socket.on('request_ride', async ({ lat, lng, carType }, cb) => {
      const drivers = await findNearbyDrivers(lat, lng, carType);
      cb(drivers);
    });
  });
}
```

✅ **Tips**:
- Use Socket.IO Redis Adapter for multi-instance scalability
- Always validate inputs

---

## 6️⃣ `server.ts` — Server Entry

```ts
import http from 'http';
import express from 'express';
import { initSocket } from './sockets';

const app = express();
const server = http.createServer(app);

initSocket(server);

app.get('/', (_, res) => res.send('Cab Service Running...'));

server.listen(3000, () => {
  console.log('🚕 Server running on port 3000');
});
```

---

## 🧪 Redis Slot Debugging Helper

```ts
import { createHash } from 'crypto';

function redisSlot(key: string): number {
  const hash = crc16(key); // Install node-crc16
  return hash % 16384;
}

console.log(redisSlot('geo:cell:{xyz123}:sedan'));
```

✅ **Tip**:
- Use `{slot}` pattern to group keys in same hash slot across cluster nodes

---

Let me know if you want:
- Docker Compose for Redis Cluster
- Driver/passenger simulation script
- Monitoring dashboard integration
