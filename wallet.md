Wallet Service — Full Repo (Pure TypeScript)

This repository is a complete, ready-to-run wallet-only service implemented in pure TypeScript. It includes models, services, a reservation expiry worker, tests, and local docker-compose for a single-node MongoDB replica set required for transactions.

Copy each file into your project wallet-service/ folder (paths shown). Run instructions are at the end.

⸻

Repo file tree

wallet-service/
├─ package.json
├─ tsconfig.json
├─ docker-compose.yml
├─ .env.example
├─ src/
│  ├─ index.ts
│  ├─ config/
│  │  └─ mongoose.ts
│  ├─ models/
│  │  ├─ Wallet.ts
│  │  ├─ WalletTransaction.ts
│  │  ├─ WalletReservation.ts
│  │  └─ IdempotencyKey.ts
│  ├─ services/
│  │  └─ wallet.service.ts
│  ├─ workers/
│  │  └─ reservationExpiry.worker.ts
│  └─ utils/
│     └─ errors.ts
└─ tests/
   └─ concurrency.test.ts


⸻

package.json

{
  "name": "wallet-service",
  "version": "1.0.0",
  "license": "MIT",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "ts-node-dev --respawn --transpile-only src/index.ts",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "http-errors": "^2.0.0",
    "mongoose": "^7.0.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "@types/jest": "^29.0.0",
    "@types/node": "^18.0.0",
    "jest": "^29.0.0",
    "mongodb-memory-server": "^8.7.0",
    "ts-jest": "^29.0.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^4.9.0"
  }
}


⸻

tsconfig.json

{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"]
}


⸻

docker-compose.yml

version: '3.8'
services:
  mongo:
    image: mongo:6.0
    container_name: mongo_rs
    ports:
      - "27017:27017"
    command: >
      bash -c "mkdir -p /data/db &&
               mongod --replSet rs0 --bind_ip_all --port 27017"
    volumes:
      - mongo-data:/data/db

volumes:
  mongo-data:


⸻

.env.example

MONGO_URI=mongodb://localhost:27017/walletdb?replicaSet=rs0
PORT=3000


⸻

src/config/mongoose.ts

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/walletdb?replicaSet=rs0';

export const connectMongoose = async () => {
  await mongoose.connect(MONGO_URI);
  return mongoose.connection;
};


⸻

src/models/Wallet.ts

