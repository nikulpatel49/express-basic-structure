# Stripe Payment Flows for Rideshare (Flow A + Flow B)

**Language:** TypeScript (Node.js + Express + Mongoose)

**Purpose:** Complete production-grade, step-by-step implementation for both

* **Flow A — Pre-authorization → Final capture (manual capture)**
* **Flow B — Immediate charge (automatic capture)**

This document contains architecture, data models, secure implementation details,
Express + Mongoose TypeScript code examples (server), webhook handling, client-side
snippets (Stripe Elements / Mobile), ledger bookkeeping, idempotency, SCA handling,
incremental auth, error & edge-case handling, testing notes, and deployment tips.

---

## Table of contents

1. Goals & assumptions
2. High-level architecture
3. Folder & file structure (repo scaffold)
4. Environment & prerequisites
5. Mongoose models (TypeScript)
6. Utility modules (stripe client, idempotency, ledger helpers)
7. Flow A — Full implementation (preauth → capture → transfer)
8. Flow B — Full implementation (immediate charge)
9. Webhook handler (signature verification & events)
10. Client-side snippets (Stripe Elements / mobile) for SCA
11. Security best practices & operational checklist
12. Edge cases & recovery flows
13. Testing & QA matrix
14. Deployment & monitoring
15. Appendix: example `package.json`, `tsconfig.json`, and helpful scripts

---

## 1. Goals & assumptions

* You are building a rideshare platform (rider, driver) in the UK/EU context (SCA/PSD2).
* Platform uses **Stripe Connect** with **Separate Charges & Transfers**:

  * Platform creates PaymentIntent (charges customer).
  * Platform then creates Transfers to driver connected accounts.
* All code examples are **TypeScript** (Node.js 18+). Mongoose for MongoDB.
* Stripe SDK `stripe` (official) is used.
* Client (mobile/web) uses Stripe Elements or SDKs and never sends raw card numbers to server.
* You will run a webhook endpoint with signature verification.

---

## 2. High-level architecture

* Mobile/Web client (Stripe Elements / Stripe Mobile SDK)
* Backend (Node + Express + TypeScript + Mongoose) — creates PaymentIntent, captures, creates transfers, writes ledger
* Stripe (Platform account) + connected accounts (drivers)
* Webhooks: asynchronous events (payment_intent.* , charge.* , transfer.* , payout.* , dispute.*)

---

## 3. Folder & file structure (suggested)

```
rideshare-payments/
├─ src/
│  ├─ config/
│  │  └─ index.ts
│  ├─ models/
│  │  ├─ User.ts
│  │  ├─ Driver.ts
│  │  ├─ Booking.ts
│  │  └─ LedgerEntry.ts
│  ├─ services/
│  │  ├─ stripeClient.ts
│  │  ├─ paymentService.ts
│  │  ├─ ledgerService.ts
│  │  └─ idempotency.ts
│  ├─ routes/
│  │  ├─ bookings.ts
│  │  ├─ users.ts
│  │  └─ webhooks.ts
│  ├─ utils/
│  │  └─ errorHandler.ts
│  ├─ app.ts
│  └─ server.ts
├─ tests/
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## 4. Environment & prerequisites

**Environment variables** (put in `.env`, use a vault in prod):

```
NODE_ENV=production
PORT=4000
MONGO_URI=mongodb://.../rideshare
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PLATFORM_COMMISSION_PERCENT=20
CURRENCY=gbp
```

**Install**

```bash
npm init -y
npm i express mongoose stripe dotenv helmet cors express-rate-limit
npm i -D typescript ts-node-dev @types/express @types/node @types/cors @types/mongoose
```

**tsconfig.json** (example in appendix)

---

## 5. Mongoose models (TypeScript)

> All amounts stored as integers (cents/pence) to avoid floating point issues.

### `src/models/User.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  stripeCustomerId?: string;
  walletBalance: number; // in cents
}

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  stripeCustomerId: { type: String },
  walletBalance: { type: Number, default: 0 }
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', UserSchema);
```

### `src/models/Driver.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IDriver extends Document {
  name: string;
  email: string;
  stripeAccountId?: string; // connected account id
  payoutSchedule?: { interval: string; delayDays: number };
}

const DriverSchema = new Schema<IDriver>({
  name: String,
  email: String,
  stripeAccountId: String,
  payoutSchedule: { interval: String, delayDays: Number }
}, { timestamps: true });

