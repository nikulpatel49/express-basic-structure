# Ultra-Pro Socket.IO + JWT + uWebSockets.js + Redis Cluster (Pure TS)

This blueprint is a production-grade **TypeScript** setup for handling **1M+ concurrent connections** with **Socket.IO**, **JWT authentication**, **uWebSockets.js** transport, and **Redis Cluster** for horizontal scaling.

---

## Project Structure
```
.
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── k8s/
│   ├── deployment.yaml
│   └── service.yaml
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config/
│   │   └── env.ts
│   ├── core/
│   │   ├── logger.ts
│   │   └── metrics.ts
│   ├── auth/
│   │   └── middleware.ts
│   ├── transport/
│   │   └── adapter.ts
│   ├── events/
│   │   ├── register.ts
│   │   └── handlers/
│   │       ├── chat.ts
│   │       ├── presence.ts
│   │       ├── rooms.ts
│   │       └── notifications.ts
│   └── types/
│       └── socket.ts
```

---

## package.json
```json
{
  "name": "ultra-pro-socketio",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "ts-node-dev --respawn src/index.ts",
    "build": "tsc -p .",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "socket.io": "^4.7.5",
    "uWebSockets.js": "uNetworking/uWebSockets.js#v20.4.0",
    "ioredis": "^5.4.1",
    "pino": "^9.0.0",
    "prom-client": "^15.1.0",
    "zod": "^3.23.8",
    "jose": "^5.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.5.4"
  }
}
```

---

## tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

---

## src/config/env.ts
```ts
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  JWT_SECRET: z.string(),
  REDIS_CLUSTER: z.string().default("127.0.0.1:7000,127.0.0.1:7001"),
  WEBSOCKET_ONLY: z.coerce.boolean().default(true),
  PING_INTERVAL_MS: z.coerce.number().default(25000),
  PING_TIMEOUT_MS: z.coerce.number().default(60000)
});

export const env = envSchema.parse(process.env);
```

---

## src/core/logger.ts
```ts
import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.NODE_ENV !== "production" ? { target: "pino-pretty" } : undefined,
  redact: ["req.headers.authorization", "password"]
});
```

---

## src/core/metrics.ts
```ts
import client from "prom-client";
import { Request, Response } from "express";

client.collectDefaultMetrics();

export const connectedGauge = new client.Gauge({
  name: "socket_connected_clients",
  help: "Number of currently connected clients"
});

export const metricsHandler = () => async (_req: Request, res: Response) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
};
```

---

## src/auth/middleware.ts
```ts
import { verifyJwt } from "jose";
import type { Server, Socket } from "socket.io";
import { env } from "../config/env.js";
import { log } from "../core/logger.js";

export function attachAuth(io: Server) {
  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers["authorization"];
      if (!token) throw new Error("No token provided");

      const secret = new TextEncoder().encode(env.JWT_SECRET);
      const { payload } = await verifyJwt(token.toString().replace("Bearer ", ""), secret, {
        algorithms: ["HS256"]
      });

      socket.data.user = payload;
      next();
    } catch (err) {
      log.warn({ err }, "JWT auth failed");
      next(new Error("Unauthorized"));
    }
  });
}
```

---

## src/transport/adapter.ts
```ts
import { createAdapter } from "@socket.io/redis-adapter";
import { Cluster } from "ioredis";
import { env } from "../config/env.js";

export function makeAdapter() {
  const nodes = env.REDIS_CLUSTER.split(",").map((addr) => {
    const [host, port] = addr.split(":");
    return { host, port: Number(port) };
  });

  const pubClient = new Cluster(nodes);
  const subClient = pubClient.duplicate();
  return createAdapter(pubClient, subClient);
}
```

---

## src/events/register.ts
```ts
import type { Server, Socket } from "socket.io";
import { log } from "../core/logger.js";
import { handleChat } from "./handlers/chat.js";
import { handlePresence } from "./handlers/presence.js";
import { handleRooms } from "./handlers/rooms.js";
import { handleNotifications } from "./handlers/notifications.js";

export function onConnection(io: Server) {
  return (socket: Socket) => {
    log.info({ id: socket.id, user: socket.data.user?.sub }, "socket connected");

    handleChat(io, socket);
    handlePresence(io, socket);
    handleRooms(io, socket);
    handleNotifications(io, socket);

    socket.on("disconnect", (reason) => {
      log.info({ id: socket.id, reason }, "socket disconnected");
    });
  };
}
```

---

## src/events/handlers/chat.ts
```ts
import type { Server, Socket } from "socket.io";
import { log } from "../../core/logger.js";

export function handleChat(io: Server, socket: Socket) {
  socket.on("chat:message", async (msg: { room: string; text: string }) => {
    try {
      log.info({ from: socket.data.user?.sub, msg }, "chat message in");
      io.to(msg.room).emit("chat:message", {
        from: socket.data.user?.sub,
        text: msg.text
      });
    } catch (err) {
      log.error({ err }, "chat error");
    }
  });
}
```

---

