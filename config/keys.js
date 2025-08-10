module.exports = {
	appName: process.env.API_NAME,
	mongoURI: process.env.MONGO_URI,
	authSecretKey: process.env.AUTH_SECRET_KEY,
	authJWTExpiredIn: process.env.JWT_EXPIRES_IN,
	saltRoundForPassword: 10,
	algorithmForEncryption: 'aes256',
	secretKeyForEncryption: 'c8c78895fd91da17cca9cf0d28e742c6', //32 byte or 256 bits only
	morganLogFormat: process.env.LOG_FORMAT,
	morganLogDir: process.env.LOG_DIR,
	xApiKey: process.env.X_API_KEY
};