export const Driver = mongoose.model<IDriver>('Driver', DriverSchema);
```

### `src/models/Booking.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface ITransferRecord { id: string; amount: number; status: string }

export interface IBooking extends Document {
  rider: mongoose.Types.ObjectId;
  driver?: mongoose.Types.ObjectId;
  status: 'requested'|'accepted'|'started'|'completed'|'cancelled';
  estimatedFare: number; // cents
  authorizedAmount?: number; // cents
  finalFare?: number; // cents
  paymentIntentId?: string;
  paymentStatus?: string; // 'requires_action','requires_capture','succeeded','failed'
  commission?: number; // cents
  transfers: ITransferRecord[];
  authExpiresAt?: Date;
}

const TransferRecordSchema = new Schema<ITransferRecord>({ id: String, amount: Number, status: String }, { _id: false });

const BookingSchema = new Schema<IBooking>({
  rider: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  driver: { type: Schema.Types.ObjectId, ref: 'Driver' },
  status: { type: String, default: 'requested' },
  estimatedFare: { type: Number, required: true },
  authorizedAmount: Number,
  finalFare: Number,
  paymentIntentId: String,
  paymentStatus: String,
  commission: Number,
  transfers: [TransferRecordSchema],
  authExpiresAt: Date
}, { timestamps: true });

export const Booking = mongoose.model<IBooking>('Booking', BookingSchema);
```

### `src/models/LedgerEntry.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface ILedger extends Document {
  type: 'charge'|'transfer'|'refund'|'fee'|'adjustment';
  amount: number; // cents
  currency: string;
  referenceId?: string; // pi_... or transfer_...
  bookingId?: mongoose.Types.ObjectId;
  metadata?: Record<string, any>;
}

const LedgerSchema = new Schema<ILedger>({
  type: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'gbp' },
  referenceId: String,
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
  metadata: Schema.Types.Mixed
}, { timestamps: true });

export const LedgerEntry = mongoose.model<ILedger>('LedgerEntry', LedgerSchema);
```

---

## 6. Utility modules (stripe client, idempotency, ledger helpers)

### `src/services/stripeClient.ts`

```ts
import Stripe from 'stripe';
import dotenv from 'dotenv';
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-11-01' });
export default stripe;
```

> Note: Use the latest stable API version and pin it in production. Use `stripe` library to create typed responses.

### `src/services/idempotency.ts`

```ts
// lightweight idempotency key helper. In prod store keys in Redis with TTL for dedupe.
import { v4 as uuidv4 } from 'uuid';

export function generateKey(prefix: string, id: string) {
  return `${prefix}:${id}`;
}
```

### `src/services/ledgerService.ts`

```ts
import { LedgerEntry } from '../models/LedgerEntry';

export async function recordLedger(entry: Partial<Parameters<typeof LedgerEntry.create>[0]>) {
  return LedgerEntry.create(entry);
}
```

---

## 7. Flow A — Pre-authorization → Final capture (full step-by-step)

We will implement endpoints and logic:

* `POST /api/bookings/:id/preauth` → create PaymentIntent with `capture_method: 'manual'` and `confirm: true`.
* Client will handle `requires_action` (3DS) if returned.
* Server saves PI id and auth metadata on Booking.
* On trip completion: `POST /api/bookings/:id/capture` → capture PI with `amount_to_capture` (finalFare) and create Transfers to driver.
* Record ledger entries for charge, fees, transfer, and commission.

### 7.1 `src/routes/bookings.ts` (abridged, full error handling included)

```ts
import express from 'express';
import stripe from '../services/stripeClient';
import { Booking } from '../models/Booking';
import { User } from '../models/User';
import { Driver } from '../models/Driver';
import { recordLedger } from '../services/ledgerService';
import { generateKey } from '../services/idempotency';

const router = express.Router();