## src/events/handlers/presence.ts
```ts
import type { Server, Socket } from "socket.io";
import { log } from "../../core/logger.js";

export function handlePresence(io: Server, socket: Socket) {
  socket.on("presence:update", (status: { online: boolean }) => {
    log.info({ user: socket.data.user?.sub, status }, "presence update");
    io.emit("presence:update", { user: socket.data.user?.sub, ...status });
  });
}
```

---

## src/events/handlers/rooms.ts
```ts
import type { Server, Socket } from "socket.io";
import { log } from "../../core/logger.js";

export function handleRooms(io: Server, socket: Socket) {
  socket.on("room:join", (room: string) => {
    log.info({ user: socket.data.user?.sub, room }, "joining room");
    socket.join(room);
  });

  socket.on("room:leave", (room: string) => {
    log.info({ user: socket.data.user?.sub, room }, "leaving room");
    socket.leave(room);
  });
}
```

---

## src/events/handlers/notifications.ts
```ts
import type { Server, Socket } from "socket.io";
import { log } from "../../core/logger.js";

export function handleNotifications(io: Server, socket: Socket) {
  socket.on("notify", (note: { title: string; body: string }) => {
    log.info({ user: socket.data.user?.sub, note }, "sending notification");
    socket.emit("notify", note);
  });
}
```

---

## src/types/socket.ts
```ts
import type { JwtPayload } from "jose";

declare module "socket.io" {
  interface Socket {
    data: {
      user?: JwtPayload & { sub?: string };
    };
  }
}
```

---

## src/app.ts (uWebSockets.js)
```ts
import { App } from "uWebSockets.js";
import { Server } from "socket.io";
import { env } from "./config/env.js";
import { log } from "./core/logger.js";
import { connectedGauge, metricsHandler } from "./core/metrics.js";
import { makeAdapter } from "./transport/adapter.js";
import { attachAuth } from "./auth/middleware.js";
import { onConnection } from "./events/register.js";

export function buildApp() {
  const app = App();

  app.get("/health", (res) => {
    res.writeStatus("200 OK").end("ok");
  });

  app.get("/metrics", async (res) => {
    let ended = false;
    res.onAborted(() => {
      ended = true;
    });
    try {
      const handler = metricsHandler();
      const fakeRes: any = {
        setHeader: (k: string, v: string) => res.writeHeader(k, v),
        end: (b: string) => {
          if (!ended) res.end(b);
        }
      };
      fakeRes.setHeader("Content-Type", "text/plain; version=0.0.4");
      await handler({} as any, fakeRes);
    } catch (e) {
      if (!ended) res.writeStatus("500 Internal Server Error").end("err");
    }
  });

  const io = new Server({
    transports: env.WEBSOCKET_ONLY ? ["websocket"] : ["websocket", "polling"],
    perMessageDeflate: false,
    pingInterval: env.PING_INTERVAL_MS,
    pingTimeout: env.PING_TIMEOUT_MS,
    connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: false },
    cors: { origin: true, credentials: true }
  });

  io.attachApp(app);
  io.adapter(makeAdapter());

  io.on("connection", () => connectedGauge.inc());
  io.on("disconnect", () => connectedGauge.dec());

  attachAuth(io);
  io.on("connection", onConnection(io));

  const port = env.PORT;
  app.listen(port, (token) => {
    if (token) {
      log.info({ port }, "uWS + Socket.IO up");
    } else {
      log.error("Port in use, failed to bind");
      process.exit(1);
    }
  });

  return { io };
}
```

---

## src/index.ts
```ts
import { buildApp } from "./app.js";

buildApp();
```

---

## Dockerfile
```dockerfile
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN npm run build

EXPOSE 8080
CMD ["node", "dist/index.js"]
```

---

## docker-compose.yml
```yaml
version: "3.9"
services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      - PORT=8080
      - JWT_SECRET=supersecret
      - REDIS_CLUSTER=redis-node-1:7000,redis-node-2:7001
    depends_on:
      - redis-node-1
      - redis-node-2

  redis-node-1:
    image: redis:7
    command: redis-server --port 7000 --cluster-enabled yes --cluster-config-file nodes.conf --cluster-node-timeout 5000 --appendonly yes
    ports:
      - "7000:7000"

  redis-node-2:
    image: redis:7
    command: redis-server --port 7001 --cluster-enabled yes --cluster-config-file nodes.conf --cluster-node-timeout 5000 --appendonly yes
    ports:
      - "7001:7001"
```

---

## k8s/deployment.yaml
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: socketio-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: socketio-app
  template:
    metadata:
      labels:
        app: socketio-app
    spec:
      containers:
        - name: app
          image: your-registry/socketio-app:latest
          ports:
            - containerPort: 8080
          env:
            - name: PORT
              value: "8080"
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: jwt-secret
                  key: secret
            - name: REDIS_CLUSTER
              value: "redis-cluster:6379"
```

---

## k8s/service.yaml
```yaml
apiVersion: v1
kind: Service
metadata:
  name: socketio-service
spec:
  selector:
    app: socketio-app
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
  type: LoadBalancer
```
