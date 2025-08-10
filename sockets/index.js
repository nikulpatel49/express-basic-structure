const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");

const authenticateSocketUser = require("../middlewares/authenticateSocket.middleware");
const { initClient } = require("../utils/redis.utils");
const initEvents = require("./socket.events");
const { logger } = require("../utils/logger");

let io = null;

const initSocket = async (server) => {
	io = new Server(server, {
		cors: { origin: "*" },
	});

	const redisClient = await initClient();

	const pub = redisClient.duplicate();
	const sub = redisClient.duplicate();

	await Promise.all([pub.connect(), sub.connect()]).then(() => {
		io.adapter(createAdapter(pub, sub));
		logger.info("✅ Redis adapter connected");
	});

	io.use(authenticateSocketUser);

	const chatIO = io.of("/chat");
	chatIO.on("connection", (socket) => {
		logger.info(`✅ User ${socket.id} connected`);
		initEvents(socket, chatIO);
	});
	chatIO.on("error", (err) => {
		logger.info(`❌ Socket.IO error: ${err.message}`);
	});
	chatIO.on("connect_error", (err) => {
		console.error("❌ Connection failed:", err.message);
	});
};

const getIO = () => {
	if (!io) throw new Error("Socket.IO not initialized");
	return io;
};

module.exports = { initSocket, getIO };
