const swaggerJsDoc = require("swagger-jsdoc");

const definitions = {
	openapi: "3.0.0",
	info: {
		title: process?.env?.API_NAME,
		version: "1.0.0",
		description: `${process?.env?.API_NAME} API docs with x-api-key and JWT authentication`,
	},
	servers: [
		{
			url: `http://localhost:${process?.env?.PORT}`,
		},
	],
	components: {
		securitySchemes: {
			ApiKeyAuth: {
				type: "apiKey",
				in: "header",
				name: "x-api-key",
			},
			BearerAuth: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
			},
		},
	},
	security: [
		{
			ApiKeyAuth: [],
		},
		{
			BearerAuth: [],
		},
	],
};

const options = {
	swaggerDefinition: definitions,
	apis: ["./routes/**/*.js"],
};
const swaggerDocs = swaggerJsDoc(options);
// openapi2postmanv2 -s http://localhost:3000/api-docs/json -o postman_collection.json
module.exports = swaggerDocs;
