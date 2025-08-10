// for producer
const { publishEvent, subscribeEvent } = require("../utils/kafka.utils");

const CYPTO_DEPOSIT = "deposit.events";
const CRYPTO_GROUPID = "crypto-deposit";

module.exports.publishDepositEvent = async (data) => {
	try {
		await publishEvent({
			topic: CYPTO_DEPOSIT,
			messages: [data],
			batching: false,
		});
		return true;
	} catch (error) {
		console.error(error);
		return false;
	}
};

module.exports.subscribeDepositEvent = async () => {
	subscribeEvent({
		topic: CYPTO_DEPOSIT,
		groupId: CRYPTO_GROUPID,
		onMessage: async (data) => {
			console.log("📨 Received Kafka Message:", data);
		},
	});
};

this.subscribeDepositEvent();