// Create pre-auth PaymentIntent (manual capture)
router.post('/:id/preauth', async (req, res) => {
  const bookingId = req.params.id;
  const { payment_method_id } = req.body; // obtained from client
  const booking = await Booking.findById(bookingId).populate('rider');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const user = await User.findById(booking.rider);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // ensure stripe customer
  if (!user.stripeCustomerId) {
    const cus = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user._id.toString() } });
    user.stripeCustomerId = cus.id;
    await user.save();
  }

  const estimated = booking.estimatedFare; // cents

  try {
    const idempotencyKey = generateKey('preauth', bookingId);
    const pi = await stripe.paymentIntents.create({
      amount: estimated,
      currency: process.env.CURRENCY || 'gbp',
      customer: user.stripeCustomerId,
      payment_method: payment_method_id,
      capture_method: 'manual',
      confirm: true,
      description: `Preauth for booking ${bookingId}`,
      metadata: { bookingId }
    }, { idempotencyKey });

    // Save PI info on booking
    booking.paymentIntentId = pi.id;
    booking.authorizedAmount = pi.amount; // may equal estimated
    booking.paymentStatus = pi.status; // e.g., requires_action / requires_capture
    booking.authExpiresAt = new Date(Date.now() + (7 * 24 * 3600 * 1000)); // conservative; real depends on card
    await booking.save();

    // Ledger: record authorization (informational)
    await recordLedger({ type: 'charge', amount: pi.amount_capturable ?? 0, currency: pi.currency, referenceId: pi.id, bookingId: booking._id, metadata: { status: pi.status } });

    res.json({ paymentIntent: pi });
  } catch (err: any) {
    console.error('preauth error', err);
    res.status(400).json({ error: err.message });
  }
});

// Capture endpoint (called when trip completes)
router.post('/:id/capture', async (req, res) => {
  const bookingId = req.params.id;
  const booking = await Booking.findById(bookingId).populate('driver rider');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.paymentIntentId) return res.status(400).json({ error: 'No preauth present' });

  // compute final fare server-side using distance/time/surge
  const finalFare = req.body.finalFare; // cents — compute on server in prod

  try {
    const idempotencyKey = generateKey('capture', bookingId);
    const cap = await stripe.paymentIntents.capture(booking.paymentIntentId!, { amount_to_capture: finalFare }, { idempotencyKey });

    // record charge in ledger
    await recordLedger({ type: 'charge', amount: finalFare, currency: cap.currency, referenceId: cap.id, bookingId: booking._id });

    // compute commission & driver amount
    const commissionPercent = Number(process.env.PLATFORM_COMMISSION_PERCENT || 20);
    const commission = Math.round(finalFare * (commissionPercent / 100));
    const driverAmount = finalFare - commission;

    // create transfer to driver connected account
    const driver = await Driver.findById(booking.driver);
    if (!driver || !driver.stripeAccountId) {
      // handle missing connected account — keep funds on platform until driver completes onboarding
      booking.paymentStatus = 'succeeded';
      booking.finalFare = finalFare;
      booking.commission = commission;
      await booking.save();

      // ledger: record commission (platform holds)
      await recordLedger({ type: 'fee', amount: commission, currency: cap.currency, bookingId: booking._id, referenceId: cap.id });

      return res.json({ success: true, captured: cap, transfer: null, note: 'Driver not onboarded; funds retained' });
    }

    const transferKey = generateKey('transfer', bookingId);
    const transfer = await stripe.transfers.create({ amount: driverAmount, currency: cap.currency, destination: driver.stripeAccountId, metadata: { bookingId: booking._id.toString(), paymentIntentId: cap.id } }, { idempotencyKey: transferKey });

    // ledger entries for transfer + commission
    await recordLedger({ type: 'transfer', amount: driverAmount, currency: cap.currency, referenceId: transfer.id, bookingId: booking._id });
    await recordLedger({ type: 'fee', amount: commission, currency: cap.currency, bookingId: booking._id, referenceId: cap.id });

    booking.finalFare = finalFare;
    booking.commission = commission;
    booking.paymentStatus = 'succeeded';
    booking.transfers.push({ id: transfer.id, amount: driverAmount, status: transfer.status });
    booking.captureAt = new Date();
    await booking.save();

    res.json({ success: true, captured: cap, transfer });
  } catch (err: any) {
    console.error('capture error', err);
    booking.paymentStatus = 'failed';
    await booking.save();
    res.status(402).json({ error: err.message });
  }
});

