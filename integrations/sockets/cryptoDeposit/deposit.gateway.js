const { ethers, formatEther, WebSocketProvider } = require("ethers");
const { handleDepositEvent } = require("./deposit.events");
const provider = new WebSocketProvider(process.env.ALCHEMY_WSS);

// Watch pending transactions
const connectDepositWebSocket = async () => {
	provider.on("pending", async (txHash) => {
		try {
			const tx = await provider.getTransaction(txHash);
			if (!tx || !tx.to) return;
			const to = tx.to.toLowerCase();
			const data = {
				txHash: tx.hash,
				to,
				from: tx.from,
				value: formatEther(tx.value),
				token: "ETH",
			};
			await handleDepositEvent(data);
		} catch (err) {
			console.error("🔴 Error fetching tx:", err);
		}
	});
};

module.exports = { connectDepositWebSocket };
