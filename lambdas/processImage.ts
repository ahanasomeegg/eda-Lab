import { SQSHandler } from "aws-lambda";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const db = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME!;

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    // 解析出 Analyze the S3 event of SNS package
    const { Message } = JSON.parse(record.body);
    const sns = JSON.parse(Message);

    // Get the key to the S3 object
    const key = sns.Records?.[0]?.s3?.object?.key;
    if (!key) continue;

    if (!/\.(jpe?g|png)$/i.test(key)) {
      console.log(`Invalid extension: ${key}`);
      throw new Error("Invalid image type");
    }

    await db.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        imageId: { S: key }
      }
    }));
    console.log(`Logged new image ${key}`);
  }
};