export default router;
```

### 7.2 Notes & best practices for Flow A

* **Idempotency:** use idempotency keys (Redis recommended) to prevent duplicate creates/captures on retries.
* **Auth expiration:** card authorizations typically have expiry windows — implement background job to check and re-authorize if needed.
* **Incremental auth:** if finalFare > authorized, use `stripe.paymentIntents.incrementAuthorization` where supported; otherwise create a new PI for the remainder.
* **Off-session vs on-session:** when preauth happens with customer present use `off_session: false`; for later off-session captures you may need `off_session: true` with saved PM and SCA handling.

---

## 8. Flow B — Immediate charge (automatic capture)

Flow B is simpler (good for fixed-price bookings or pre-paid rides). Steps:

* `POST /api/bookings/:id/charge` → create PaymentIntent with `capture_method: 'automatic'` (default) and `confirm: true`.
* On `payment_intent.succeeded` update booking to paid.
* Immediately create transfer to driver or wait until settlement depending on policy.

### 8.1 Example route (immediate charge)

```ts
// in src/routes/bookings.ts
router.post('/:id/charge', async (req, res) => {
  const bookingId = req.params.id;
  const booking = await Booking.findById(bookingId).populate('rider driver');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const user = await User.findById(booking.rider);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const amount = booking.estimatedFare; // or final fare for pre-paid booking
  try {
    const idempotencyKey = generateKey('charge', bookingId);
    const pi = await stripe.paymentIntents.create({ amount, currency: process.env.CURRENCY || 'gbp', customer: user.stripeCustomerId, payment_method: req.body.payment_method_id, confirm: true, description: `Charge for booking ${bookingId}`, metadata: { bookingId } }, { idempotencyKey });

    // if requires_action, return client_secret to finish SCA on client
    if (pi.status === 'requires_action') return res.json({ requiresAction: true, clientSecret: pi.client_secret });

    // success: update booking and optionally transfer
    booking.paymentIntentId = pi.id;
    booking.finalFare = amount;
    booking.paymentStatus = pi.status;
    await booking.save();

    // transfer to driver (same as Flow A) — optionally wait until captured success
    res.json({ success: true, paymentIntent: pi });
  } catch (err: any) {
    console.error('charge error', err);
    res.status(400).json({ error: err.message });
  }
});
```

---

## 9. Webhook handler (signature verification & events)

**Important:** Use `express.raw({ type: 'application/json' })` for webhook endpoint to compute signature correctly.

### `src/routes/webhooks.ts`

```ts
import express from 'express';
import stripe from '../services/stripeClient';
import { Booking } from '../models/Booking';
import { recordLedger } from '../services/ledgerService';

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  if (!sig) return res.status(400).send('Missing signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // handle important events
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      // find booking by metadata.bookingId or PaymentIntent id
      const booking = await Booking.findOne({ paymentIntentId: pi.id });
      if (booking) {
        booking.paymentStatus = 'succeeded';
        booking.finalFare = booking.finalFare ?? pi.amount;
        await booking.save();
        await recordLedger({ type: 'charge', amount: pi.amount, currency: pi.currency, referenceId: pi.id, bookingId: booking._id });
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const booking = await Booking.findOne({ paymentIntentId: pi.id });
      if (booking) {
        booking.paymentStatus = 'failed';
        await booking.save();
      }
      break;
    }
    case 'charge.refunded': {
      const charge = event.data.object as any; // keep typing pragmatic
      const booking = await Booking.findOne({ paymentIntentId: charge.payment_intent });
      if (booking) {
        // record refund ledger entry
        await recordLedger({ type: 'refund', amount: charge.amount_refunded, currency: charge.currency, referenceId: charge.id, bookingId: booking._id });
        booking.paymentStatus = 'refunded';
        await booking.save();
      }
      break;
    }
    case 'transfer.failed': {
      // handle transfer failures (notify ops, retry or fallback)
      break;
    }
    case 'payout.paid': {
      // reconcile driver payouts
      break;
    }
    case 'charge.dispute.created': {
      // store dispute evidence, notify ops
      break;
    }
    default:
      // handle other events as needed
      break;
  }

  res.status(200).json({ received: true });
});

