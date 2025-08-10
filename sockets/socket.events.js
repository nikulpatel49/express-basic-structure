const {
	handleOnlineUsers,
	handleOfflineUsers,
} = require("../services/user/user.socket");
const { logger } = require("../utils/logger");
const socketEvent = require("../utils/socketEvent.utils");
const initEvents = (socket, io) => {
	socket.on(socketEvent.USER.ONLINE, handleOnlineUsers(socket, io));
	socket.on(socketEvent.DISCONNECT, async () => {
		handleOfflineUsers(socket, io);
		logger.info(`❌ User ${socket.id} disconnected`);
	});
};

module.exports = initEvents;
