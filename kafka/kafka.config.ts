import { CompressionTypes, logLevel, SASLOptions } from "kafkajs";

interface KafkaConfig {
  clientId: string;
  brokers: string[];
  connectionTimeout?: number;
  requestTimeout?: number;
  retry?: {
    initialRetryTime?: number;
    retries?: number;
    factor?: number;
    multiplier?: number;
  };
  sasl?: SASLOptions;
  ssl?: boolean;
  logLevel?: logLevel;
  // logCreator?: (log: any) => any; // optional custom log creator
  compression?: CompressionTypes;
  maxInFlight?: number;
  brokerVersion?: string;
  heartbeatInterval?: number;
  metadataMaxAge?: number;
}

const kafkaConfig: KafkaConfig = {
  clientId: "chat-app", // Unique client ID for your app
  brokers: ["localhost:9092"], // Kafka broker addresses (can be multiple)

  // Example optional configs (uncomment if needed):
  // connectionTimeout: 5000,
  // requestTimeout: 30000,
  // retry: {
  //   initialRetryTime: 1000,
  //   retries: 10,
  //   factor: 2,
  //   multiplier: 2,
  // },
  // sasl: {
  //   mechanism: "plain",
  //   username: "myuser",
  //   password: "mypassword",
  // },
  // ssl: false,
  // logLevel: logLevel.INFO,
  // compression: CompressionTypes.GZIP,
  // maxInFlight: 10,
  // brokerVersion: "2.7.0",
  // heartbeatInterval: 3000,
  // metadataMaxAge: 300000,
};

export default kafkaConfig;
