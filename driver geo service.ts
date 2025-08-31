// driver_geo_service.ts
/**
 * Driver GEO service (no Lua, clean design)
 * ----------------------------------------------------
 * ✅ Update location every 5s
 * ✅ H3 sharding: 1 GEO key per H3 cell
 * ✅ Nearby search: H3 gridDisk + pipelined GEOSEARCH
 * ❌ No expiry subscriber (cleanup handled externally)
 */

import Redis from "ioredis";
import * as h3 from "h3-js";

// ---------------- Config ----------------
const H3_RES = Number(process.env.H3_RES || 8);
const LAST_SEEN_TTL_MS = Number(process.env.LAST_SEEN_TTL_MS || 30_000); // 30s TTL

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// ---------------- Helpers ----------------
const geoKeyForCell = (cell: string) => `geo:drivers:h3:${H3_RES}:${cell}`;
const driverLastSeenKey = (driverId: string) => `driver:lastSeen:${driverId}`;
const driverCellKey = (driverId: string) => `driver:cell:${driverId}`;

// ---------------- Update Location ----------------
export async function updateLocation(driverId: string, lat: number, lon: number) {
  const cell = h3.latLngToCell(lat, lon, H3_RES);
  const geoKey = geoKeyForCell(cell);

  const pipeline = redis.pipeline();
  pipeline.geoadd(geoKey, lon, lat, driverId);
  pipeline.set(driverCellKey(driverId), cell);
  pipeline.set(driverLastSeenKey(driverId), Date.now().toString(), "PX", LAST_SEEN_TTL_MS);
  await pipeline.exec();

  return { driverId, cell };
}


-----------------------------------------------------------------------------------------------------------------------------------------------------


  import Redis from "ioredis";
import * as h3 from "h3-js";

// ---------------- Config ----------------
const H3_RES = Number(process.env.H3_RES || 8);
const LAST_SEEN_TTL_MS = Number(process.env.LAST_SEEN_TTL_MS || 30_000); // 30s TTL
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new Redis(REDIS_URL);

// ---------------- Key helpers ----------------
const geoKeyForCell = (cell: string) => `geo:drivers:h3:${H3_RES}:${cell}`;
const driverMetaKey = (driverId: string) => `driver:meta:${driverId}`;

// ---------------- Public API ----------------
/**
 * Update a driver's location.
 * - Stores geo position in geo:H3 cell (GEOADD)
 * - Updates driver:meta:{driverId} hash with { cell, lastSeen }
 * - Sets PEXPIRE on driver meta
 */
export async function updateLocation(driverId: string, lat: number, lon: number) {
  const cell = h3.latLngToCell(lat, lon, H3_RES);
  const geoKey = geoKeyForCell(cell);

  // read previous cell from hash
  const prevCell = await redis.hget(driverMetaKey(driverId), "cell");

  const pipeline = redis.pipeline();

  // Remove from previous cell (if moved)
  if (prevCell && prevCell !== cell) {
    const prevGeoKey = geoKeyForCell(prevCell);
    // use ZREM since GEOADD stores members in a sorted-set structure
    pipeline.zrem(prevGeoKey, driverId);
  }

  // Add to new cell
  pipeline.geoadd(geoKey, lon, lat, driverId);

  // Expire geo set if not touched (prevents zombie cells)
  pipeline.expire(geoKey, Math.ceil(LAST_SEEN_TTL_MS / 1000) + 5);

  // Store meta in a single hash and expire it
  pipeline.hset(driverMetaKey(driverId), {
    cell,
    lastSeen: Date.now().toString(),
  });
  pipeline.pexpire(driverMetaKey(driverId), LAST_SEEN_TTL_MS);

  await pipeline.exec();

  return { driverId, cell, moved: prevCell !== cell };
}

/**
 * Get full meta for a driver: { cell, lastSeen }
 */
export async function getDriverMeta(driverId: string) {
  const data = await redis.hgetall(driverMetaKey(driverId));
  if (!data || !data.cell) return null;
  return {
    cell: data.cell,
    lastSeen: data.lastSeen ? Number(data.lastSeen) : null,
  };
}

/** Get only the driver's cell */
export async function getDriverCell(driverId: string) {
  return await redis.hget(driverMetaKey(driverId), "cell");
}

/** Get only the driver's lastSeen timestamp (ms) */
export async function getDriverLastSeen(driverId: string) {
  const ts = await redis.hget(driverMetaKey(driverId), "lastSeen");
  return ts ? Number(ts) : null;
}

/** True if driver was active within LAST_SEEN_TTL_MS */
export async function isDriverActive(driverId: string): Promise<boolean> {
  const lastSeen = await getDriverLastSeen(driverId);
  if (!lastSeen) return false;
  return Date.now() - lastSeen <= LAST_SEEN_TTL_MS;
}

