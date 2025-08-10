const { default: mongoose } = require("mongoose");
const yup = require("yup");
const _ = require("lodash");

yup.addMethod(yup.string, "isMongooseId", function (arg) {
	return this.test(async (value, context) => {
		try {
			if (mongoose.Types.ObjectId.isValid(value)) return true;
			return context.createError({
				message: arg?.message ? arg.message : "Invalid Id.",
			});
		} catch (e) {
			return context.createError({
				message: arg?.message ? arg.message : "Invalid Id.",
			});
		}
	});
});

yup.addMethod(yup.string, "isMongooseIdOptional", function (arg) {
	return this.test(async (value, context) => {
		try {
			if (_.isNil(value) || _.isEmpty(value)) return true;
			if (mongoose.Types.ObjectId.isValid(value)) return true;
			return context.createError({
				message: arg?.message ? arg.message : "Invalid Id.",
			});
		} catch (e) {
			return context.createError({
				message: arg?.message ? arg.message : "Invalid Id.",
			});
		}
	});
});
module.exports = yup;
