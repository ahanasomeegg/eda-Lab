import { SNSHandler } from 'aws-lambda';
import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand
} from '@aws-sdk/client-dynamodb';
import {
  SESClient,
  SendEmailCommand,
  SendEmailCommandInput
} from '@aws-sdk/client-ses';

const db  = new DynamoDBClient({});
const ses = new SESClient({ region: process.env.AWS_REGION });
const TABLE = process.env.TABLE_NAME!;
const SENDER = process.env.SES_SENDER!;
const RECIPIENT = process.env.SES_RECIPIENT!;

export const handler: SNSHandler = async (event) => {
  for (const rec of event.Records) {
    const { id, date, update: { status, reason } } = JSON.parse(rec.Sns.Message);

    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { imageId: { S: id } },
      UpdateExpression: 'SET #st=:s,#rs=:r,#md=:d',
      ExpressionAttributeNames: {
        '#st': 'status',
        '#rs': 'reason',
        '#md': 'moderatedAt'
      },
      ExpressionAttributeValues: {
        ':s': { S: status },
        ':r': { S: reason },
        ':d': { S: date }
      }
    }));

    const params: SendEmailCommandInput = {
      Source: SENDER,
      Destination: { ToAddresses: [RECIPIENT] },
      Message: {
        Subject: { Data: `Your image ${id} was ${status}` },
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data: `
              <p>Your image <b>${id}</b> has been <b>${status}</b>.</p>
              <p><b>Reason:</b> ${reason}</p>
              <p><b>Date:</b> ${date}</p>
            `
          }
        }
      }
    };
    await ses.send(new SendEmailCommand(params));
    console.log(`Status update email sent for ${id}`);
  }
};

