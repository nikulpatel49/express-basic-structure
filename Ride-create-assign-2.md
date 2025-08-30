# Ultra-Scale Cab Booking System Architecture (20M Drivers)

This document outlines the architecture, Redis schema, and implementation details for a **ride booking system** that can scale to **20M+ concurrent drivers**. The system uses **Redis**, **Kafka**, and **Node.js (Express)** with optimizations for memory, performance, and high throughput.

---

## Table of Contents

1. [Overview](#overview)
2. [Redis Key Schema](#redis-key-schema)
3. [Step-by-Step Implementation](#step-by-step-implementation)
    1. [Step 1: Create Ride Request](#step-1-create-ride-request)
    2. [Step 2: Passenger Selects Category](#step-2-passenger-selects-category)
    3. [Step 3: Driver Accepts Ride](#step-3-driver-accepts-ride)
    4. [Step 4: Ride Cancellation](#step-4-ride-cancellation)

---

## Overview

This system is designed to scale to **20 million concurrent drivers** with the following features:

-   **Optimized Redis schema** for reduced memory usage and quick access.
-   **Atomic Lua scripts** to handle ride assignments and cancellations without race conditions.
-   **Kafka messaging** for real-time notifications to drivers and passengers.
-   **TTL for candidates and rides** to prevent stale data.
-   **Scalable design** to handle high throughput.

---

## Redis Key Schema

The Redis schema is designed for **performance** and **memory efficiency**.

### Main Redis Keys:

1. **ride:{rideId} (HASH)**:

    - `status`: `"pending"`, `"assigned"`, `"cancelled"`, `"expired"`
    - `assigned`: Driver ID (empty if none)
    - `category`: Chosen car category (SUV, Sedan, Bike, etc.)
    - `expireAt`: Expiry timestamp (Unix timestamp in ms)
    - `meta`: MessagePack buffer (pickup, drop, passengerId, etc.)

2. **driver:{driverId}:lock (STRING)**:

    - Value: `rideId` (Locked for the ride assignment)
    - Expiry (`EX=300s`): Ensures the driver lock expires after a set time.

3. **ride:{rideId}:cands (SET)**:
    - Stores the **candidate drivers** for the ride (TTL=30s).

---

## Step-by-Step Implementation

### Step 1: Create Ride Request

The passenger initiates the ride request by selecting pickup and drop-off locations. The system stores the ride in Redis and provides ride categories for the passenger to choose from.

#### Code Implementation:

```ts
// --- Step 1: Create Ride ---
app.post('/ride/create', async (req, res) => {
  const { rideId, passengerId, pickup, drop } = req.body;

  // Store ride metadata as MessagePack for space efficiency
  const rideMeta = encodeMsgPack({ passengerId, pickup, drop, createdAt: Date.now() });

  await redis.hmset(`ride:${rideId}`, {
    status: 'pending',
    assigned: '',
    category: '',
    expireAt: Date.now() + 60000 // Expiry in 1 min
  });

  await redis.hsetBuffer(`ride:${rideId}`, 'meta', rideMeta);

  // Send ride categories (mocked) to passenger
  const driversByCategory = {
    sedan: { price: 200, time: 3 },
    suv: { price: 300, time: 4 },
    bike: { price: 100, time: 2 }
  };

  // Notify the system and drivers (Kafka/WebSocket)
  await producer.send({
    topic: 'ride.create',
    messages: [{ value: JSON.stringify({ rideId, passengerId }) }]
  });

  return res.json({ rideId, categories: driversByCategory });
});


=========================================================================================================================================


// --- Step 3: Driver Accept Ride (Atomic Lua Script) ---
const acceptRideScript = `
local status = redis.call("hget", KEYS[1], "status")
if not status or status == "assigned" or status == "cancelled" then
  return 0
end

redis.call("hmset", KEYS[1],
  "status", "assigned",
  "assigned", ARGV[1],
  "assignedAt", ARGV[2]
)

redis.call("set", "driver:"..ARGV[1]..":lock", KEYS[1], "EX", 180) -- 3 min lock for the driver
redis.call("pexpire", KEYS[1], 300000) -- ride expires in 5 mins if not confirmed

return 1
`;

app.post('/ride/accept', async (req, res) => {
  const { rideId, driverId } = req.body;

  // Run Lua script to atomically accept the ride
  const result = await redis.eval(acceptRideScript, 1, `ride:${rideId}`, driverId, Date.now());

  if (result === 1) {
    // Notify the system and all parties involved that the ride has been assigned
    await producer.send({
      topic: 'ride.assigned',
      messages: [{ value: JSON.stringify({ rideId, driverId }) }]
    });
    return res.json({ success: true, rideId, driverId });
  }

  return res.json({ success: false, message: 'Ride not available or already assigned' });
});


=========================================================================================================================


// --- Step 4: Passenger Cancel (Atomic Lua Script) ---
const passengerCancelScript = `
local status = redis.call("hget", KEYS[1], "status")
if not status or status == "assigned" or status == "cancelled" then
  return 0
end
redis.call("hset", KEYS[1], "status", "cancelled")
return 1
`;

app.post('/ride/passenger-cancel', async (req, res) => {
  const { rideId } = req.body;
  const result = await redis.eval(passengerCancelScript, 1, `ride:${rideId}`);

  if (result === 1) {
    // Notify the system that the passenger cancelled the ride
    await producer.send({
      topic: 'ride.cancelled',
      messages: [{ value: JSON.stringify({ rideId }) }]
    });
    return res.json({ success: true, rideId });
  }

  return res.json({ success: false, message: 'Ride not cancellable' });
});


==============================================================================================================

// --- Step 5: Driver Cancel (Atomic Lua Script) ---
const driverCancelScript = `
local status = redis.call("hget", KEYS[1], "status")
local assignedDriver = redis.call("hget", KEYS[1], "assigned")

if status ~= "assigned" or assignedDriver ~= ARGV[1] then
  return 0
end

redis.call("del", "driver:"..ARGV[1]..":lock")
redis.call("hmset", KEYS[1],
  "status", "pending",
  "assigned", "",
  "assignedAt", ""
)
return 1
`;

app.post('/ride/driver-cancel', async (req, res) => {
  const { rideId, driverId } = req.body;
  const result = await redis.eval(driverCancelScript, 1, `ride:${rideId}`, driverId);

  if (result === 1) {
    // Notify the system that the ride has been cancelled by the driver
    await producer.send({
      topic: 'ride.driver-cancelled',
      messages: [{ value: JSON.stringify({ rideId, driverId }) }]
    });
    return res.json({ success: true, rideId, driverId });
  }

  return res.json({ success: false, message: 'Driver cannot cancel this ride' });
});


====================================================================================================
```
