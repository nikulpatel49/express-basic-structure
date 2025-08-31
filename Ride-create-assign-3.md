/**
 * ===================================================
 *  Ride Booking System - Full Flow (Single File, TS)
 * ===================================================
 * Includes:
 *   ✅ Constants & Types
 *   ✅ Redis Setup
 *   ✅ Kafka Setup
 *   ✅ Lua Script (Atomic Driver Assignment)
 *   ✅ Ride Service (5 Steps: Create → Category → Accept → Cancel → Complete & Pay)
 * ===================================================
 */

import Redis from "ioredis";
import { Kafka, Producer } from "kafkajs";

// ===============================
// 📌 Constants & Types
// ===============================
export const RIDE_STATUS = {
  REQUESTED: "rq",
  ASSIGNED: "as",
  STARTED: "st",
  COMPLETED: "cp",
  CANCELLED: "cl",
} as const;

export type RideStatus = (typeof RIDE_STATUS)[keyof typeof RIDE_STATUS];

export const DRIVER_STATUS = {
  AVAILABLE: "av",
  BUSY: "by",
  OFFLINE: "of",
  SUSPENDED: "sp",
} as const;

export type DriverStatus = (typeof DRIVER_STATUS)[keyof typeof DRIVER_STATUS];

export const PASSENGER_STATUS = {
  ACTIVE: "ac",
  BLOCKED: "bl",
  DELETED: "dl",
} as const;

export type PassengerStatus = (typeof PASSENGER_STATUS)[keyof typeof PASSENGER_STATUS];

export const PAYMENT_STATUS = {
  PENDING: "pn",
  SUCCESS: "sc",
  FAILED: "fl",
  REFUNDED: "rf",
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const TRIP_CATEGORY = {
  ONE_WAY: "ow",
  RETURN: "rt",
  HOURLY: "hr",
} as const;

export type TripCategory = (typeof TRIP_CATEGORY)[keyof typeof TRIP_CATEGORY];

// ===============================
// 📌 Interfaces
// ===============================
export interface Ride {
  id: string;
  passengerId: string;
  pickup: string;
  drop: string;
  category: TripCategory | null;
  status: RideStatus;
  driverId?: string;
  createdAt: number;
  completedAt?: number;
  cancelledBy?: "passenger" | "driver";
}

export interface Driver {
  id: string;
  status: DriverStatus;
}

export interface Payment {
  id: string;
  rideId: string;
  passengerId: string;
  amount: number;
  status: PaymentStatus;
  createdAt: number;
}

// ===============================
// 📌 Redis Setup
// ===============================
export const redis = new Redis({
  host: "localhost",
  port: 6379,
});

// ===============================
// 📌 Kafka Setup
// ===============================
const kafka = new Kafka({
  clientId: "ride-service",
  brokers: ["localhost:9092"],
});

export let kafkaProducer: Producer;

export async function connectKafka(): Promise<void> {
  kafkaProducer = kafka.producer();
  await kafkaProducer.connect();
  console.log("✅ Kafka connected");
}

// ===============================
// 📌 Redis Keys Helpers
// ===============================
const rideKey = (rideId: string): string => `ride:${rideId}`;
const driverKey = (driverId: string): string => `driver:${driverId}`;
const paymentKey = (paymentId: string): string => `payment:${paymentId}`;

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
export async function createRideRequest(
  passengerId: string,
  pickup: string,
  drop: string
): Promise<Ride> {
  const rideId = `ride-${Date.now()}`;
  const ride: Ride = {
    id: rideId,
    passengerId,
    pickup,
    drop,
    category: null,
    status: RIDE_STATUS.REQUESTED,
    createdAt: Date.now(),
  };

  await redis.hmset(rideKey(rideId), ride as any);

  await kafkaProducer.send({
    topic: "ride_created",
    messages: [{ key: rideId, value: JSON.stringify(ride) }],
  });

  return ride;
}

// STEP 2: Passenger Selects Category
export async function updateRideCategory(
  rideId: string,
  category: keyof typeof TRIP_CATEGORY
): Promise<{ rideId: string; category: TripCategory }> {
  const categoryCode = TRIP_CATEGORY[category];
  await redis.hset(rideKey(rideId), "category", categoryCode);

  await kafkaProducer.send({
    topic: "ride_category_updated",
    messages: [{ key: rideId, value: JSON.stringify({ rideId, category: categoryCode }) }],
  });

  return { rideId, category: categoryCode };
}

// STEP 3: Driver Accepts Ride (Atomic with Lua)
export async function assignDriver(
  rideId: string,
  driverId: string
): Promise<{ rideId: string; driverId: string; status: RideStatus }> {
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
export async function cancelRide(
  rideId: string,
  cancelledBy: "passenger" | "driver"
): Promise<{ rideId: string; status: RideStatus; cancelledBy: string }> {
  await redis.hset(rideKey(rideId), "status", RIDE_STATUS.CANCELLED, "cancelledBy", cancelledBy);

  await kafkaProducer.send({
    topic: "ride_cancelled",
    messages: [{ key: rideId, value: JSON.stringify({ rideId, cancelledBy }) }],
  });

  return { rideId, status: RIDE_STATUS.CANCELLED, cancelledBy };
}

// STEP 5: Ride Completion & Payment Processing
export async function completeRideAndProcessPayment(
  rideId: string,
  driverId: string,
  amount: number
): Promise<{ rideId: string; driverId: string; status: RideStatus; payment: Payment }> {
  // Mark ride as completed
  await redis.hset(rideKey(rideId), "status", RIDE_STATUS.COMPLETED, "completedAt", Date.now());

  // Free the driver
  await redis.hset(driverKey(driverId), "status", DRIVER_STATUS.AVAILABLE);

  // Create payment
  const paymentId = `payment-${Date.now()}`;
  const passengerId = (await redis.hget(rideKey(rideId), "passengerId")) || "unknown";

  const payment: Payment = {
    id: paymentId,
    rideId,
    passengerId,
    amount,
    status: PAYMENT_STATUS.PENDING,
    createdAt: Date.now(),
  };

  await redis.hmset(paymentKey(paymentId), payment as any);

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
