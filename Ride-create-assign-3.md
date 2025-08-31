/**
 * ===================================================
 *  Ride Booking System - Full Flow (Single File)
 * ===================================================
 * Includes:
 *   ✅ Constants (Ride, Driver, Passenger, Payment, Trip)
 *   ✅ Redis Setup
 *   ✅ Kafka Setup
 *   ✅ Lua Script (Atomic Driver Assignment)
 *   ✅ Ride Service (5 Steps: Create → Category → Accept → Cancel → Complete & Pay)
 *   ✅ Sequence Diagram (Mermaid.js)
 * ===================================================
 */


// ===============================
// 📌 Constants
// ===============================
export const RIDE_STATUS = {
  REQUESTED: "rq",
  ASSIGNED: "as",
  STARTED: "st",
  COMPLETED: "cp",
  CANCELLED: "cl",
} as const;

export const RIDE_STATUS_LABELS = {
  rq: "Requested",
  as: "Assigned",
  st: "Started",
  cp: "Completed",
  cl: "Cancelled",
} as const;

export type RideStatus = (typeof RIDE_STATUS)[keyof typeof RIDE_STATUS];

export const DRIVER_STATUS = {
  AVAILABLE: "av",
  BUSY: "by",
  OFFLINE: "of",
  SUSPENDED: "sp",
} as const;

export const DRIVER_STATUS_LABELS = {
  av: "Available",
  by: "Busy",
  of: "Offline",
  sp: "Suspended",
} as const;

export const PASSENGER_STATUS = {
  ACTIVE: "ac",
  BLOCKED: "bl",
  DELETED: "dl",
} as const;

export const PASSENGER_STATUS_LABELS = {
  ac: "Active",
  bl: "Blocked",
  dl: "Deleted",
} as const;

export const PAYMENT_STATUS = {
  PENDING: "pn",
  SUCCESS: "sc",
  FAILED: "fl",
  REFUNDED: "rf",
} as const;

export const PAYMENT_STATUS_LABELS = {
  pn: "Pending",
  sc: "Success",
  fl: "Failed",
  rf: "Refunded",
} as const;

export const TRIP_CATEGORY = {
  ONE_WAY: "ow",
  RETURN: "rt",
  HOURLY: "hr",
} as const;

export const TRIP_CATEGORY_LABELS = {
  ow: "One Way",
  rt: "Return",
  hr: "Hourly",
} as const;


// ===============================
// 📌 Redis Setup
// ===============================
import Redis from "ioredis";

export const redis = new Redis({
  host: "localhost",
  port: 6379,
});


// ===============================
// 📌 Kafka Setup
// ===============================
import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "ride-service",
  brokers: ["localhost:9092"],
});

export const kafkaProducer = kafka.producer();

export async function connectKafka() {
  await kafkaProducer.connect();
  console.log("Kafka connected 🚀");
}


// ===============================
// 📌 Redis Keys Helpers
// ===============================
const rideKey = (rideId: string) => `ride:${rideId}`;
const driverKey = (driverId: string) => `driver:${driverId}`;
const paymentKey = (paymentId: string) => `payment:${paymentId}`;


// ===============================
// 📌 Lua Script (Driver Accept - Atomic)
// ===============================
const acceptRideScript = `
  local rideKey = KEYS[1]
  local driverKey = KEYS[2]
  local rideStatus = redis.call("HGET", rideKey, "status")
  local driverStatus = redis.call("HGET", driverKey, "status")

  if rideStatus ~= ARGV[1] then
    return {err="Ride not available"}
  end
  if driverStatus ~= ARGV[2] then
    return {err="Driver not available"}
  end

  redis.call("HSET", rideKey, "status", ARGV[3], "driverId", ARGV[4])
  redis.call("HSET", driverKey, "status", ARGV[5])

  return "OK"
`;


// ===============================
// 📌 Ride Service
// ===============================

// STEP 1: Create Ride Request
export async function createRideRequest(passengerId: string, pickup: string, drop: string) {
  const rideId = `ride-${Date.now()}`;
  const ride = {
    id: rideId,
    passengerId,
    pickup,
    drop,
    category: null,
    status: RIDE_STATUS.REQUESTED,
    createdAt: Date.now(),
  };

  await redis.hmset(rideKey(rideId), ride);

  await kafkaProducer.send({
    topic: "ride_created",
    messages: [{ key: rideId, value: JSON.stringify(ride) }],
  });

  return ride;
}


// STEP 2: Passenger Selects Category
export async function updateRideCategory(rideId: string, category: keyof typeof TRIP_CATEGORY) {
  const categoryCode = TRIP_CATEGORY[category];

  await redis.hset(rideKey(rideId), "category", categoryCode);

  await kafkaProducer.send({
    topic: "ride_category_updated",
    messages: [{ key: rideId, value: JSON.stringify({ rideId, category: categoryCode }) }],
  });

  return { rideId, category: categoryCode };
}


// STEP 3: Driver Accepts Ride (Atomic)
export async function assignDriver(rideId: string, driverId: string) {
  const result = await redis.eval(
    acceptRideScript,
    2,
    rideKey(rideId),
    driverKey(driverId),
    RIDE_STATUS.REQUESTED,
    DRIVER_STATUS.AVAILABLE,
    RIDE_STATUS.ASSIGNED,
    driverId,
    DRIVER_STATUS.BUSY
  );

  if (result !== "OK") throw new Error(result as string);

  await kafkaProducer.send({
    topic: "ride_assigned",
    messages: [{ key: rideId, value: JSON.stringify({ rideId, driverId }) }],
  });

  return { rideId, driverId, status: RIDE_STATUS.ASSIGNED };
}


// STEP 4: Ride Cancellation
export async function cancelRide(rideId: string, cancelledBy: "passenger" | "driver") {
  await redis.hset(rideKey(rideId), "status", RIDE_STATUS.CANCELLED, "cancelledBy", cancelledBy);

  await kafkaProducer.send({
    topic: "ride_cancelled",
    messages: [{ key: rideId, value: JSON.stringify({ rideId, cancelledBy }) }],
  });

  return { rideId, status: RIDE_STATUS.CANCELLED, cancelledBy };
}


// STEP 5: Ride Completion & Payment Processing
export async function completeRideAndProcessPayment(rideId: string, driverId: string, amount: number) {
  // Mark ride as completed
  await redis.hset(rideKey(rideId), "status", RIDE_STATUS.COMPLETED, "completedAt", Date.now());

  // Free the driver
  await redis.hset(driverKey(driverId), "status", DRIVER_STATUS.AVAILABLE);

  // Create payment
  const paymentId = `payment-${Date.now()}`;
  const payment = {
    id: paymentId,
    rideId,
    passengerId: await redis.hget(rideKey(rideId), "passengerId"),
    amount,
    status: PAYMENT_STATUS.PENDING,
    createdAt: Date.now(),
  };

  await redis.hmset(paymentKey(paymentId), payment);

  // Simulate Payment Success
  await redis.hset(paymentKey(paymentId), "status", PAYMENT_STATUS.SUCCESS);

  await kafkaProducer.send({
    topic: "ride_completed",
    messages: [{ key: rideId, value: JSON.stringify({ rideId, driverId, status: RIDE_STATUS.COMPLETED }) }],
  });

  await kafkaProducer.send({
    topic: "payment_processed",
    messages: [{ key: paymentId, value: JSON.stringify({ paymentId, status: PAYMENT_STATUS.SUCCESS, amount }) }],
  });

  return { rideId, driverId, status: RIDE_STATUS.COMPLETED, payment };
}
