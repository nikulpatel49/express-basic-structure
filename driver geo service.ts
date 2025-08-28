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