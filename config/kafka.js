const { CompressionTypes } = require("kafkajs");
const kafkaConfig = {
	clientId: "chat-app", // Unique client ID for your app
	brokers: ["localhost:9092"], // Kafka broker addresses (can be multiple)
	// connectionTimeout: 5000, // Increased connection timeout for large networks
	// requestTimeout: 30000, // Increased request timeout for slow responses
	// retry: {
	// 	initialRetryTime: 1000, // Delay before the first retry (in ms)
	// 	retries: 10, // Max retries before failing
	// 	factor: 2, // Exponential backoff factor
	// 	multiplier: 2, // Multiplier for retry time
	// },
	// sasl: {
	// 	mechanism: "plain", // SASL mechanism (plain for basic authentication)
	// 	username: "myuser", // SASL username
	// 	password: "mypassword", // SASL password
	// },
	// ssl: false, // Enable SSL/TLS encryption for security
	// logLevel: 4, // Log level (0 = error, 1 = warn, 2 = info, 3 = debug, 4 = trace)
	// logCreator: (log) => {
	// 	// Custom logger for Kafka
	// 	return {
	// 		...log,
	// 		timestamp: new Date().toISOString(),
	// 	};
	// },
	// // Use compression to optimize message size and reduce network load
	// compression: CompressionTypes.GZIP,
	// maxInFlight: 10, // Limit the number of concurrent requests to Kafka
	// brokerVersion: "2.7.0", // Specify Kafka broker version
	// heartbeatInterval: 3000, // Heartbeat interval to keep consumers alive
	// metadataMaxAge: 300000, // Interval to refresh metadata (5 minutes)
};

module.exports = kafkaConfig;
