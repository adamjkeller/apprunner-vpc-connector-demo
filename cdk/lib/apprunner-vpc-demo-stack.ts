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
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as cr from "aws-cdk-lib/custom-resources";
import * as secretsmgr from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
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

    // Demo private ECS service
    const privateTaskDef = new ecs.FargateTaskDefinition(
      this,
      "PrivateFargateTaskDef",
      {}
    );

    privateTaskDef.addContainer("PrivateDemoService", {
      image: ecs.ContainerImage.fromAsset("../private_service"),
      portMappings: [
        {
          containerPort: 8080,
        },
      ],
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

    // Load balanced ecs public facing service
    const taskDef = new ecs.FargateTaskDefinition(this, "FargateTaskDef", {});

    const ncContainerDef = taskDef.addContainer("FrontendService", {
      image: ecs.ContainerImage.fromAsset("../demo_app"),
      portMappings: [
        {
          containerPort: 8080,
        },
      ],
      environment: {
        TARGET: dbCluster.clusterEndpoint.hostname,
        TARGETPORT: "5432",
        ECSPRIVATESERVICE:
          `http://${privateDemoService.cloudMapService?.serviceName}.${demoECSCluster.defaultCloudMapNamespace?.namespaceName}:8080` ??
          "demo.service",
      },
      secrets: {
        DB_PASS: ecs.Secret.fromSecretsManager(dbSecrets, "password"),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecrets, "username"),
        DB_HOST: ecs.Secret.fromSecretsManager(dbSecrets, "host"),
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -f http://localhost:8080/health || exit 1",
        ],
        interval: Duration.seconds(5),
      },
      linuxParameters: new ecs.LinuxParameters(this, "initProcess", {
        initProcessEnabled: true,
      }),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "apprunnerdemoservice",
        logRetention: RetentionDays.ONE_WEEK,
      }),
    });

    taskDef.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      })
    );

    const ncService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "LBDemoService",
      {
        cluster: demoECSCluster,
        taskDefinition: taskDef,
        enableECSManagedTags: true,
        circuitBreaker: {
          rollback: true,
        },
      }
    );

    const cfnDbService = ncService.service.node.defaultChild as ecs.CfnService;
    cfnDbService.enableExecuteCommand = true;

    ncService.targetGroup.configureHealthCheck({
      path: "/health",
      interval: Duration.seconds(5),
      timeout: Duration.seconds(2),
    });

    ncService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "5"
    );

    dbCluster.connections.allowFrom(
      ncService.service,
      ec2.Port.tcp(5432),
      "Connection from ECS NC service to backend database"
    );

    // Task Autoscaling
    const ncServiceScaling = ncService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 5,
    });

    ncServiceScaling.scaleOnRequestCount("RequestAutoScaling", {
      requestsPerTarget: 25,
      targetGroup: ncService.targetGroup,
      scaleInCooldown: Duration.seconds(10),
      scaleOutCooldown: Duration.seconds(10),
    });

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

    const appRunnerService = new aws_apprunner.CfnService(
      this,
      "AppRunnerVpcCXService",
      {
        sourceConfiguration: {
          autoDeploymentsEnabled: true,
          imageRepository: {
            imageRepositoryType: "ECR",
            imageIdentifier: ncContainerDef.imageName,
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

    appRunnerService.node.addDependency(ncService);

    privateDemoService.connections.allowFromAnyIpv4(ec2.Port.tcp(8080));

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

    // ECS Frontend Service URL
    new CfnOutput(this, "ECSLBServiceUrl", {
      value: `http://${ncService.loadBalancer.loadBalancerDnsName}`,
    });
  }
}