import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IWallet extends Document {
  ownerId: string;
  currency: string;
  balance: number;
  heldAmount: number;
  meta?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const WalletSchema = new Schema<IWallet>({
  ownerId: { type: String, required: true, index: true },
  currency: { type: String, required: true },
  balance: { type: Number, required: true, default: 0 },
  heldAmount: { type: Number, required: true, default: 0 },
  meta: { type: Schema.Types.Mixed }
}, { timestamps: true });

WalletSchema.index({ ownerId: 1, currency: 1 }, { unique: true });

export const Wallet: Model<IWallet> = mongoose.model<IWallet>('Wallet', WalletSchema);


⸻

src/models/WalletTransaction.ts

import mongoose, { Schema, Document, Model } from 'mongoose';

export type TransactionType = 'DEPOSIT'|'WITHDRAW'|'HOLD'|'RELEASE'|'CAPTURE'|'VOUCHER_REDEMPTION'|'DRIVER_PAYOUT'|'REFUND'|'ADJUSTMENT'|'FEE'|'REVERSAL';
export type TransactionCategory = 'RIDE'|'VOUCHER'|'TOPUP'|'GIFT'|'PAYOUT'|'REFUND'|'CANCELLATION'|'PROMOTION'|'OTHER';

export interface IWalletTransaction extends Document {
  walletId: mongoose.Types.ObjectId;
  type: TransactionType;
  category?: TransactionCategory;
  amount: number;
  currency: string;
  beforeBalance: number;
  afterBalance: number;
  heldDelta?: number;
  referenceId?: string;
  idempotencyKey?: string;
  relatedTxId?: mongoose.Types.ObjectId;
  meta?: Record<string, any>;
  createdAt: Date;
}

const WalletTransactionSchema = new Schema<IWalletTransaction>({
  walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
  type: { type: String, required: true, index: true },
  category: { type: String, index: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  beforeBalance: { type: Number, required: true },
  afterBalance: { type: Number, required: true },
  heldDelta: { type: Number },
  referenceId: { type: String, index: true },
  idempotencyKey: { type: String, index: true },
  relatedTxId: { type: Schema.Types.ObjectId, index: true },
  meta: { type: Schema.Types.Mixed }
}, { timestamps: { createdAt: true, updatedAt: false } });

WalletTransactionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
WalletTransactionSchema.index({ walletId: 1, createdAt: -1 });
WalletTransactionSchema.index({ walletId: 1, type: 1, createdAt: -1 });

export const WalletTransaction: Model<IWalletTransaction> = mongoose.model<IWalletTransaction>('WalletTransaction', WalletTransactionSchema);


⸻

src/models/WalletReservation.ts

import mongoose, { Schema, Document, Model } from 'mongoose';

export type ReservationStatus = 'HELD'|'CAPTURED'|'RELEASED'|'EXPIRED'|'FAILED';

export interface IWalletReservation extends Document {
  walletId: mongoose.Types.ObjectId;
  amount: number;
  status: ReservationStatus;
  expiresAt: Date;
  reservedAt: Date;
  idempotencyKey?: string;
  referenceType?: string;
  referenceId?: string;
  meta?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const WalletReservationSchema = new Schema<IWalletReservation>({
  walletId: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['HELD','CAPTURED','RELEASED','EXPIRED','FAILED'], default: 'HELD', index: true },
  expiresAt: { type: Date, required: true, index: true },
  reservedAt: { type: Date, required: true, default: Date.now },
  idempotencyKey: { type: String, index: true },
  referenceType: { type: String, index: true },
  referenceId: { type: String, index: true },
  meta: { type: Schema.Types.Mixed }
}, { timestamps: true });

WalletReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
WalletReservationSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const WalletReservation: Model<IWalletReservation> = mongoose.model<IWalletReservation>('WalletReservation', WalletReservationSchema);


⸻

src/models/IdempotencyKey.ts

import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IIdempotencyKey extends Document {
  key: string;
  result?: any;
  createdAt: Date;
}

const IdempotencyKeySchema = new Schema<IIdempotencyKey>({
  key: { type: String, required: true, unique: true },
  result: { type: Schema.Types.Mixed }
}, { timestamps: { createdAt: true, updatedAt: false } });

export const IdempotencyKey: Model<IIdempotencyKey> = mongoose.model<IIdempotencyKey>('IdempotencyKey', IdempotencyKeySchema);


⸻

src/services/wallet.service.ts

import mongoose, { ClientSession } from 'mongoose';
import createError from 'http-errors';
import { Wallet } from '../models/Wallet';
import { WalletTransaction } from '../models/WalletTransaction';
import { WalletReservation } from '../models/WalletReservation';
import { IdempotencyKey } from '../models/IdempotencyKey';

export const walletService = (deps?: any) => {
  const withSession = async <T>(fn: (session: ClientSession) => Promise<T>) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const out = await fn(session);
      await session.commitTransaction();
      return out;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  };

  const createWallet = async (ownerId: string, currency = 'USD', initialBalance = 0) => {
    return new Wallet({ ownerId, currency, balance: initialBalance, heldAmount: 0 }).save();
  };

  const getWallet = async (walletId: string) => {
    const w = await Wallet.findById(walletId).lean();
    if (!w) throw createError(404, 'Wallet not found');
    return w;
  };

  const deposit = async (opts: { walletId: string; amount: number; idempotencyKey?: string; referenceId?: string; category?: string; meta?: any }) => {
    const { walletId, amount, idempotencyKey, referenceId, category, meta } = opts;
    if (amount <= 0) throw createError(400, 'Amount must be > 0');

    return withSession(async (session) => {
      if (idempotencyKey) {
        const existing = await IdempotencyKey.findOne({ key: idempotencyKey }).session(session).lean();
        if (existing?.result) return existing.result;
      }

      const wallet = await Wallet.findById(walletId).session(session);
      if (!wallet) throw createError(404, 'Wallet not found');

      const before = wallet.balance;
      wallet.balance = before + amount;
      await wallet.save({ session });

      const tx = await WalletTransaction.create([{
        walletId: wallet._id,
        type: 'DEPOSIT',
        category: category ?? 'TOPUP',
        amount: amount,
        currency: wallet.currency,
        beforeBalance: before,
        afterBalance: wallet.balance,
        idempotencyKey,
        referenceId,
        meta
      }], { session });

      if (idempotencyKey) {
        await IdempotencyKey.updateOne({ key: idempotencyKey }, { $set: { result: { txId: tx[0]._id } } }, { upsert: true, session });
      }

      return tx[0];
    });
  };

  const withdraw = async (opts: { walletId: string; amount: number; idempotencyKey?: string; referenceId?: string; category?: string; meta?: any }) => {
    const { walletId, amount, idempotencyKey, referenceId, category, meta } = opts;
    if (amount <= 0) throw createError(400, 'Amount must be > 0');

    return withSession(async (session) => {
      if (idempotencyKey) {
        const existing = await IdempotencyKey.findOne({ key: idempotencyKey }).session(session).lean();
        if (existing?.result) return existing.result;
      }

      const wallet = await Wallet.findOneAndUpdate({
        _id: walletId,
        $expr: { $gte: [{ $subtract: ['$balance', '$heldAmount'] }, amount] }
      }, { $inc: { balance: -amount } }, { new: true, session });

      if (!wallet) throw createError(400, 'Insufficient available funds or wallet not found');

      const tx = await WalletTransaction.create([{
        walletId: wallet._id,
        type: 'WITHDRAW',
        category: category ?? 'OTHER',
        amount: -Math.abs(amount),
        currency: wallet.currency,
        beforeBalance: wallet.balance + amount,
        afterBalance: wallet.balance,
        idempotencyKey,
        referenceId,
        meta
      }], { session });

      if (idempotencyKey) {
        await IdempotencyKey.updateOne({ key: idempotencyKey }, { $set: { result: { txId: tx[0]._id } } }, { upsert: true, session });
      }

      return tx[0];
    });
  };

  const createReservation = async (opts: { walletId: string; amount: number; ttlSec?: number; idempotencyKey?: string; referenceType?: string; referenceId?: string; category?: string; meta?: any }) => {
    const { walletId, amount, ttlSec = 30 * 60, idempotencyKey, referenceType, referenceId, category, meta } = opts;
    if (amount <= 0) throw createError(400, 'Amount must be > 0');

    return withSession(async (session) => {
      if (idempotencyKey) {
        const existing = await IdempotencyKey.findOne({ key: idempotencyKey }).session(session).lean();
        if (existing?.result) return existing.result;
      }

      const wallet = await Wallet.findOneAndUpdate({
        _id: walletId,
        $expr: { $gte: [{ $subtract: ['$balance', '$heldAmount'] }, amount] }
      }, { $inc: { heldAmount: amount } }, { new: true, session });

      if (!wallet) throw createError(400, 'Insufficient available funds or wallet not found');

      const expiresAt = new Date(Date.now() + ttlSec * 1000);
      const reservation = await WalletReservation.create([{
        walletId: wallet._id,
        amount,
        status: 'HELD',
        expiresAt,
        reservedAt: new Date(),
        idempotencyKey,
        referenceType,
        referenceId,
        meta
      }], { session });

      const tx = await WalletTransaction.create([{
        walletId: wallet._id,
        type: 'HOLD',
        category: category ?? (referenceType ?? 'RIDE') as any,
        amount: -Math.abs(amount),
        currency: wallet.currency,
        beforeBalance: wallet.balance,
        afterBalance: wallet.balance,
        heldDelta: amount,
        referenceId: reservation[0]._id.toString(),
        idempotencyKey,
        meta: { expiresAt, ...meta }
      }], { session });

      if (idempotencyKey) {
        await IdempotencyKey.updateOne({ key: idempotencyKey }, { $set: { result: { reservationId: reservation[0]._id, txId: tx[0]._id } } }, { upsert: true, session });
      }

      return { reservation: reservation[0], tx: tx[0], wallet };
    });
  };

  const releaseReservation = async (opts: { reservationId: string; idempotencyKey?: string; reason?: string; meta?: any }) => {
    const { reservationId, idempotencyKey, reason, meta } = opts;

    return withSession(async (session) => {
      const reservation = await WalletReservation.findById(reservationId).session(session);
      if (!reservation) throw createError(404, 'Reservation not found');
      if (reservation.status !== 'HELD') return { reservation, alreadyProcessed: true };

      if (idempotencyKey) {
        const existing = await IdempotencyKey.findOne({ key: idempotencyKey }).session(session).lean();
        if (existing?.result) return existing.result;
      }

      const wallet = await Wallet.findOneAndUpdate({ _id: reservation.walletId, heldAmount: { $gte: reservation.amount } }, { $inc: { heldAmount: -reservation.amount } }, { new: true, session });
      if (!wallet) throw createError(500, 'Inconsistent held amount');

      reservation.status = 'RELEASED';
      await reservation.save({ session });

      const tx = await WalletTransaction.create([{
        walletId: wallet._id,
        type: 'RELEASE',
        category: 'RIDE',
        amount: reservation.amount,
        currency: wallet.currency,
        beforeBalance: wallet.balance,
        afterBalance: wallet.balance,
        heldDelta: -reservation.amount,
        referenceId: reservation._id.toString(),
        idempotencyKey,
        meta: { reason, ...meta }
      }], { session });

      if (idempotencyKey) await IdempotencyKey.updateOne({ key: idempotencyKey }, { $set: { result: { reservationId: reservation._id, txId: tx[0]._id } } }, { upsert: true, session });

      return { reservation, tx: tx[0], wallet };
    });
  };

  const captureReservation = async (opts: { reservationId: string; amount?: number; idempotencyKey?: string; referenceId?: string; category?: string; meta?: any }) => {
    const { reservationId, amount, idempotencyKey, referenceId, category, meta } = opts;

    return withSession(async (session) => {
      const reservation = await WalletReservation.findById(reservationId).session(session);
      if (!reservation) throw createError(404, 'Reservation not found');
      if (reservation.status !== 'HELD') throw createError(400, 'Reservation not active');

      const captureAmount = amount ?? reservation.amount;
      if (captureAmount <= 0 || captureAmount > reservation.amount) throw createError(400, 'Invalid capture amount');

      if (idempotencyKey) {
        const existing = await IdempotencyKey.findOne({ key: idempotencyKey }).session(session).lean();
        if (existing?.result) return existing.result;
      }

      const wallet = await Wallet.findOneAndUpdate({
        _id: reservation.walletId,
        $expr: { $and: [{ $gte: ['$heldAmount', captureAmount] }, { $gte: ['$balance', captureAmount] }] }
      }, { $inc: { heldAmount: -captureAmount, balance: -captureAmount } }, { new: true, session });

      if (!wallet) throw createError(400, 'Insufficient held/settled funds to capture');

      if (captureAmount === reservation.amount) {
        reservation.status = 'CAPTURED';
      } else {
        reservation.amount = reservation.amount - captureAmount;
      }
      await reservation.save({ session });

      const tx = await WalletTransaction.create([{
        walletId: wallet._id,
        type: 'CAPTURE',
        category: category ?? 'RIDE',
        amount: -Math.abs(captureAmount),
        currency: wallet.currency,
        beforeBalance: wallet.balance + captureAmount,
        afterBalance: wallet.balance,
        heldDelta: -captureAmount,
        referenceId: referenceId ?? reservation._id.toString(),
        idempotencyKey,
        meta: { reservationId: reservation._id, ...meta }
      }], { session });

      if (idempotencyKey) await IdempotencyKey.updateOne({ key: idempotencyKey }, { $set: { result: { reservationId: reservation._id, txId: tx[0]._id } } }, { upsert: true, session });

      return { reservation, tx: tx[0], wallet };
    });
  };

  const getTransactions = async (walletId: string, limit = 50, page = 1) => {
    const skip = (page - 1) * limit;
    return WalletTransaction.find({ walletId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
  };

  const computeAvailable = async (walletId: string) => {
    const w = await Wallet.findById(walletId).lean();
    if (!w) throw createError(404, 'Wallet not found');
    return { balance: w.balance, heldAmount: w.heldAmount, available: w.balance - w.heldAmount };
  };

  return {
    createWallet,
    getWallet,
    deposit,
    withdraw,
    createReservation,
    releaseReservation,
    captureReservation,
    getTransactions,
    computeAvailable
  };
};


⸻

src/workers/reservationExpiry.worker.ts

import mongoose from 'mongoose';
import { WalletReservation } from '../models/WalletReservation';
import { Wallet } from '../models/Wallet';
import { WalletTransaction } from '../models/WalletTransaction';

// Batch expiry worker: find HELD reservations that expired and release them in batches
export const reservationExpiryWorker = async (batchSize = 100) => {
  while (true) {
    const now = new Date();
    const docs = await WalletReservation.find({ status: 'HELD', expiresAt: { $lte: now } }).limit(batchSize).lean();
    if (!docs.length) break;

    // group by wallet to update heldAmount per wallet safely
    const byWallet: Record<string, typeof docs> = {} as any;
    for (const d of docs) {
      byWallet[d.walletId.toString()] = byWallet[d.walletId.toString()] || [];
      byWallet[d.walletId.toString()].push(d);
    }

    // process per-wallet in a transaction
    for (const [walletId, reservations] of Object.entries(byWallet)) {
      const session = await mongoose.startSession();
      session.startTransaction();
      try {
        const total = reservations.reduce((s, r) => s + r.amount, 0);
        const wallet = await Wallet.findOneAndUpdate({ _id: walletId, heldAmount: { $gte: total } }, { $inc: { heldAmount: -total } }, { new: true, session });
        if (!wallet) {
          // inconsistent; mark individually as EXPIRED without changing wallet (alert required)
          for (const r of reservations) {
            await WalletReservation.updateOne({ _id: r._id }, { $set: { status: 'EXPIRED' } }, { session });
            await WalletTransaction.create([{ walletId, type: 'RELEASE', category: 'RIDE', amount: r.amount, currency: r.currency ?? 'USD', beforeBalance: wallet?.balance ?? 0, afterBalance: wallet?.balance ?? 0, heldDelta: -r.amount, referenceId: r._id }], { session });
          }
        } else {
          // update reservation statuses and create release txs
          for (const r of reservations) {
            await WalletReservation.updateOne({ _id: r._id }, { $set: { status: 'EXPIRED' } }, { session });
            await WalletTransaction.create([{ walletId, type: 'RELEASE', category: 'RIDE', amount: r.amount, currency: wallet.currency, beforeBalance: wallet.balance, afterBalance: wallet.balance, heldDelta: -r.amount, referenceId: r._id }], { session });
          }
        }

        await session.commitTransaction();
      } catch (err) {
        await session.abortTransaction();
        console.error('expiry worker error', err);
      } finally {
        session.endSession();
      }
    }
  }
};


⸻

src/utils/errors.ts

import createError from 'http-errors';
export const notFound = (msg = 'Not found') => createError(404, msg);
export const badRequest = (msg = 'Bad request') => createError(400, msg);


⸻

src/index.ts

import { connectMongoose } from './config/mongoose';
import { walletService } from './services/wallet.service';
import dotenv from 'dotenv';
import { reservationExpiryWorker } from './workers/reservationExpiry.worker';

dotenv.config();

(async () => {
  await connectMongoose();
  console.log('Mongo connected');

  const svc = walletService();

  // quick demo flow — create a wallet and run some ops
  const wallet = await svc.createWallet('passenger:1', 'USD', 100000);
  console.log('Created wallet', wallet._id.toString());

  const deposit = await svc.deposit({ walletId: wallet._id.toString(), amount: 20000, referenceId: 'topup-1' });
  console.log('Deposit tx', deposit._id.toString());

  const reservation = await svc.createReservation({ walletId: wallet._id.toString(), amount: 15000, referenceType: 'RIDE', referenceId: 'ride-1' });
  console.log('Reservation', reservation.reservation._id.toString());

  // run expiry worker once (in production, run periodically)
  await reservationExpiryWorker(50);

  process.exit(0);
})();


⸻

tests/concurrency.test.ts

import mongoose from 'mongoose';
import { walletService } from '../src/services/wallet.service';
import dotenv from 'dotenv';
import { Wallet } from '../src/models/Wallet';

dotenv.config();
jest.setTimeout(30000);

describe('concurrency tests', () => {
  let svc: ReturnType<typeof walletService>;
  let walletId: string;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/walletdb?replicaSet=rs0');
    svc = walletService();
    const w = await svc.createWallet('test-user', 'USD', 100000);
    walletId = w._id.toString();
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  test('parallel holds', async () => {
    const holdAmount = 10000; // $100
    const parallel = 15;
    const promises = new Array(parallel).fill(0).map((_, i) =>
      svc.createReservation({ walletId, amount: holdAmount, idempotencyKey: `hold-${i}-${Date.now()}` })
        .then(r => ({ ok: true, r }))
        .catch(e => ({ ok: false, e }))
    );

    const results = await Promise.all(promises);
    const success = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    console.log('success', success, 'fail', fail);
    expect(success * holdAmount).toBeLessThanOrEqual(100000);

    const w = await Wallet.findById(walletId).lean();
    expect(w!.heldAmount).toBe(success * holdAmount);
  });
});


⸻

Run instructions
	1.	git init && git add . && git commit -m "wallet service" (optional)
	2.	npm install
	3.	docker-compose up -d
	4.	docker exec -it mongo_rs mongo --eval 'rs.initiate()' (run once)
	5.	npm run start to run the demo in src/index.ts
	6.	npm run test to run the Jest concurrency test (ensure Mongo replica set is running)

⸻

Notes & next steps
	•	This repo intentionally focuses on the wallet domain only. Integrate into your booking system by calling createReservation when you need to hold funds for a ride, then captureReservation on completion or releaseReservation on cancellation.
	•	For extreme throughput, consider adding a Redis front or per-wallet worker as discussed earlier.
	•	If you want, I can also generate Express controllers + routes (functional) and OpenAPI docs for these endpoints.

⸻

If you’d like, I can export this repository as a zip file or generate the Express API layer next.