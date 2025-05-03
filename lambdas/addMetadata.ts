import { SNSHandler } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const db = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME!;

export const handler: SNSHandler = async (event) => {
  for (const record of event.Records) {
    // Grab the metadata_type attribute
    const metaAttr = record.Sns.MessageAttributes!['metadata_type'];
    const field    = metaAttr.Value!;          // Caption, Date or name

    // Parse the JSON body
    const { id, value } = JSON.parse(record.Sns.Message);

    // Update DynamoDB
    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { imageId: { S: id } },
      UpdateExpression: 'SET #f = :v',
      ExpressionAttributeNames: { '#f': field },
      ExpressionAttributeValues: { ':v': { S: value } }
    }));

    console.log(`Updated ${id} field ${field} => ${value}`);
  }
};