export default router;
```

**Webhook best practices:**

* Verify signature using `STRIPE_WEBHOOK_SECRET`.
* Persist all incoming events for audit.
* Use idempotency when processing non-idempotent operations (e.g., creating transfers caused by a webhook).
* Return 2xx quickly — run heavy processing in background jobs.

---

## 10. Client-side snippets (Stripe Elements / Mobile) for SCA

### Web (Stripe Elements) — handle `requires_action`

```html
<script src="https://js.stripe.com/v3/"></script>
<script>
  const stripe = Stripe('pk_live_...');
  // After client calls server /preauth and gets pi.client_secret
  async function handleAction(clientSecret) {
    const result = await stripe.handleCardAction(clientSecret);
    if (result.error) {
      // 3DS failed or canceled
      console.error(result.error);
      return { success: false, error: result.error };
    }
    // confirm completed on client; server will receive webhook
    return { success: true };
  }
</script>
```

### Mobile (iOS / Android) — use Stripe SDK's `handleNextActionForPayment` equivalent.

**Notes:** Always check `paymentIntent.status` on the server and update booking only after `succeeded` or after webhook confirmation.

---

## 11. Security best practices & pro tips

* **Never** store full card data. Use PaymentMethod/Customer/SetupIntent.
* **Use webhook signature verification** and store `STRIPE_WEBHOOK_SECRET` securely.
* **Idempotency & retries**: use Redis to store idempotency keys with TTL.
* **Encrypt secrets** at rest; use secrets manager in production.
* **Least privilege**: if possible use restricted API keys for limited operations.
* **PCI scope**: using Stripe Elements + Checkout keeps most of your system out of PCI scope (SAQ A).
* **Rate limit payment endpoints** to mitigate brute force & fraud.
* **Monitor & alert**: payment failure spikes, increased disputes, large refunds, transfer failures.
* **Server-side amount calculation** — never trust client-provided amounts for capture.
* **Logging**: store only non-sensitive identifiers (pi id, last4, brand) and minimal metadata.

---

## 12. Edge cases & recovery flows

1. **Auth expires before capture**: re-authorize with saved PM or prompt rider to re-auth. Implement background job to reauth before expiry.
2. **Final > authorized**: attempt incremental auth; if unsupported create a new PI for the remainder.
3. **Insufficient funds at capture**: mark booking `payment_failed`, instruct user to add another PM, attempt capture again.
4. **Refund after transfer**: platform may need to reverse transfer or debit driver; record ledger adjustments and follow your terms.
5. **Dispute**: collect evidence (trip route, driver/rider messages, timestamps). Use Stripe dispute API to submit evidence.
6. **Transfer/payout failed**: detect via webhook and retry or notify ops.

---

## 13. Testing & QA matrix

* Unit tests for amounts calculation, ledger entries.
* End-to-end using Stripe test keys to simulate:

  * Successful preauth → capture
  * `requires_action` (3DS) scenarios
  * Incremental auth
  * Capture failure & retry
  * Refunds & disputes
  * Transfer success & failure
* Webhook replay & duplicate event handling
* Load tests focusing on idempotency and DB concurrency

---

## 14. Deployment & monitoring

* Deploy behind HTTPS (TLS). Use HSTS.
* Use a separate domain/path for webhooks and IP-allowlist if possible.
* Use centralized logging (e.g., ELK / Datadog) with alerting for thresholds.
* Run daily reconciliation job comparing Stripe transactions to platform ledger.

---

## 15. Appendix: `package.json`, `tsconfig.json` and scripts

### `package.json` (example)

```json
{
  "name": "rideshare-payments",
  "version": "1.0.0",
  "main": "dist/server.js",
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.2",
    "helmet": "^6.0.0",
    "mongoose": "^7.0.0",
    "stripe": "^12.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.13",
    "@types/node": "^18.0.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.0.0"
  }
}
```

### `tsconfig.json` (example)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

---

### Final notes

This document is intentionally pragmatic and ready to be converted directly into a repository. It focuses on **Flow A** (preauth → capture) and **Flow B** (immediate capture) with security, SCA, and Connect concerns for UK/EU.

If you want, I can now:

* Generate the full TypeScript repository files (one by one) for you to copy/paste, or
* Create a GitHub gist / zipped repository (I will produce file contents here), or
* Produce a Postman collection / test scripts for the flows.

Tell me which of the above you'd like next and I'll generate the files immediately.

---

## 16. Generated repository files (full TypeScript file contents)

Below are the complete file contents you can copy into your project. Files included:

* `package.json`
* `tsconfig.json`
* `src/app.ts`
* `src/server.ts`
* `src/config/index.ts`
* `src/services/stripeClient.ts`
* `src/services/idempotency.ts`
* `src/services/ledgerService.ts`
* `src/models/User.ts`
* `src/models/Driver.ts`
* `src/models/Booking.ts`
* `src/models/LedgerEntry.ts`
* `src/routes/bookings.ts`
* `src/routes/users.ts`
* `src/routes/webhooks.ts`
* `src/utils/errorHandler.ts`

Copy each file into the paths above.

---

### `package.json`

```json
{
  "name": "rideshare-payments",
  "version": "1.0.0",
  "main": "dist/server.js",
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.2",
    "helmet": "^6.0.0",
    "mongoose": "^7.0.0",
    "stripe": "^12.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.13",
    "@types/node": "^18.0.0",
    "@types/cors": "^2.8.12",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.1.6"
  }
}
```

---

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

---

### `src/app.ts`

```ts
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import bookingsRouter from './routes/bookings';
import usersRouter from './routes/users';
import webhooksRouter from './routes/webhooks';

