const redisConfig = {
	host: "127.0.0.1", // Local Redis server
	port: 6379, // Default Redis port
	username: "", // Optional, only for Redis >= 6 with ACL support
	password: "", // Leave blank if no auth set in local Redis config
	db: 0, // Default DB index
	// Retry Strategy for reconnecting
	retryStrategy: (retries) => {
		if (retries > 10) return null; // Stop after 10 tries
		return Math.min(retries * 100, 3000); // Exponential backoff
	},

	// Reconnect on error (advanced)
	reconnectOnError: (err) => {
		const targetErrors = ["READONLY", "ECONNRESET"];
		return targetErrors.some((msg) => err?.message?.includes(msg));
	},

	// TLS (for cloud Redis like AWS Elasticache, Redis Cloud)
	tls: null, // or { rejectUnauthorized: false } if self-signed cert

	// Optional timeout configs
	connectTimeout: 10000, // ms to wait before aborting connect
	keepAlive: 0, // 0 for OS default (usually 7200s)

	// Show friendly logs
	showFriendlyErrorStack: true,
};

module.exports = redisConfig;
