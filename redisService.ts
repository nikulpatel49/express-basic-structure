// utils/redisService.ts

import Redis, { Redis as RedisClient, RedisOptions } from "ioredis";
import { isString, isNumber, isFunction } from "lodash";
import config from "../config/redis.config";
import { logger } from "./logger";

let client: RedisClient | null = null;
let subscriberClient: RedisClient | null = null;

const initClient = async (): Promise<RedisClient> => {
	if (!client) {
		const options: RedisOptions = {
			host: config.host,
			port: config.port,
			password: config.password || undefined,
		};

		client = new Redis(options);

		client.on("connect", () => logger.info("✅ Redis connected"));
		client.on("error", (err) => logger.error("❌ Redis error:", err));
		client.on("reconnecting", () => logger.warn("🔄 Redis reconnecting..."));
	}

	return client;
};

const initSubscriber = async (): Promise<RedisClient> => {
	if (!subscriberClient) {
		const mainClient = await initClient();
		subscriberClient = mainClient.duplicate();
	}
	return subscriberClient;
};

const isValidKey = (key: unknown): key is string =>
	isString(key) && key.trim() !== "";

const toStr = (val: any): string => (isString(val) ? val : JSON.stringify(val));

const safeJsonParse = (val: string): any => {
	try {
		return JSON.parse(val);
	} catch {
		return val;
	}
};

// ==================== Cache ====================

export const setCache = async (key: string, value: any, ttl?: number) => {
	if (!isValidKey(key)) return;
	const redisClient = await initClient();
	const stringValue = toStr(value);

	if (isNumber(ttl) && ttl > 0) {
		return redisClient.set(key, stringValue, "EX", ttl);
	}
	return redisClient.set(key, stringValue);
};

export const getCache = async (key: string) => {
	if (!isValidKey(key)) return null;
	const redisClient = await initClient();
	const val = await redisClient.get(key);
	return val ? safeJsonParse(val) : null;
};

export const deleteCache = async (key: string) => {
	if (!isValidKey(key)) return;
	const redisClient = await initClient();
	return redisClient.del(key);
};

export const publishMessage = async (channel: string, message: any) => {
	if (!isValidKey(channel)) return;
	const redisClient = await initClient();
	return redisClient.publish(channel, toStr(message));
};

export const subscribeToChannel = async (
	channel: string,
	handlerFn: (message: any) => void
) => {
	if (!isValidKey(channel) || !isFunction(handlerFn)) return;
	const subClient = await initSubscriber();
	await subClient.subscribe(channel);
	subClient.on("message", (ch, msg) => {
		if (ch === channel) {
			handlerFn(safeJsonParse(msg));
		}
	});
};

// ==================== RedisBloom, CMS, TopK, Cuckoo ====================

const sendCommand = async (args: string[]) => {
	const redisClient = await initClient();
	return redisClient.call(...args);
};

// ------------------ Bloom Filter ------------------

export const reserveBloom = (key: string, errorRate = 0.01, capacity = 10000) =>
	sendCommand(["BF.RESERVE", key, errorRate.toString(), capacity.toString()]);

export const addBloom = (key: string, item: string) =>
	sendCommand(["BF.ADD", key, item]);

export const addManyBloom = (key: string, items: string[]) =>
	sendCommand(["BF.MADD", key, ...items]);

export const existsBloom = (key: string, item: string) =>
	sendCommand(["BF.EXISTS", key, item]);

export const existsManyBloom = (key: string, items: string[]) =>
	sendCommand(["BF.MEXISTS", key, ...items]);

export const infoBloom = (key: string) =>
	sendCommand(["BF.INFO", key]);

// ------------------ Scalable Bloom ------------------

export const reserveScalableBloom = (
	key: string,
	errorRate = 0.01,
	capacity = 10000
) =>
	sendCommand([
		"BF.SCANDDFILTER.RESERVE",
		key,
		errorRate.toString(),
		capacity.toString(),
	]);

export const addScalableBloom = (key: string, item: string) =>
	sendCommand(["BF.SCANDDFILTER.ADD", key, item]);

export const existsScalableBloom = (key: string, item: string) =>
	sendCommand(["BF.SCANDDFILTER.EXISTS", key, item]);

export const infoScalableBloom = (key: string) =>
	sendCommand(["BF.SCANDDFILTER.INFO", key]);

// ------------------ Count-Min Sketch ------------------

export const reserveCMS = (
	key: string,
	width = 1000,
	depth = 5,
	errorRate = 0.01
) =>
	sendCommand([
		"CMS.RESERVE",
		key,
		width.toString(),
		depth.toString(),
		errorRate.toString(),
	]);

export const incrCMS = (key: string, item: string, count = 1) =>
	sendCommand(["CMS.INCRBY", key, item, count.toString()]);

export const queryCMS = (key: string, item: string) =>
	sendCommand(["CMS.QUERY", key, item]);

// ------------------ Top-K ------------------

export const reserveTopK = (
	key: string,
	k = 10,
	width = 1000,
	depth = 5
) =>
	sendCommand([
		"TOPK.RESERVE",
		key,
		k.toString(),
		width.toString(),
		depth.toString(),
	]);

export const addTopK = (key: string, item: string) =>
	sendCommand(["TOPK.ADD", key, item]);

export const queryTopK = (key: string, item: string) =>
	sendCommand(["TOPK.QUERY", key, item]);

// ------------------ Cuckoo Filter ------------------

export const reserveCuckooFilter = (
	key: string,
	capacity = 10000,
	bucketSize = 4,
	replicas = 2
) =>
	sendCommand([
		"CF.RESERVE",
		key,
		capacity.toString(),
		bucketSize.toString(),
		replicas.toString(),
	]);

export const insertCuckooFilter = (key: string, item: string) =>
	sendCommand(["CF.ADD", key, item]);

export const existsCuckooFilter = (key: string, item: string) =>
	sendCommand(["CF.EXISTS", key, item]);
