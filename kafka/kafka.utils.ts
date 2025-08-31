
import { Kafka, Producer, Consumer, EachMessagePayload, CompressionTypes } from "kafkajs";
import redis from "./redisClient";
import { RETRY_LIMIT, DLQ_TOPIC } from "./constants";

const kafka = new Kafka({
  clientId: "ride-app",
  brokers: ["localhost:9092"],
});

let producer: Producer;
let consumer: Consumer;

export const connectKafka = async () => {
  if (!producer) {
    producer = kafka.producer();
    await producer.connect();
  }
  return producer;
};

export const publishEvent = async ({
  topic,
  messages,
}: {
  topic: string;
  messages: { key?: string; value: string; headers?: Record<string, string> }[];
}) => {
  const kafkaProducer = await connectKafka();
  try {
    await kafkaProducer.send({
      topic,
      messages,
      compression: CompressionTypes.GZIP,
    });
  } catch (err) {
    console.error("Kafka send failed:", err);
    for (const m of messages) {
      await redis.set(`offline:kafka:${topic}:${Date.now()}`, m.value);
    }
  }
};

export const subscribeEvent = async ({
  groupId,
  topic,
  onMessage,
}: {
  groupId: string;
  topic: string;
  onMessage: (msg: any, payload: EachMessagePayload) => Promise<void>;
}) => {
  consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });

  await consumer.run({
    eachMessage: async (payload: EachMessagePayload) => {
      const { message } = payload;
      const value = message?.value?.toString();
      if (!value) return;

      let parsed: any;
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        console.error("Invalid JSON:", value);
        return;
      }

      const retries = message.headers?.["retries"]
        ? Number(message.headers["retries"].toString())
        : 0;

      try {
        await onMessage(parsed, payload);
      } catch (err) {
        console.error("Handler error:", err);

        if (retries < RETRY_LIMIT) {
          await retryMessage(topic, parsed, retries + 1);
        } else {
          await publishEvent({
            topic: DLQ_TOPIC,
            messages: [
              { value: JSON.stringify({ ...parsed, __originalTopic: topic }) },
            ],
          });
        }
      }
    },
  });
};

const retryMessage = async (topic: string, message: any, retries: number) => {
  await publishEvent({
    topic,
    messages: [
      {
        value: JSON.stringify(message),
        headers: { retries: retries.toString() },
      },
    ],
  });
};
