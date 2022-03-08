# App Runner VPC Connector Example

### Description

In this walkthrough, we will deploy a web facing API service to AWS App Runner that relies on a backend database (RDS cluster) and private API service (Amazom ECS Fargate Service) running in private subnets in a VPC.
The goal of this walkthrough is to showcase the VPC integration with AWS App Runner and help users better understand how they can connect their App Runner services to resources in their VPC's.

### Walkthrough

The entire environment has been automated using the AWS CDK (Cloud Development Kit), which means the deployment is going to be relatively straightforward and only require a single command to get everything up and running.
Prior to deploying the environment, we will walk through the code to better understand what we are deploying.
Let's get right into it.

#### Meet the application

To get things started, let's review the application.

The application is quite simple and is designed to show off the App Runner VPC integration feature.
When accessing the root of the API endpoint, it stores the timestamp and user agent in a Postgres database.
In addition, the frontend offers two paths to showcase the connectivity between the App Runner service and the resources in the VPC.

- `/recent-visits`: View the last ten visits to the root of the url.
- `/ecs-private-service`: View the details of a private service running in the VPC in Amazon ECS.

The application is comprised of two services:

- The frontend API, which writes/reads to a database and communicates to a private service running in Amazon ECS over DNS.
- The backend ecs private API, which returns the task metadata related to the ECS service.

![arch diagram](./App%20Runner%20VPC%20Connector%20Example.png)

#### The code

As mentioned earlier, the environment is defined in Typescript using the AWS Cloud Development Kit.
There are two files in which the code resides:

- `bin/apprunner-vpc-demo.ts`: This is where we instantiate the CDK app and stack.
- `lib/apprunner-vpc-demo-stack.ts`: Here is where all of the code lives that defines our stack resources and dependencies.

In the below sections we will review the code in chunks and review what we are building.

<details><summary> Base resources </summary>

We need a VPC and an ECS Cluster to run our private ECS service.
In the below code, with one line we are creating a VPC that will build private and public subnets across three availability zones.
As we progress through the walkthrough, we will see a common theme: take advantage of high level constructs that build resources based on good practices when possible.
This saves us the time and effort which can be shifted elsewhere.
Of course, every environment has it's quirks that require some form of customization, and this one is no different.
We'll see this later on in the walkthrough.

The ECS cluster construct has a few more inputs to customize based on our needs.
We want the cluster to reside in the VPC created above and want to create a namespace for service discovery (for services to communicate with this service via a friendly DNS name).
Lastly, we enable the ecs excute command at the cluster level just in case we need to troubleshoot our tasks via ECS exec.
All of that is being created in less than 10 lines of code.

```typescript
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
```

</details>

<details><summary> Database resources </summary>

To create our database cluster in RDS, we're going to use the `ServerlessCluster` construct.
Once again this construct is going to many resources on our behalf, with only a few lines defining our requirements.
Things get interesting here, and let me explain the magic after the creation of the database cluster.
I am a big fan of automating everything that is within reason and makes sense for the scenario.
In this case, I need a database and table created on the RDS cluster.
To do this in an automated way I need to ensure that the cluster is up, I have credentials to access to host, and then run the proper sql commands.

This is where the `AwsCustomResource` construct comes to save the day!
This construct is perfect for one off scenarios where you need issue an AWS API call that doesn't have direct CloudFormation support.
In this case, we want to run the `RDSDataService` `executeStatement` command, which executes a sql statement in the database host.
I don't have to hardcode the database user credentials as the command will programatically access the required values to access the database host via a secret json object stored in Secrets Manager (the secret was created as a part of the ServerlessCluster construct).

```typescript
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
    physicalResourceId: cr.PhysicalResourceId.of(dbCluster.clusterIdentifier),
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
    physicalResourceId: cr.PhysicalResourceId.of(dbCluster.clusterIdentifier),
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

const dbSecrets = dbCluster.secret ?? new secretsmgr.Secret(this, "RDSSecret");
```

</details>

<details><summary> ECS Private Service </summary>

```typescript
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

const privateDemoService = new ecs.FargateService(this, "PrivateDemoService", {
  cluster: demoECSCluster,
  taskDefinition: privateTaskDef,
  cloudMapOptions: {
    name: "privateservice",
  },
  enableECSManagedTags: true,
  enableExecuteCommand: true,
  capacityProviderStrategies: [{ capacityProvider: "FARGATE_SPOT", weight: 1 }],
});

privateDemoService.connections.allowFromAnyIpv4(ec2.Port.tcp(8080));
```

</details>

<details><summary> App Runner Service</summary>

```typescript
const appRunnerVpcConnector = new aws_apprunner.CfnVpcConnector(
  this,
  "AppRunnerVPCCon",
  {
    subnets: demoVpc.selectSubnets({
      subnetType: SubnetType.PRIVATE_WITH_NAT,
    }).subnetIds,
    securityGroups: [dbCluster.connections.securityGroups[0].securityGroupId],
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
```

</details>

#### Deploy the environment

To deploy the environment, we will use the AWS CDK.
Once we conclude the deployment, we will walk through the App Runner console and deploy!

1. Navigate to the `./cdk` directory and deploy the environment. (_NOTE:_ This will deploy a database and could incur cost in your AWS account)

```

cd cdk
cdk deploy --require-approval never

```

2.

```

```

```

```
