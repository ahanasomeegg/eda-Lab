import { SQSHandler } from "aws-lambda";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const BUCKET = process.env.BUCKET_NAME!;

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const snsBody = JSON.parse(record.body);
    const msg     = JSON.parse(snsBody.Message);
    const key = msg.Records?.[0]?.s3?.object?.key;
    
    if (!key) continue;
    await s3.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key:    key,
    }));
    console.log(`Deleted invalid image ${key} from bucket`);
  }
};
