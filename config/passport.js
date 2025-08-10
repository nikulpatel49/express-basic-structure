const JwtStrategy = require("passport-jwt").Strategy;
const ExtractJwt = require("passport-jwt").ExtractJwt;
const headerStrategy = require("passport-http-header-strategy").Strategy;
const keys = require("../config/keys");

const User = require("../models/User");
const opts = {};
opts.jwtFromRequest = ExtractJwt.fromAuthHeaderAsBearerToken();
opts.secretOrKey = keys.authSecretKey;

module.exports = (passport) => {
	passport.use(
		"user-jwt-auth",
		new JwtStrategy(opts, async (jwtPayload, done) => {
			console.log("🚀 ~ newJwtStrategy ~ jwtPayload:", jwtPayload);
			try {
				const userId = jwtPayload?._id;
				const tokenVersion = jwtPayload?.tokenVersion;

				if (!userId || !tokenVersion) {
					return done(null, false);
				}
				const user = await UserModel.findById(
					userId,
					"tokens name email"
				).lean();
				if (!user || !user.tokens || user.tokens.length === 0) {
					return done(null, false);
				}
				const [token] = user.tokens;
				if (token.tokenVersion !== tokenVersion) {
					return done(null, false);
				}
				return done(null, { user });
			} catch (error) {
				return done(null, false);
			}
		})
	);
	passport.use(
		"x-apikey-authentication",
		new headerStrategy(
			{ header: "X-API-KEY", passReqToCallback: true },
			function (req, token, done) {
				if (keys.xApiKey === token) {
					return done(null, true);
				}
				return done(null, false);
			}
		)
	);
};
