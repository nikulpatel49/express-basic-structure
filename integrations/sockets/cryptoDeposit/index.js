const { connectDepositWebSocket } = require("./deposit.gateway");

module.exports.init = () => {
	connectDepositWebSocket();
};
