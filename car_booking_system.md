# 🚗 Super Ultra Pro Car Booking System Design (Scalable to 20M Drivers)

---

## 1. CarCategory Management (High-Performance CRUD)

### Schema (Optimized for Caching)
```ts
CarCategory = {
  name: 'suv' | 'sedan' | 'luxury' | 'hatchback' | 'mini',
  displayName: string,
  fareMultiplier: number,
  seatCapacity: number,
  isActive: boolean,
  updatedAt: Date // Used for cache invalidation
}
```

### Operations (Minimal Downtime)
- Insert: via admin panel/API with validation.
- Update: triggers Redis cache sync.
- Delete: soft delete preferred (`isActive = false`).

### Redis Cache Key
```ts
carCategory:<name> = { fareMultiplier, seatCapacity, updatedAt }
```

---

## 2. Vehicle + Driver Schema (Sharded & Denormalized)

### Vehicle Schema
```ts
Vehicle = {
  driverId: ObjectId,
  categoryId: ObjectId,
  categoryName: string,
  make: string,
  model: string,
  plateNumber: string (unique),
  color: string,
  isEV: boolean,
  isActive: boolean,
  shardKey: driverId // For sharded clusters
}
```

### Driver Schema (Geo-indexed, S2 cell)
```ts
Driver = {
  name: string,
  phone: string (unique),
  status: 'available' | 'busy' | 'offline',
  currentVehicleId: ObjectId,
  carCategoryId: ObjectId,
  carCategoryName: string, // denormalized
  location: { type: 'Point', coordinates: [lng, lat] },
  s2CellId: string,
  lastSeen: Date,
  shardKey: s2CellId // For geo-sharded dispatch
}
```

### Indexes
- `location: '2dsphere'`
- `s2CellId + carCategoryName`
- `carCategoryId` (for bulk updates)

---

## 3. Fare Multiplier Engine (Dynamic Pricing)

### Redis Keys (Namespaced, TTL Managed)
| Key                           | Value                      | TTL           |
|------------------------------|----------------------------|---------------|
| carCategory:suv              | { fareMultiplier: 1.5 }    | Permanent     |
| city:mumbai:multiplier       | 1.1                        | Permanent     |
| surge:zoneA:suv              | 1.3                        | 5 min         |
| event:mumbai:suv             | 1.2                        | Event end     |

### Final Multiplier Logic
```ts
fareMultiplier = base * city * surge * event;
```

### Scalable Service Function
```ts
async function calculateFinalFareMultiplier(categoryName, cityId, zoneId) {
  const keys = [
    `carCategory:${categoryName}`,
    `city:${cityId}:multiplier`,
    `surge:${zoneId}:${categoryName}`,
    `event:${zoneId}:${categoryName}`
  ];
  const [baseData, cityMod, surgeMod, eventMod] = await redis.mget(...keys);
  const base = JSON.parse(baseData)?.fareMultiplier || 1;
  const city = parseFloat(cityMod) || 1;
  const surge = parseFloat(surgeMod) || 1;
  const event = parseFloat(eventMod) || 1;
  return parseFloat((base * city * surge * event).toFixed(2));
}
```

---

## 4. Bulk Update CarCategory Name (Scalable to 20M+)

### High-Speed Sync Using Batching + Parallelism
```ts
async function syncCarCategoryName(categoryId, newName) {
  const BATCH_SIZE = 10000;

  const updateCollection = async (Model, filterKey, updateKey) => {
    let lastId = null;
    while (true) {
      const docs = await Model.find(
        { [filterKey]: categoryId, ...(lastId && { _id: { $gt: lastId } }) }
      ).sort({ _id: 1 }).limit(BATCH_SIZE).select('_id');

      if (!docs.length) break;

      const ops = docs.map(doc => ({
        updateOne: { filter: { _id: doc._id }, update: { $set: { [updateKey]: newName } } }
      }));
      await Model.bulkWrite(ops);
      lastId = docs[docs.length - 1]._id;
    }
  };

  await Promise.all([
    updateCollection(Driver, 'carCategoryId', 'carCategoryName'),
    updateCollection(Vehicle, 'categoryId', 'categoryName')
  ]);
}
```

### Optimization Notes
- Use `bulkWrite` for performance.
- Partition by `_id` to avoid cursor timeouts.
- Run in parallel for Driver and Vehicle.

---

## 5. Redis Sync Functions (TTL + Event Driven)

### Cache Car Category
```ts
await redis.set(`carCategory:${name}`, JSON.stringify({ fareMultiplier, seatCapacity, updatedAt }));
```

### Update City Modifier
```ts
await redis.set(`city:${cityId}:multiplier`, multiplier);
```

### Update Surge Modifier
```ts
await redis.setex(`surge:${zoneId}:${categoryName}`, ttl, multiplier);
```

### Update Event Modifier
```ts
await redis.set(`event:${zoneId}:${categoryName}`, multiplier);
```

---

## ✅ Final System Summary (Designed for 20M+ Drivers)

| Layer         | Technology         | Strategy                            |
|---------------|--------------------|-------------------------------------|
| Database      | MongoDB Sharded    | Geo-sharding, TTL indexes           |
| Cache         | Redis Clustered    | TTL, JSON, Pub/Sub                  |
| Updates       | BulkWrite Batches  | 10K per batch, parallelized         |
| Pricing       | Redis + Fallback   | Low latency, DB fallback            |
| Scaling       | Horizontal         | Auto-scaling nodes, shards          |

Let me know if you need deployment YAML, Docker, or real-time event triggers for pricing sync.