dotenv.config();

const app = express();

// Security middlewares
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting for sensitive endpoints
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });
app.use(limiter);

// Routes
app.use('/api/bookings', bookingsRouter);
app.use('/api/users', usersRouter);
// webhook route uses raw body parsing in route file
app.use('/webhook', webhooksRouter);

// health
app.get('/health', (req, res) => res.json({ ok: true }));

export default app;
```

---

### `src/server.ts`

```ts
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import app from './app';

dotenv.config();

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/rideshare';

async function start() {
  await mongoose.connect(MONGO_URI, { dbName: 'rideshare' });
  console.log('Connected to MongoDB');
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to start', err);
  process.exit(1);
});
```

---

### `src/config/index.ts`

```ts
import dotenv from 'dotenv';
dotenv.config();

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY!;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
export const CURRENCY = process.env.CURRENCY || 'gbp';
export const PLATFORM_COMMISSION_PERCENT = Number(process.env.PLATFORM_COMMISSION_PERCENT || 20);
```

---

### `src/services/stripeClient.ts`

```ts
import Stripe from 'stripe';
import { STRIPE_SECRET_KEY } from '../config';

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-11-01' });
export default stripe;
```

---

### `src/services/idempotency.ts`

```ts
export function generateKey(prefix: string, id: string) {
  return `${prefix}:${id}`;
}
```

---

### `src/services/ledgerService.ts`

```ts
import { LedgerEntry } from '../models/LedgerEntry';

export async function recordLedger(entry: Partial<any>) {
  return LedgerEntry.create(entry);
}
```

---

### `src/models/User.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  stripeCustomerId?: string;
  walletBalance: number;
}

const UserSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  stripeCustomerId: { type: String },
  walletBalance: { type: Number, default: 0 }
}, { timestamps: true });

export const User = mongoose.model<IUser>('User', UserSchema);
```

---

### `src/models/Driver.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IDriver extends Document {
  name: string;
  email: string;
  stripeAccountId?: string;
  payoutSchedule?: { interval: string; delayDays: number };
}

const DriverSchema = new Schema<IDriver>({
  name: String,
  email: String,
  stripeAccountId: String,
  payoutSchedule: { interval: String, delayDays: Number }
}, { timestamps: true });

export const Driver = mongoose.model<IDriver>('Driver', DriverSchema);
```

---

### `src/models/Booking.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface ITransferRecord { id: string; amount: number; status: string }

export interface IBooking extends Document {
  rider: mongoose.Types.ObjectId;
  driver?: mongoose.Types.ObjectId;
  status: 'requested'|'accepted'|'started'|'completed'|'cancelled';
  estimatedFare: number;
  authorizedAmount?: number;
  finalFare?: number;
  paymentIntentId?: string;
  paymentStatus?: string;
  commission?: number;
  transfers: ITransferRecord[];
  authExpiresAt?: Date;
}

const TransferRecordSchema = new Schema<ITransferRecord>({ id: String, amount: Number, status: String }, { _id: false });

const BookingSchema = new Schema<IBooking>({
  rider: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  driver: { type: Schema.Types.ObjectId, ref: 'Driver' },
  status: { type: String, default: 'requested' },
  estimatedFare: { type: Number, required: true },
  authorizedAmount: Number,
  finalFare: Number,
  paymentIntentId: String,
  paymentStatus: String,
  commission: Number,
  transfers: [TransferRecordSchema],
  authExpiresAt: Date
}, { timestamps: true });