// ---------------- SCAN utility ----------------
async function* scanKeys(pattern: string, count = 100) {
  let cursor = "0";
  do {
    const [nextCursor, keys] = (await redis.scan(cursor, "MATCH", pattern, "COUNT", count)) as [
      string,
      string[]
    ];
    cursor = nextCursor;
    for (const key of keys) yield key;
  } while (cursor !== "0");
}

// ---------------- Cleanup ----------------
/**
 * Remove inactive drivers from a single geo cell.
 * Inactive criteria: missing meta OR lastSeen older than TTL.
 */
export async function cleanupGeoCell(cell: string) {
  const geoKey = geoKeyForCell(cell);

  // Get all drivers in this cell
  const drivers = await redis.zrange(geoKey, 0, -1);
  if (drivers.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const driverId of drivers) {
    pipeline.hget(driverMetaKey(driverId), "lastSeen");
  }
  const results = await pipeline.exec();

  const now = Date.now();
  const inactiveDrivers: string[] = [];

  drivers.forEach((driverId, i) => {
    const res = results[i];
    // results[i] is [err, value]
    const lastSeenStr = res ? res[1] : null;
    const lastSeen = lastSeenStr ? Number(lastSeenStr) : 0;

    if (!lastSeen || now - lastSeen > LAST_SEEN_TTL_MS) {
      inactiveDrivers.push(driverId);
    }
  });

  if (inactiveDrivers.length > 0) {
    await redis.zrem(geoKey, ...inactiveDrivers);
  }

  return inactiveDrivers.length;
}

/**
 * Iterate over all geo cells using SCAN and clean each cell.
 * batchSize controls SCAN COUNT.
 */
export async function cleanupAllGeoCells(batchSize = 100) {
  let removed = 0;
  for await (const key of scanKeys(`geo:drivers:h3:${H3_RES}:*`, batchSize)) {
    const cell = key.split(":").pop()!;
    try {
      removed += await cleanupGeoCell(cell);
    } catch (err) {
      // log and continue
      // eslint-disable-next-line no-console
      console.error(`cleanupGeoCell failed for ${cell}:`, err);
    }
  }
  return removed;
}

// ---------------- Convenience runner (optional) ----------------
/**
 * Start a background cleaner loop. Call this when booting a worker process.
 * Returns a function to stop the interval.
 */
export function startCleaner(options?: { intervalMs?: number; batchSize?: number }) {
  const intervalMs = options?.intervalMs ?? 10_000; // default 10s
  const batchSize = options?.batchSize ?? 200;

  let running = true;
  const handle = setInterval(async () => {
    if (!running) return;
    try {
      const removed = await cleanupAllGeoCells(batchSize);
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`🧹 Cleaned ${removed} zombie drivers`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Cleaner loop error:", err);
    }
  }, intervalMs);

  return () => {
    running = false;
    clearInterval(handle);
  };
}

// ---------------- Export default for convenience ----------------
export default {
  updateLocation,
  getDriverMeta,
  getDriverCell,
  getDriverLastSeen,
  isDriverActive,
  cleanupGeoCell,
  cleanupAllGeoCells,
  startCleaner,
};



  ---------------------------------------------------------------------------------------------------------------------------------------------------

// ---------------- Search Nearby ----------------
export async function searchNearby(lat: number, lon: number, radiusMeters: number, maxResults = 50) {
  const centerCell = h3.latLngToCell(lat, lon, H3_RES);

  const edgeLengthMeters = h3.edgeLength(H3_RES, h3.UNITS.m);
  const rings = Math.ceil(radiusMeters / edgeLengthMeters);
  const cells = h3.gridDisk(centerCell, rings);

  const pipeline = redis.pipeline();
  for (const cell of cells) {
    const geoKey = geoKeyForCell(cell);
    pipeline.send_command("GEOSEARCH", [
      geoKey,
      "FROMLONLAT",
      String(lon),
      String(lat),
      "BYRADIUS",
      String(radiusMeters),
      "m",
      "WITHDIST",
      "WITHCOORD",
      "ASC",
      "COUNT",
      String(maxResults),
    ]);
  }

  const rawResults = await pipeline.exec();

  const results = rawResults
    .filter(([err]) => !err)
    .flatMap(([_, value]) => value as [string, string, [string, string]][]);

  const merged = results
    .map(([id, dist, [lng, lat]]) => ({
      driverId: id,
      distance: parseFloat(dist),
      location: { lat: parseFloat(lat), lon: parseFloat(lng) },
    }))
    .sort((a, b) => a.distance - b.distance);

  const seen = new Set<string>();
  const unique = merged.filter((r) => {
    if (seen.has(r.driverId)) return false;
    seen.add(r.driverId);
    return true;
  });

  return unique.slice(0, maxResults);
}

// ---------------- Demo Run ----------------
if (require.main === module) {
  (async () => {
    await updateLocation("driver:demo1", 19.0760, 72.8777); // Mumbai
    await updateLocation("driver:demo2", 19.0896, 72.8656); // Mumbai nearby

    console.log("✅ Inserted demo drivers");

    const nearby = await searchNearby(19.0760, 72.8777, 3000, 10);
    console.log("🔍 Nearby drivers:", nearby);
  })();
}



