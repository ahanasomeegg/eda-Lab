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

import { Construct } from "constructs";

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SES_EMAIL_FROM, SES_EMAIL_TO } from '../env';

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    const absenceFilter = { exists: false } as any;

    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

      // Integration infrastructure

      const deadLetterQueue = new sqs.Queue(this, "ImagesDLQ", {

      });

      const imageProcessQueue = new sqs.Queue(this, "img-created-queue", {
        receiveMessageWaitTime: cdk.Duration.seconds(10),
        deadLetterQueue: {
          queue: deadLetterQueue,
          maxReceiveCount: 2,  
        },
      });
  
      const newImageTopic = new sns.Topic(this, "NewImageTopic", {
        displayName: "New Image topic",
      }); 

      // DynamoDB table
      const imagesTable = new dynamodb.Table(this, 'ImagesTable', {
        partitionKey: { name: 'imageId', type: dynamodb.AttributeType.STRING },
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

  // Lambda functions

  const processImageFn = new lambdanode.NodejsFunction(
    this,
    "ProcessImageFn",
    {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: `${__dirname}/../lambdas/processImage.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        TABLE_NAME: imagesTable.tableName
      }
    }
  );

  // grant Lambda 
  imagesTable.grantWriteData(processImageFn);

  // add meta data
  const addMetadataFn = new lambdanode.NodejsFunction(this, 'AddMetadataFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: `${__dirname}/../lambdas/addMetadata.ts`,
    timeout: cdk.Duration.seconds(10),
    memorySize: 128,
    environment: {
      TABLE_NAME: imagesTable.tableName
    }
  });
  
  imagesTable.grantWriteData(addMetadataFn);

  // remove invalid image
  const removeImageFn = new lambdanode.NodejsFunction(this, "RemoveImageFn", {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: `${__dirname}/../lambdas/removeImage.ts`,
    timeout: cdk.Duration.seconds(15),
    memorySize: 128,
    environment: {
      BUCKET_NAME: imagesBucket.bucketName,
    },
  });
  
  imagesBucket.grantDelete(removeImageFn);

  removeImageFn.addEventSource(
    new events.SqsEventSource(deadLetterQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(5),
    })
  );

  // update status
  const updateStatusFn = new lambdanode.NodejsFunction(this, 'UpdateStatusFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: `${__dirname}/../lambdas/updateStatus.ts`,
    timeout: cdk.Duration.seconds(15),
    memorySize: 256,
    environment: {
      TABLE_NAME:  imagesTable.tableName,
      SES_SENDER:  SES_EMAIL_FROM,
      SES_RECIPIENT: SES_EMAIL_TO
  }
});
  
imagesTable.grantReadWriteData(updateStatusFn);
updateStatusFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['ses:SendEmail','ses:SendRawEmail'],
  resources: ['*'],
}));

newImageTopic.addSubscription(new subs.LambdaSubscription(updateStatusFn, {
  filterPolicy: {
    action: sns.SubscriptionFilter.stringFilter({
      allowlist: ['status_update']
    })
  }
}));
  
  newImageTopic.addSubscription(new subs.LambdaSubscription(addMetadataFn, {
    filterPolicy: {
      metadata_type: sns.SubscriptionFilter.stringFilter({
        allowlist: ['Caption','Date','name'],
      })
    }
  }));

  // S3 --> SQS
  imagesBucket.addEventNotification(
    s3.EventType.OBJECT_CREATED,
    new s3n.SnsDestination(newImageTopic)
  );

  newImageTopic.addSubscription(new subs.SqsSubscription(imageProcessQueue, {
    filterPolicy: {
      metadata_type: absenceFilter,
      action:         absenceFilter,
    }
  }));
  


 // SQS --> Lambda
  const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
    batchSize: 5,
    maxBatchingWindow: cdk.Duration.seconds(5),
  });

  processImageFn.addEventSource(newImageEventSource);

  // Permissions

  imagesBucket.grantRead(processImageFn);

  //Add a second queue
  const mailerQ = new sqs.Queue(this, "mailer-queue", {
    receiveMessageWaitTime: cdk.Duration.seconds(10),
  });

  //Add a second lambda functio
  const mailerFn = new lambdanode.NodejsFunction(this, "mailer-function", {
    runtime: lambda.Runtime.NODEJS_22_X,
    memorySize: 1024,
    timeout: cdk.Duration.seconds(3),
    entry: `${__dirname}/../lambdas/mailer.ts`,
  });

  //Make the new queue a subscriber to the SNS topic
  newImageTopic.addSubscription(new subs.SqsSubscription(mailerQ, {
    filterPolicy: {
      metadata_type: absenceFilter,
      action:         absenceFilter,
    }
  }));
  


  //Create an event source from the new SQS queue
  const newImageMailEventSource = new events.SqsEventSource(mailerQ, {
    batchSize: 5,
    maxBatchingWindow: cdk.Duration.seconds(5),
  }); 

  //Make the new event source the trigger for the new lambda function
  mailerFn.addEventSource(newImageMailEventSource);

  //Give the new lambda function permission to send emails using the SES service
  mailerFn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendTemplatedEmail",
      ],
      resources: ["*"],
    })
  );


    // Output
    
    new cdk.CfnOutput(this, "bucketName", {
      value: imagesBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'ImagesTableName', {
      value: imagesTable.tableName,
    });

    new cdk.CfnOutput(this, 'AddMetadataFnName', {
      value: addMetadataFn.functionName
    });
    
    new cdk.CfnOutput(this, 'UpdateStatusFnName', { 
      value: updateStatusFn.functionName 
    });

  }
}

