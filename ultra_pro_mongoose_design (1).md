
# 🚖 Ultra-Pro Level Mongoose Design for Cab Service System (20M+ Drivers)

This design is optimized for:
- High-performance geo + category driver matching
- MongoDB denormalized schema
- S2 + Redis compatibility
- Avoiding joins in hot paths

---

## 📦 Collections

### 1. `CarCategory` Collection

Reference data for car categories (e.g., SUV, Sedan).

```ts
// carCategory.model.ts
import { Schema, model } from 'mongoose';

const carCategorySchema = new Schema({
  name: {
    type: String,
    enum: ['suv', 'sedan', 'luxury', 'hatchback', 'mini'],
    unique: true
  },
  displayName: { type: String },
  fareMultiplier: { type: Number, default: 1 },
  seatCapacity: Number,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export const CarCategory = model('CarCategory', carCategorySchema);
```

---

### 2. `Driver` Collection

Core model for real-time availability, optimized for Redis/S2.

```ts
// driver.model.ts
import { Schema, model, Types } from 'mongoose';

const driverSchema = new Schema({
  name: String,
  phone: { type: String, unique: true },
  status: {
    type: String,
    enum: ['available', 'busy', 'offline'],
    default: 'offline'
  },

  currentVehicleId: { type: Types.ObjectId, ref: 'Vehicle' },

  // Denormalized category data
  carCategoryId: { type: Types.ObjectId, required: true, index: true },
  carCategoryName: { type: String, required: true, index: true },

  // Location with S2 cell
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [0, 0] }
  },
  s2CellId: { type: String, index: true },

  lastSeen: { type: Date, default: Date.now },
}, { timestamps: true });

driverSchema.index({ location: '2dsphere' });

export const Driver = model('Driver', driverSchema);
```

---

### 3. `Vehicle` Collection

Used for registration and historical purposes, not hot path.

```ts
// vehicle.model.ts
import { Schema, model, Types } from 'mongoose';

const vehicleSchema = new Schema({
  driver: { type: Types.ObjectId, ref: 'Driver', index: true },
  categoryId: Types.ObjectId,
  categoryName: String,
  make: String,
  model: String,
  plateNumber: { type: String, unique: true },
  color: String,
  isEV: Boolean,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

export const Vehicle = model('Vehicle', vehicleSchema);
```

---

## 🔥 Best Practices

- Always **denormalize category data** in `Driver` for fast matching.
- Use **S2 Cell** and `carCategoryName` to build Redis keys.
- Avoid `.populate()` in production match-making queries.
- Use **Redis GEOADD** by `geo:<carCategory>:<s2CellId>` for sub-ms queries.
- Backed by **Kafka** to update Redis on any driver state change.

---

## 🧠 Matching Flow

1. Convert rider location → `s2CellId`
2. Query Redis `geo:<carCategory>:<s2CellId>` with GEOSEARCH
3. Filter top N drivers by proximity & `lastSeen`
4. Assign ride via Socket.IO, Kafka, or push queue

---

This schema ensures horizontal scalability, low-latency matching, and high throughput across cities and regions.
