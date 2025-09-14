import Redis from "ioredis";
import * as h3 from "h3-js";
import cron from "node-cron";

// ---------------- Config ----------------
const H3_RES = Number(process.env.H3_RES || 8);
const LAST_SEEN_TTL_MS = Number(process.env.LAST_SEEN_TTL_MS || 30_000);
const CLEANUP_BATCH_SIZE = 1000;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const redis = new Redis(REDIS_URL);
const ACTIVE_DRIVERS_SET = "drivers:active";

// ---------------- Categories ----------------
const CATEGORIES = ["bike", "car", "suv", "truck", "van"] as const;
type Category = typeof CATEGORIES[number];

// ---------------- Redis Key Helpers ----------------
const geoKeyForCell = (category: string, cell: string) =>
  `geo:drivers:${category}:h3:${H3_RES}:${cell}`;
const driverMetaKey = (driverId: string) => `driver:meta:${driverId}`;

// ---------------- Update Location ----------------
export async function updateLocation(
  driverId: string,
  lat: number,
  lon: number,
  category: Category
) {
  const cell = h3.latLngToCell(lat, lon, H3_RES);
  const geoKey = geoKeyForCell(category, cell);

  const pipeline = redis.pipeline();

  pipeline.geoadd(geoKey, lon, lat, driverId);
  pipeline.expire(geoKey, Math.ceil(LAST_SEEN_TTL_MS / 1000) + 5);

  pipeline.hset(driverMetaKey(driverId), {
    cell,
    category,
    lastSeen: Date.now().toString(),
  });
  pipeline.pexpire(driverMetaKey(driverId), LAST_SEEN_TTL_MS);

  pipeline.sadd(ACTIVE_DRIVERS_SET, driverId);

  await pipeline.exec();

  return { driverId, cell, category };
}

// ---------------- Search Nearby ----------------
export async function searchNearby(
  lat: number,
  lon: number,
  radiusMeters: number,
  maxPerCategory = 1
) {
  const centerCell = h3.latLngToCell(lat, lon, H3_RES);
  const edgeLengthMeters = h3.edgeLength(H3_RES, h3.UNITS.m);
  const rings = Math.ceil(radiusMeters / edgeLengthMeters);
  const cells = h3.gridDisk(centerCell, rings);

  const pipeline = redis.pipeline();

  for (const category of CATEGORIES) {
    for (const cell of cells) {
      const geoKey = geoKeyForCell(category, cell);
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
        String(maxPerCategory),
      ]);
    }
  }

  const rawResults = await pipeline.exec();

  const categoryResults: Record<string, any[]> = {};
  let idx = 0;

  for (const category of CATEGORIES) {
    categoryResults[category] = [];
    for (let i = 0; i < cells.length; i++) {
      const [err, res] = rawResults[idx++] || [];
      if (err || !res) continue;

      for (const [id, distStr, [lonStr, latStr]] of res as [string, string, [string, string]][]) {
        categoryResults[category].push({
          driverId: id,
          distance: parseFloat(distStr),
          location: { lat: parseFloat(latStr), lon: parseFloat(lonStr) },
        });
      }
    }
  }

  const finalResults = [];

  for (const category of CATEGORIES) {
    const sorted = categoryResults[category].sort((a, b) => a.distance - b.distance);
    const seen = new Set<string>();

    for (const driver of sorted) {
      if (!seen.has(driver.driverId)) {
        finalResults.push({ ...driver, category });
        seen.add(driver.driverId);
        break;
      }
    }
  }

  return finalResults;
}

// ---------------- Cleanup Inactive Drivers ----------------
export async function cleanupInactiveDrivers() {
  let cursor = "0";
  let removed = 0;

  do {
    const [nextCursor, driverIds] = await redis.sscan(ACTIVE_DRIVERS_SET, cursor, "COUNT", CLEANUP_BATCH_SIZE);
    cursor = nextCursor;

    const pipeline = redis.pipeline();
    driverIds.forEach((id) => pipeline.hgetall(driverMetaKey(id)));
    const results = await pipeline.exec();

    for (let i = 0; i < results.length; i++) {
      const [err, meta] = results[i];
      const driverId = driverIds[i];
      if (err || !meta || !meta.lastSeen || !meta.cell || !meta.category) {
        await redis.srem(ACTIVE_DRIVERS_SET, driverId);
        continue;
      }

      const lastSeen = Number(meta.lastSeen);
      if (Date.now() - lastSeen > LAST_SEEN_TTL_MS) {
        const geoKey = geoKeyForCell(meta.category, meta.cell);
        const pipe = redis.pipeline();
        pipe.zrem(geoKey, driverId);
        pipe.del(driverMetaKey(driverId));
        pipe.srem(ACTIVE_DRIVERS_SET, driverId);
        await pipe.exec();
        removed++;
      }
    }
  } while (cursor !== "0");

  if (removed > 0) {
    console.log(`🧹 Cleanup removed ${removed} inactive drivers`);
  }
}

// ---------------- Scheduler ----------------
cron.schedule("*/30 * * * * *", cleanupInactiveDrivers);

// ---------------- Demo ----------------
if (require.main === module) {
  (async () => {
    console.log("🔄 Simulating drivers every 5s...");

    const demoDrivers = [
      { driverId: "driver:bike:1", category: "bike", lat: 19.0760, lon: 72.8777 },
      { driverId: "driver:car:1", category: "car", lat: 19.0770, lon: 72.8787 },
      { driverId: "driver:suv:1", category: "suv", lat: 19.0780, lon: 72.8797 },
      { driverId: "driver:truck:1", category: "truck", lat: 19.0790, lon: 72.8807 },
      { driverId: "driver:van:1", category: "van", lat: 19.0800, lon: 72.8817 },
    ] as const;

    setInterval(async () => {
      for (const { driverId, category, lat, lon } of demoDrivers) {
        await updateLocation(driverId, lat, lon, category);
        console.log(`📍 Updated ${driverId} (${category})`);
      }
    }, 5000);

    setInterval(async () => {
      const results = await searchNearby(19.076, 72.8777, 3000);
      console.log("🔍 Nearby drivers (one per category):");
      results.forEach(({ driverId, category, distance }) =>
        console.log(`- ${driverId} (${category}) → ${distance.toFixed(1)}m`)
      );
      console.log("-----------");
    }, 8000);
  })();
}