export const Booking = mongoose.model<IBooking>('Booking', BookingSchema);
```

---

### `src/models/LedgerEntry.ts`

```ts
import mongoose, { Document, Schema } from 'mongoose';

export interface ILedger extends Document {
  type: 'charge'|'transfer'|'refund'|'fee'|'adjustment';
  amount: number;
  currency: string;
  referenceId?: string;
  bookingId?: mongoose.Types.ObjectId;
  metadata?: Record<string, any>;
}

const LedgerSchema = new Schema<ILedger>({
  type: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'gbp' },
  referenceId: String,
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
  metadata: Schema.Types.Mixed
}, { timestamps: true });

export const LedgerEntry = mongoose.model<ILedger>('LedgerEntry', LedgerSchema);
```

---

### `src/routes/bookings.ts`

```ts
import express from 'express';
import stripe from '../services/stripeClient';
import { Booking } from '../models/Booking';
import { User } from '../models/User';
import { Driver } from '../models/Driver';
import { recordLedger } from '../services/ledgerService';
import { generateKey } from '../services/idempotency';
import { PLATFORM_COMMISSION_PERCENT, CURRENCY } from '../config';

const router = express.Router();

// Create pre-auth PaymentIntent (manual capture)
router.post('/:id/preauth', async (req, res) => {
  const bookingId = req.params.id;
  const { payment_method_id } = req.body;
  const booking = await Booking.findById(bookingId).populate('rider');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const user = await User.findById(booking.rider);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (!user.stripeCustomerId) {
    const cus = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user._id.toString() } });
    user.stripeCustomerId = cus.id;
    await user.save();
  }

  const estimated = booking.estimatedFare;
  try {
    const idempotencyKey = generateKey('preauth', bookingId);
    const pi = await stripe.paymentIntents.create({
      amount: estimated,
      currency: CURRENCY,
      customer: user.stripeCustomerId,
      payment_method: payment_method_id,
      capture_method: 'manual',
      confirm: true,
      description: `Preauth for booking ${bookingId}`,
      metadata: { bookingId }
    }, { idempotencyKey });

    booking.paymentIntentId = pi.id;
    booking.authorizedAmount = pi.amount;
    booking.paymentStatus = pi.status;
    booking.authExpiresAt = new Date(Date.now() + (7 * 24 * 3600 * 1000));
    await booking.save();

    await recordLedger({ type: 'charge', amount: pi.amount_capturable ?? 0, currency: pi.currency, referenceId: pi.id, bookingId: booking._id, metadata: { status: pi.status } });

    res.json({ paymentIntent: pi });
  } catch (err: any) {
    console.error('preauth error', err);
    res.status(400).json({ error: err.message });
  }
});

// Capture endpoint (called when trip completes)
router.post('/:id/capture', async (req, res) => {
  const bookingId = req.params.id;
  const booking = await Booking.findById(bookingId).populate('driver rider');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (!booking.paymentIntentId) return res.status(400).json({ error: 'No preauth present' });

  const finalFare = req.body.finalFare;
  try {
    const idempotencyKey = generateKey('capture', bookingId);
    const cap = await stripe.paymentIntents.capture(booking.paymentIntentId!, { amount_to_capture: finalFare }, { idempotencyKey });

    await recordLedger({ type: 'charge', amount: finalFare, currency: cap.currency, referenceId: cap.id, bookingId: booking._id });

    const commissionPercent = PLATFORM_COMMISSION_PERCENT;
    const commission = Math.round(finalFare * (commissionPercent / 100));
    const driverAmount = finalFare - commission;

    const driver = await Driver.findById(booking.driver);
    if (!driver || !driver.stripeAccountId) {
      booking.paymentStatus = 'succeeded';
      booking.finalFare = finalFare;
      booking.commission = commission;
      await booking.save();

      await recordLedger({ type: 'fee', amount: commission, currency: cap.currency, bookingId: booking._id, referenceId: cap.id });

      return res.json({ success: true, captured: cap, transfer: null, note: 'Driver not onboarded; funds retained' });
    }

    const transferKey = generateKey('transfer', bookingId);
    const transfer = await stripe.transfers.create({ amount: driverAmount, currency: cap.currency, destination: driver.stripeAccountId, metadata: { bookingId: booking._id.toString(), paymentIntentId: cap.id } }, { idempotencyKey: transferKey });

    await recordLedger({ type: 'transfer', amount: driverAmount, currency: cap.currency, referenceId: transfer.id, bookingId: booking._id });
    await recordLedger({ type: 'fee', amount: commission, currency: cap.currency, bookingId: booking._id, referenceId: cap.id });

    booking.finalFare = finalFare;
    booking.commission = commission;
    booking.paymentStatus = 'succeeded';
    booking.transfers.push({ id: transfer.id, amount: driverAmount, status: transfer.status });
    booking.captureAt = new Date();
    await booking.save();

    res.json({ success: true, captured: cap, transfer });
  } catch (err: any) {
    console.error('capture error', err);
    booking.paymentStatus = 'failed';
    await booking.save();
    res.status(402).json({ error: err.message });
  }
});

