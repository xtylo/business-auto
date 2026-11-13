// The whole AWS infrastructure of the project, as one stack.
//
//   Internet -> ALB (public subnets) -> API service ----> Redis (ElastiCache)
//                                           |
//                                           v
//                Worker service ----> Temporal server (demo)
//                                  (all in private subnets)
//
// Construct levels used below, from lowest to highest:
//   L1  "Cfn*" classes: one-to-one with CloudFormation. You set every property.
//   L2  Classes with sensible defaults and helper methods (Vpc, Cluster...).
//   L3  "Patterns": several resources wired together for a common use case.

const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const elasticache = require('aws-cdk-lib/aws-elasticache');
const logs = require('aws-cdk-lib/aws-logs');
const { DockerImageAsset, Platform } = require('aws-cdk-lib/aws-ecr-assets');
const path = require('path');

const TEMPORAL_PORT = 7233;
const REDIS_PORT = 6379;
const API_PORT = 3000;
const TASK_QUEUE = 'business-processes';
const NAMESPACE_NAME = 'business-auto.local';

class BusinessAutoStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // ---- Network (L2) --------------------------------------------------------
    // One line produces a VPC, public and private subnets in two availability
    // zones, route tables, an internet gateway and a NAT gateway.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // One NAT gateway instead of one per zone: cheaper, less resilient.
      // Private tasks need it to pull container images.
      natGateways: 1,
    });

    // ---- ECS cluster (L2) ----------------------------------------------------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // Private DNS inside the VPC, so services find each other by name:
    // temporal.business-auto.local. This is what "temporal:7233" was in Docker Compose.
    cluster.addDefaultCloudMapNamespace({ name: NAMESPACE_NAME });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      // Delete the logs with the stack. In production you would keep them.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logTo = (streamPrefix) => ecs.LogDrivers.awsLogs({ logGroup, streamPrefix });

    const runtimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    // ---- Temporal server: DEMO ONLY ------------------------------------------
    // The same single-binary development server used locally. It keeps all state
    // in memory: if the task restarts, every workflow is lost. A production
    // setup uses Temporal Cloud, or a self-hosted cluster with a database.
    const temporalTask = new ecs.FargateTaskDefinition(this, 'TemporalTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform,
    });
    temporalTask.addContainer('temporal', {
      image: ecs.ContainerImage.fromRegistry('temporalio/temporal:latest'),
      command: ['server', 'start-dev', '--ip', '0.0.0.0'],
      portMappings: [{ containerPort: TEMPORAL_PORT }],
      logging: logTo('temporal'),
    });

    const temporalService = new ecs.FargateService(this, 'TemporalService', {
      cluster,
      taskDefinition: temporalTask,
      desiredCount: 1,
      // Zero-downtime deployment settings make no sense for a single in-memory
      // server: stop the old task before starting the new one.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      cloudMapOptions: { name: 'temporal', dnsTtl: cdk.Duration.seconds(10) },
    });
    const temporalAddress = `temporal.${NAMESPACE_NAME}:${TEMPORAL_PORT}`;

    // ---- Redis (L1) ----------------------------------------------------------
    // ElastiCache has no L2 construct for a single-node cluster, so this uses the
    // raw CloudFormation resources. Note how much more has to be spelled out.
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'Redis: reachable only from the API',
      allowAllOutbound: false,
    });
    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnets', {
      description: 'Private subnets for Redis',
      subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
    });
    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnets.ref,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
    });
    const redisUrl = `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`;

    // ---- Application image ---------------------------------------------------
    // Built from the repository's Dockerfile during `cdk deploy` and pushed to a
    // registry that CDK manages. `cdk synth` only fingerprints the files.
    const appImage = ecs.ContainerImage.fromDockerImageAsset(
      new DockerImageAsset(this, 'AppImage', {
        directory: path.join(__dirname, '..', '..'),
        platform: Platform.LINUX_AMD64,
      })
    );

    const temporalEnvironment = {
      TEMPORAL_ADDRESS: temporalAddress,
      TEMPORAL_NAMESPACE: 'default',
      TEMPORAL_TASK_QUEUE: TASK_QUEUE,
    };

    // ---- API behind a load balancer (L3 pattern) -----------------------------
    // One construct creates the load balancer, listener, target group, task
    // definition, service, security groups and IAM roles.
    const api = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
      cluster,
      publicLoadBalancer: true,
      desiredCount: 2,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform,
      minHealthyPercent: 100,
      // If new tasks keep failing, stop and roll back instead of retrying forever.
      circuitBreaker: { rollback: true },
      taskImageOptions: {
        image: appImage,
        command: ['node', 'src/api/server.js'],
        containerPort: API_PORT,
        environment: { ...temporalEnvironment, REDIS_URL: redisUrl, PORT: String(API_PORT) },
        logDriver: logTo('api'),
      },
    });
    api.targetGroup.configureHealthCheck({ path: '/health', healthyHttpCodes: '200' });
    // Default is 300 s: how long the balancer waits before removing a stopping task.
    api.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');

    // ---- Worker --------------------------------------------------------------
    // No load balancer and no open ports: workers only make outbound connections
    // to Temporal. More memory than the API because it bundles the workflow code.
    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform,
    });
    workerTask.addContainer('worker', {
      image: appImage,
      command: ['node', 'src/worker.js'],
      environment: temporalEnvironment,
      logging: logTo('worker'),
    });
    const workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
    });

    // ---- Who may talk to whom ------------------------------------------------
    // Security groups reference each other instead of IP ranges: "the API may
    // reach Temporal" stays true no matter which addresses the tasks get.
    temporalService.connections.allowFrom(api.service, ec2.Port.tcp(TEMPORAL_PORT), 'API to Temporal');
    temporalService.connections.allowFrom(workerService, ec2.Port.tcp(TEMPORAL_PORT), 'Worker to Temporal');
    redisSecurityGroup.connections.allowFrom(api.service, ec2.Port.tcp(REDIS_PORT), 'API to Redis');

    // ---- Creation order ------------------------------------------------------
    // The API and the worker exit at startup if Temporal is unreachable, so
    // CloudFormation must have the Temporal service running first.
    // The dependency is declared between the two service resources only. Declaring
    // it between the whole constructs would also tie their security groups
    // together and create a cycle with the rules above.
    const temporalServiceResource = temporalService.node.defaultChild;
    api.service.node.defaultChild.addResourceDependency(temporalServiceResource);
    workerService.node.defaultChild.addResourceDependency(temporalServiceResource);

    // ---- Outputs -------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `http://${api.loadBalancer.loadBalancerDnsName}`,
      description: 'Public URL of the API',
    });
  }
}

module.exports = { BusinessAutoStack };
