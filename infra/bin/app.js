#!/usr/bin/env node
// Entry point of the CDK app. Running `cdk synth` executes this file.
//
// A CDK program does not create anything in AWS by itself. It builds a tree of
// objects in memory (App -> Stack -> Constructs) and writes it out as a
// CloudFormation template. CloudFormation is what creates the resources.

const cdk = require('aws-cdk-lib');
const { BusinessAutoStack } = require('../lib/business-auto-stack');

const app = new cdk.App();

new BusinessAutoStack(app, 'BusinessAutoStack', {
  description: 'Business process automation platform: API, Temporal worker, Temporal dev server, Redis',
  // No account or region here: the stack is "environment-agnostic" and deploys
  // to whatever the AWS CLI profile points at. That also lets `cdk synth` run
  // with no AWS credentials at all.
});
