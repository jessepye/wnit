// AWS Lambda entry point (behind a Lambda function URL). The Node.js runtime
// already includes the AWS SDK v3, so this deploys with no dependencies.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { createCacheService, dynamoLimiter, dynamoStore, lambdaAdapter } from './core.mjs';

const tableName = process.env.TABLE_NAME;
// DYNAMODB_ENDPOINT is only for local testing against an emulator.
const ddb = new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {});
const doc = DynamoDBDocumentClient.from(ddb);
const client = {
  get: (params) => doc.send(new GetCommand(params)),
  put: (params) => doc.send(new PutCommand(params)),
  update: (params) => doc.send(new UpdateCommand(params)),
};

export const handler = lambdaAdapter(
  createCacheService({
    store: dynamoStore({ client, tableName }),
    limiter: dynamoLimiter({ client, tableName }),
    contactEmail: process.env.CONTACT_EMAIL || '',
    cacheDays: Number(process.env.CACHE_DAYS) || 30,
    log: (...args) => console.error(...args),
  }),
);