// Immediate charge (Flow B)
router.post('/:id/charge', async (req, res) => {
  const bookingId = req.params.id;
  const booking = await Booking.findById(bookingId).populate('rider driver');
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const user = await User.findById(booking.rider);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const amount = booking.estimatedFare;
  try {
    const idempotencyKey = generateKey('charge', bookingId);
    const pi = await stripe.paymentIntents.create({ amount, currency: CURRENCY, customer: user.stripeCustomerId, payment_method: req.body.payment_method_id, confirm: true, description: `Charge for booking ${bookingId}`, metadata: { bookingId } }, { idempotencyKey });

    if (pi.status === 'requires_action') return res.json({ requiresAction: true, clientSecret: pi.client_secret });

    booking.paymentIntentId = pi.id;
    booking.finalFare = amount;
    booking.paymentStatus = pi.status;
    await booking.save();

    res.json({ success: true, paymentIntent: pi });
  } catch (err: any) {
    console.error('charge error', err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
```

---

### `src/routes/users.ts`

```ts
import express from 'express';
import { User } from '../models/User';
import stripe from '../services/stripeClient';
import { generateKey } from '../services/idempotency';

const router = express.Router();

// create or return stripe customer for user
router.post('/:id/create-customer', async (req, res) => {
  const userId = req.params.id;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.stripeCustomerId) return res.json({ stripeCustomerId: user.stripeCustomerId });

  const cus = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user._id.toString() } });
  user.stripeCustomerId = cus.id;
  await user.save();
  res.json({ stripeCustomerId: cus.id });
});

export default router;
```

---

### `src/routes/webhooks.ts`

```ts
import express from 'express';
import stripe from '../services/stripeClient';
import { STRIPE_WEBHOOK_SECRET } from '../config';
import { Booking } from '../models/Booking';
import { recordLedger } from '../services/ledgerService';

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  if (!sig) return res.status(400).send('Missing signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const booking = await Booking.findOne({ paymentIntentId: pi.id });
        if (booking) {
          booking.paymentStatus = 'succeeded';
          booking.finalFare = booking.finalFare ?? pi.amount;
          await booking.save();
          await recordLedger({ type: 'charge', amount: pi.amount, currency: pi.currency, referenceId: pi.id, bookingId: booking._id });
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as Stripe.PaymentIntent;
        const booking = await Booking.findOne({ paymentIntentId: pi.id });
        if (booking) {
          booking.paymentStatus = 'failed';
          await booking.save();
        }
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as any;
        const booking = await Booking.findOne({ paymentIntentId: charge.payment_intent });
        if (booking) {
          await recordLedger({ type: 'refund', amount: charge.amount_refunded, currency: charge.currency, referenceId: charge.id, bookingId: booking._id });
          booking.paymentStatus = 'refunded';
          await booking.save();
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('Webhook processing failed', err);
  }

  res.status(200).json({ received: true });
});

export default router;
```

---

### `src/utils/errorHandler.ts`

```ts
import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
}
```

---

## Next steps

1. Paste these files into your project structure.
2. Create `.env` using the environment variables in the main document.
3. Run `npm install` and `npm run dev` to start in dev mode.
4. Use Stripe test keys and run through Flow A and B flows with Stripe test cards (including 3DS test cards).

If you want, I can now generate Postman collection & example curl commands, or create the same files as a downloadable zip. Which do you prefer?
