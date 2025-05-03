import * as cdk from "aws-cdk-lib";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import { SubscriptionFilter } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { SES_EMAIL_FROM, SES_EMAIL_TO } from "../env";

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false
    });

    const deadLetterQueue = new sqs.Queue(this, "ImagesDLQ");

    const imageProcessQueue = new sqs.Queue(this, "img-created-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 2
      }
    });

    const newImageTopic = new sns.Topic(this, "NewImageTopic", {
      displayName: "New Image topic"
    });

    const imagesTable = new dynamodb.Table(this, "ImagesTable", {
      partitionKey: { name: "imageId", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const processImageFn = new lambdanode.NodejsFunction(this, "ProcessImageFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: `${__dirname}/../lambdas/processImage.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: { TABLE_NAME: imagesTable.tableName }
    });
    imagesTable.grantWriteData(processImageFn);
    imagesBucket.grantRead(processImageFn);

    const addMetadataFn = new lambdanode.NodejsFunction(this, "AddMetadataFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: `${__dirname}/../lambdas/addMetadata.ts`,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: { TABLE_NAME: imagesTable.tableName }
    });
    imagesTable.grantWriteData(addMetadataFn);

    const removeImageFn = new lambdanode.NodejsFunction(this, "RemoveImageFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: `${__dirname}/../lambdas/removeImage.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: { BUCKET_NAME: imagesBucket.bucketName }
    });
    imagesBucket.grantDelete(removeImageFn);
    removeImageFn.addEventSource(
      new events.SqsEventSource(deadLetterQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(5)
      })
    );

    const updateStatusFn = new lambdanode.NodejsFunction(this, "UpdateStatusFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: `${__dirname}/../lambdas/updateStatus.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        SES_SENDER: SES_EMAIL_FROM,
        SES_RECIPIENT: SES_EMAIL_TO
      }
    });
    imagesTable.grantReadWriteData(updateStatusFn);
    updateStatusFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"]
      })
    );

    newImageTopic.addSubscription(
      new subs.LambdaSubscription(updateStatusFn, {
        filterPolicy: {
          action: SubscriptionFilter.stringFilter({ allowlist: ["status_update"] })
        }
      })
    );

    newImageTopic.addSubscription(
      new subs.LambdaSubscription(addMetadataFn, {
        filterPolicy: {
          metadata_type: SubscriptionFilter.stringFilter({
            allowlist: ["Caption", "Date", "name"]
          })
        }
      })
    );

    imagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(newImageTopic)
    );

    newImageTopic.addSubscription(
      new subs.SqsSubscription(imageProcessQueue)
    );

    // const imgSub = newImageTopic.addSubscription(
    //   new subs.SqsSubscription(imageProcessQueue)
    // );
    
    // (imgSub.node.defaultChild as sns.CfnSubscription).addOverride(
    //   'Properties.FilterPolicy',
    //   {
    //     metadata_type: [ { exists: false } ],
    //     action:        [ { exists: false } ]
    //   }
    // );

    processImageFn.addEventSource(
      new events.SqsEventSource(imageProcessQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(5)
      })
    );

    const mailerQ = new sqs.Queue(this, "mailer-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(10)
    });

    const mailerFn = new lambdanode.NodejsFunction(this, "mailer-function", {
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(3),
      entry: `${__dirname}/../lambdas/mailer.ts`
    });

    newImageTopic.addSubscription(
      new subs.SqsSubscription(mailerQ, {
        filterPolicy: {
          action: SubscriptionFilter.stringFilter({ allowlist: ["status_update"] })
        }
      })
    );

    mailerFn.addEventSource(
      new events.SqsEventSource(mailerQ, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(5)
      })
    );

    mailerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail", "ses:SendTemplatedEmail"],
        resources: ["*"]
      })
    );

    new cdk.CfnOutput(this, "bucketName", {
      value: imagesBucket.bucketName
    });

    new cdk.CfnOutput(this, "ImagesTableName", {
      value: imagesTable.tableName
    });

    new cdk.CfnOutput(this, "AddMetadataFnName", {
      value: addMetadataFn.functionName
    });

    new cdk.CfnOutput(this, "UpdateStatusFnName", {
      value: updateStatusFn.functionName
    });
  }
}
