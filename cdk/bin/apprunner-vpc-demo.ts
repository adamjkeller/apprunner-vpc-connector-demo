#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AppRunnerVPCDemo } from "../lib/apprunner-vpc-demo-stack";

const deployEnv = "test";
const app = new cdk.App();
const cdkEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: "us-west-2",
};
new AppRunnerVPCDemo(app, "AppRunnerVPCDemoCFTC", {
  env: cdkEnv,
  stackName: `AppRunnerVPCDemo-${deployEnv}`,
});
