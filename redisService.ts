// utils/redisService.ts
import Redis, { Redis as RedisClient, RedisOptions, Pipeline } from "ioredis";
import config from "../config/redis.config";
import { logger } from "./logger";

type RedisValue = string | number | object | null;

let client: RedisClient | null = null;
let subscriberClient: RedisClient | null = null;

// ---------------- Init ----------------
export const initClient = async (): Promise<RedisClient> => {
  if (!client) {
    const options: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      db: config.db ?? 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    };

    client = new Redis(options);

    client.on("connect", () => logger.info("✅ Redis connected"));
    client.on("error", (err) => logger.error("❌ Redis error:", err));
    client.on("reconnecting", () => logger.warn("🔄 Redis reconnecting..."));
  }
  return client;
};

export const initSubscriber = async (): Promise<RedisClient> => {
  if (!subscriberClient) {
    const mainClient = await initClient();
    subscriberClient = mainClient.duplicate();
  }
  return subscriberClient;
};

// ---------------- Helpers ----------------
const isValidKey = (key: unknown): key is string =>
  typeof key === "string" && key.trim().length > 0;

const toStr = (val: RedisValue): string =>
  typeof val === "string" ? val : JSON.stringify(val);

const safeJsonParse = (val: string): any => {
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
};

// ---------------- Cache ----------------
export const setCache = async (
  key: string,
  value: RedisValue,
  ttl?: number,
  mode?: "NX" | "XX",
  keepTTL?: boolean
) => {
  if (!isValidKey(key)) return;
  const redis = await initClient();
  const args: (string | number)[] = [key, toStr(value)];

  if (ttl && ttl > 0) args.push("EX", ttl);
  if (mode) args.push(mode);
  if (keepTTL) args.push("KEEPTTL");

  return redis.set(...(args as [string, string, ...any[]]));
};

export const setNX = async (key: string, value: RedisValue, ttl?: number) =>
  setCache(key, value, ttl, "NX");

export const getCache = async <T = any>(key: string): Promise<T | null> => {
  if (!isValidKey(key)) return null;
  const redis = await initClient();
  const val = await redis.get(key);
  return val ? safeJsonParse(val) : null;
};

export const deleteCache = async (key: string) => {
  if (!isValidKey(key)) return;
  const redis = await initClient();
  return redis.del(key);
};

// ---------------- Pub/Sub ----------------
export const publishMessage = async (channel: string, message: RedisValue) => {
  if (!isValidKey(channel)) return;
  const redis = await initClient();
  return redis.publish(channel, toStr(message));
};

export const subscribeToChannel = async (
  channel: string,
  handlerFn: (message: any) => void
) => {
  if (!isValidKey(channel) || typeof handlerFn !== "function") return;
  const sub = await initSubscriber();
  await sub.subscribe(channel);
  sub.on("message", (ch, msg) => {
    if (ch === channel) handlerFn(safeJsonParse(msg));
  });
};

// ---------------- Hash Ops ----------------
export const hSet = async (key: string, field: string, value: RedisValue) => {
  const redis = await initClient();
  return redis.hset(key, field, toStr(value));
};

export const hGet = async <T = any>(
  key: string,
  field: string
): Promise<T | null> => {
  const redis = await initClient();
  const val = await redis.hget(key, field);
  return val ? safeJsonParse(val) : null;
};

export const hGetAll = async <T = any>(
  key: string
): Promise<Record<string, T>> => {
  const redis = await initClient();
  const data = await redis.hgetall(key);
  Object.keys(data).forEach((k) => (data[k] = safeJsonParse(data[k])));
  return data as Record<string, T>;
};

// ---------------- Set Ops ----------------
export const sAdd = async (key: string, ...members: string[]) => {
  const redis = await initClient();
  return redis.sadd(key, ...members);
};

export const sMembers = async (key: string) => {
  const redis = await initClient();
  return redis.smembers(key);
};

// ---------------- Sorted Set Ops ----------------
export const zAdd = async (key: string, score: number, member: string) => {
  const redis = await initClient();
  return redis.zadd(key, score, member);
};

export const zRange = async (key: string, start: number, stop: number) => {
  const redis = await initClient();
  return redis.zrange(key, start, stop);
};

// ---------------- Expire / TTL ----------------
export const expireKey = async (key: string, ttlSec: number) => {
  const redis = await initClient();
  return redis.expire(key, ttlSec);
};

export const ttl = async (key: string) => {
  const redis = await initClient();
  return redis.ttl(key);
};

// ---------------- Counter ----------------
export const incr = async (key: string) => {
  const redis = await initClient();
  return redis.incr(key);
};

export const decr = async (key: string) => {
  const redis = await initClient();
  return redis.decr(key);
};

// ---------------- Pipeline / Multi ----------------
export const getPipeline = async (): Promise<Pipeline> => {
  const redis = await initClient();
  return redis.pipeline();
};

export const getMulti = async () => {
  const redis = await initClient();
  return redis.multi();
};

// ---------------- Lua Script Registry ----------------
type ScriptEntry = { sha: string; code: string };
const scriptRegistry: Record<string, ScriptEntry> = {};

export const registerScript = async (
  name: string,
  luaScript: string
): Promise<void> => {
  const redis = await initClient();
  const sha = await redis.script("load", luaScript.toString());
  scriptRegistry[name] = { sha, code: luaScript };
  logger.info(`📜 Registered Lua script "${name}" → SHA: ${sha}`);
};

export const runScript = async (
  name: string,
  numKeys: number,
  keys: string[] = [],
  args: (string | number)[] = []
): Promise<any> => {
  const redis = await initClient();
  const script = scriptRegistry[name];
  if (!script) throw new Error(`Script "${name}" not registered`);

  try {
    return await redis.evalsha(script.sha, numKeys, ...keys, ...args);
  } catch (err: any) {
    if (err?.message?.includes("NOSCRIPT")) {
      logger.warn(`⚠️ Script "${name}" missing in Redis, reloading...`);
      const newSha = await redis.script("load", script.code);
      scriptRegistry[name].sha = newSha;
      return redis.evalsha(newSha, numKeys, ...keys, ...args);
    }
    throw err;
  }
};
