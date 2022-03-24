import {
  aws_apprunner,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as cr from "aws-cdk-lib/custom-resources";
import * as secretsmgr from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

export class AppRunnerVPCDemo extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const demoVpc = new ec2.Vpc(this, "AppRunnerDemoVPC");

    const demoECSCluster = new ecs.Cluster(this, "AppRunnerDemoCluster", {
      vpc: demoVpc,
      defaultCloudMapNamespace: {
        name: "apprunner.demo",
        vpc: demoVpc,
      },
      executeCommandConfiguration: {
        logging: ecs.ExecuteCommandLogging.DEFAULT,
      },
    });

    const dbCluster = new rds.ServerlessCluster(this, "AppRunnerDemoDatabase", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_10_14,
      }),
      vpc: demoVpc,
      enableDataApi: true,
      removalPolicy: RemovalPolicy.DESTROY,
      scaling: {
        autoPause: Duration.seconds(0),
      },
    });

    const createDatabase = new cr.AwsCustomResource(this, "RDSCreateDatabase", {
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      logRetention: RetentionDays.ONE_WEEK,
      onCreate: {
        service: "RDSDataService",
        action: "executeStatement",
        physicalResourceId: cr.PhysicalResourceId.of(
          dbCluster.clusterIdentifier
        ),
        parameters: {
          resourceArn: dbCluster.clusterArn,
          secretArn: dbCluster.secret?.secretArn,
          sql: "CREATE DATABASE apprunnerdemo OWNER postgres;",
        },
      },
    });

    const createTable = new cr.AwsCustomResource(this, "RDSCreateTable", {
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      logRetention: RetentionDays.ONE_WEEK,
      onCreate: {
        service: "RDSDataService",
        action: "executeStatement",
        physicalResourceId: cr.PhysicalResourceId.of(
          dbCluster.clusterIdentifier
        ),
        parameters: {
          resourceArn: dbCluster.clusterArn,
          secretArn: dbCluster.secret?.secretArn,
          sql: "CREATE TABLE access (last_update TIMESTAMP, user_agent VARCHAR (250));",
          database: "apprunnerdemo",
        },
      },
    });

    createDatabase.node.addDependency(dbCluster);
    createTable.node.addDependency(createDatabase);
    dbCluster.secret?.grantRead(createDatabase);
    dbCluster.secret?.grantRead(createTable);

    dbCluster.connections.allowFrom(
      dbCluster,
      ec2.Port.tcp(5432),
      "Allow traffic on 5432 for any resource with this sec grp attached"
    );

    const dbSecrets =
      dbCluster.secret ?? new secretsmgr.Secret(this, "RDSSecret");

    // Create an ECS service that resides in private subnets
    const privateTaskDef = new ecs.FargateTaskDefinition(
      this,
      "PrivateFargateTaskDef",
      {}
    );

    // Log group for private task
    const privateServiceLogs = new logs.LogGroup(this, "PrivateSvcLogGrp", {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_DAY,
    });

    privateTaskDef.addContainer("PrivateDemoService", {
      image: ecs.ContainerImage.fromAsset("../private_service"),
      portMappings: [
        {
          containerPort: 8080,
        },
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "appRunnerDemoECSPrivateService",
        logGroup: privateServiceLogs,
      }),
    });

    const privateDemoService = new ecs.FargateService(
      this,
      "PrivateDemoService",
      {
        cluster: demoECSCluster,
        taskDefinition: privateTaskDef,
        cloudMapOptions: {
          name: "privateservice",
        },
        enableECSManagedTags: true,
        enableExecuteCommand: true,
        capacityProviderStrategies: [
          { capacityProvider: "FARGATE_SPOT", weight: 1 },
        ],
      }
    );

    privateDemoService.connections.allowFromAnyIpv4(ec2.Port.tcp(8080));

    // Create an App Runner Service with a VPC Connector
    const appRunnerVpcConnector = new aws_apprunner.CfnVpcConnector(
      this,
      "AppRunnerVPCCon",
      {
        subnets: demoVpc.selectSubnets({
          subnetType: SubnetType.PRIVATE_WITH_NAT,
        }).subnetIds,
        securityGroups: [
          dbCluster.connections.securityGroups[0].securityGroupId,
        ],
        vpcConnectorName: "CdkVPCConnectorDemo",
      }
    );

    const appRunnerServiceRole = new iam.Role(this, "AppRunnerServiceRole", {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
    });

    appRunnerServiceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSAppRunnerServicePolicyForECRAccess"
      )
    );

    const appRunnerInstanceRole = new iam.Role(this, "AppRunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
      inlinePolicies: {
        secretsManager: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["secretsmanager:GetSecretValue"],
              resources: [dbSecrets.secretArn],
            }),
          ],
        }),
      },
    });

    // Build a container image and push to ECR
    const appRunnerContainerImage = new ecrAssets.DockerImageAsset(
      this,
      "ECRImage",
      {
        directory: "../demo_app",
      }
    );

    const appRunnerService = new aws_apprunner.CfnService(
      this,
      "AppRunnerVpcCXService",
      {
        sourceConfiguration: {
          autoDeploymentsEnabled: true,
          imageRepository: {
            imageRepositoryType: "ECR",
            imageIdentifier: appRunnerContainerImage.imageUri,
            imageConfiguration: {
              runtimeEnvironmentVariables: [
                {
                  name: "APPRUNNERSERVICE",
                  value: "True",
                },
                {
                  name: "DBSECRETSNAME",
                  value: dbSecrets.secretArn,
                },
                {
                  name: "ECSPRIVATESERVICE",
                  value: `http://${privateDemoService.cloudMapService?.serviceName}.${demoECSCluster.defaultCloudMapNamespace?.namespaceName}:8080`,
                },
              ],
            },
          },
          authenticationConfiguration: {
            accessRoleArn: appRunnerServiceRole.roleArn,
          },
        },
        networkConfiguration: {
          egressConfiguration: {
            egressType: "VPC",
            vpcConnectorArn: appRunnerVpcConnector.attrVpcConnectorArn,
          },
        },
        serviceName: Stack.of(this).stackName,
        instanceConfiguration: {
          instanceRoleArn: appRunnerInstanceRole.roleArn,
        },
      }
    );

    appRunnerService.node.addDependency(dbCluster);
    appRunnerService.node.addDependency(privateDemoService);

    new CfnOutput(this, "AppRunnerVpcId", { value: demoVpc.vpcId });

    new CfnOutput(this, "AppRunnerPrivateSubnets", {
      value: `${
        demoVpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_NAT })
          .subnetIds
      }`,
    });

    new CfnOutput(this, "AppRunnerSecGrp", {
      value: dbCluster.connections.securityGroups[0].securityGroupId,
    });

    // App Runner URL output
    new CfnOutput(this, "AppRunnerServiceUrl", {
      value: `https://${appRunnerService.attrServiceUrl}`,
    });
  }
}