============================================================================================


// driver_geo_service.ts
import Redis from "ioredis";
import * as h3 from "h3-js";
import cron from "node-cron";

// ---------------- Config ----------------
const H3_RES = Number(process.env.H3_RES || 8);
const LAST_SEEN_TTL_MS = Number(process.env.LAST_SEEN_TTL_MS || 30_000); // 30s TTL
const CLEANUP_BATCH_SIZE = 1000;

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const ACTIVE_DRIVERS_SET = "drivers:active";

// ---------------- Helpers ----------------
const geoKeyForCell = (cell: string) => `geo:drivers:h3:${H3_RES}:${cell}`;
const driverLastSeenKey = (driverId: string) => `driver:lastSeen:${driverId}`;
const driverCellKey = (driverId: string) => `driver:cell:${driverId}`;

// ---------------- Update Location ----------------
export async function updateLocation(driverId: string, lat: number, lon: number) {
  const cell = h3.latLngToCell(lat, lon, H3_RES);
  const geoKey = geoKeyForCell(cell);

  const pipeline = redis.pipeline();
  pipeline.geoadd(geoKey, lon, lat, driverId);
  pipeline.set(driverCellKey(driverId), cell);
  pipeline.set(driverLastSeenKey(driverId), Date.now().toString(), "PX", LAST_SEEN_TTL_MS);
  pipeline.sadd(ACTIVE_DRIVERS_SET, driverId); // track active drivers
  await pipeline.exec();

  return { driverId, cell };
}

// ---------------- Search Nearby ----------------
export async function searchNearby(lat: number, lon: number, radiusMeters: number, maxResults = 50) {
  const centerCell = h3.latLngToCell(lat, lon, H3_RES);
  const edgeLengthMeters = h3.edgeLength(H3_RES, h3.UNITS.m);
  const rings = Math.ceil(radiusMeters / edgeLengthMeters);
  const cells = h3.gridDisk(centerCell, rings);

  const pipeline = redis.pipeline();
  for (const cell of cells) {
    const geoKey = geoKeyForCell(cell);
    pipeline.send_command("GEOSEARCH", [
      geoKey,
      "FROMLONLAT",
      String(lon),
      String(lat),
      "BYRADIUS",
      String(radiusMeters),
      "m",
      "WITHDIST",
      "WITHCOORD",
      "ASC",
      "COUNT",
      String(maxResults),
    ]);
  }

  const rawResults = await pipeline.exec();

  const results = rawResults
    .filter(([err]) => !err)
    .flatMap(([_, value]) => value as [string, string, [string, string]][]);

  const merged = results
    .map(([id, dist, [lng, lat]]) => ({
      driverId: id,
      distance: parseFloat(dist),
      location: { lat: parseFloat(lat), lon: parseFloat(lng) },
    }))
    .sort((a, b) => a.distance - b.distance);

  const seen = new Set<string>();
  const unique = merged.filter((r) => {
    if (seen.has(r.driverId)) return false;
    seen.add(r.driverId);
    return true;
  });

  return unique.slice(0, maxResults);
}

// ---------------- Cleanup Job ----------------
async function cleanupInactiveDrivers() {
  let cursor = "0";
  let processed = 0;
  let removed = 0;

  do {
    const [newCursor, driverIds] = await redis.sscan(ACTIVE_DRIVERS_SET, cursor, "COUNT", CLEANUP_BATCH_SIZE);
    cursor = newCursor;

    if (driverIds.length === 0) continue;

    const pipeline = redis.pipeline();
    driverIds.forEach((id) => pipeline.exists(driverLastSeenKey(id)));
    const checks = await pipeline.exec();

    for (let i = 0; i < driverIds.length; i++) {
      const driverId = driverIds[i];
      const [err, exists] = checks[i];
      if (err) continue;

      if (exists === 0) {
        // expired driver
        const cell = await redis.get(driverCellKey(driverId));
        if (cell) {
          const geoKey = geoKeyForCell(cell);
          await redis.zrem(geoKey, driverId);
          await redis.del(driverCellKey(driverId));
        }
        await redis.srem(ACTIVE_DRIVERS_SET, driverId);
        removed++;
      }
    }

    processed += driverIds.length;
  } while (cursor !== "0");

  if (removed > 0) {
    console.log(`🧹 Cleanup removed ${removed} inactive drivers (scanned ${processed})`);
  }
}

// run every minute
cron.schedule("* * * * *", cleanupInactiveDrivers);

// ---------------- Demo Run ----------------
if (require.main === module) {
  (async () => {
    await updateLocation("driver:demo1", 19.0760, 72.8777);
    await updateLocation("driver:demo2", 19.0896, 72.8656);

    console.log("✅ Inserted demo drivers");

    const nearby = await searchNearby(19.0760, 72.8777, 3000, 10);
    console.log("🔍 Nearby drivers:", nearby);
  })();
}
