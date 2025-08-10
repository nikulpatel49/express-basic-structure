const { publishDepositEvent } = require("../../../kafka/depositDetect.kafka");

module.exports.handleDepositEvent = async (data) => {
	await publishDepositEvent(data);
};
