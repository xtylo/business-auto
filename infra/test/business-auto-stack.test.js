// Infrastructure tests.
//
// They synthesize the stack in memory and assert on the CloudFormation template.
// Nothing is deployed and no AWS credentials are needed. The point is to pin
// down the decisions that matter (what is public, who can reach what), so a
// later edit cannot change them by accident.

const cdk = require('aws-cdk-lib');
const { Template, Match } = require('aws-cdk-lib/assertions');
const { BusinessAutoStack } = require('../lib/business-auto-stack');

let template;

beforeAll(() => {
  const app = new cdk.App();
  const stack = new BusinessAutoStack(app, 'TestStack');
  template = Template.fromStack(stack);
});

/** Finds the task definition that has a container with the given name. */
function containerNamed(name) {
  const definitions = template.findResources('AWS::ECS::TaskDefinition');
  for (const definition of Object.values(definitions)) {
    const container = definition.Properties.ContainerDefinitions.find((c) => c.Name === name);
    if (container) return container;
  }
  throw new Error(`No container named "${name}" in the template`);
}

const environmentOf = (container) =>
  Object.fromEntries(container.Environment.map(({ Name, Value }) => [Name, Value]));

describe('network', () => {
  test('one VPC with two public and two private subnets', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('a single NAT gateway, to keep the cost down', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });
});

describe('services', () => {
  test('three ECS services: API, worker and Temporal', () => {
    template.resourceCountIs('AWS::ECS::Service', 3);
  });

  test('every service runs on Fargate, in private subnets, with no public IP', () => {
    const services = Object.values(template.findResources('AWS::ECS::Service'));
    for (const service of services) {
      expect(service.Properties.LaunchType).toBe('FARGATE');
      expect(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED');
    }
  });

  test('the API runs two tasks so the load balancer has something to balance', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      LoadBalancers: Match.arrayWith([Match.objectLike({ ContainerPort: 3000 })]),
    });
  });

  test('the API and the worker run the same image with different commands', () => {
    const api = containerNamed('web');
    const worker = containerNamed('worker');

    expect(api.Command).toEqual(['node', 'src/api/server.js']);
    expect(worker.Command).toEqual(['node', 'src/worker.js']);
    expect(worker.Image).toEqual(api.Image);
  });

  test('the API and the worker point at the same Temporal address and task queue', () => {
    const api = environmentOf(containerNamed('web'));
    const worker = environmentOf(containerNamed('worker'));

    expect(api.TEMPORAL_ADDRESS).toBe('temporal.business-auto.local:7233');
    expect(worker.TEMPORAL_ADDRESS).toBe(api.TEMPORAL_ADDRESS);
    expect(worker.TEMPORAL_TASK_QUEUE).toBe(api.TEMPORAL_TASK_QUEUE);
  });

  test('only the API gets the Redis URL; the worker does not use Redis', () => {
    expect(environmentOf(containerNamed('web'))).toHaveProperty('REDIS_URL');
    expect(environmentOf(containerNamed('worker'))).not.toHaveProperty('REDIS_URL');
  });

  test('the worker exposes no ports', () => {
    expect(containerNamed('worker').PortMappings).toBeUndefined();
  });

  test('Temporal is registered in private DNS as "temporal"', () => {
    template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'business-auto.local',
    });
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'temporal' });
  });

  test('the API and the worker are created after the Temporal service', () => {
    const services = template.findResources('AWS::ECS::Service');
    const temporalId = Object.keys(services).find((id) => id.startsWith('TemporalService'));
    const dependents = Object.entries(services).filter(([id]) => id !== temporalId);

    expect(dependents).toHaveLength(2);
    for (const [, service] of dependents) {
      expect(service.DependsOn).toContain(temporalId);
    }
  });
});

describe('load balancer', () => {
  test('one internet-facing application load balancer', () => {
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
  });

  test('health checks use the /health endpoint', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health',
      Port: 80,
      TargetType: 'ip',
    });
  });
});

describe('security', () => {
  test('the load balancer is the only thing open to the internet', () => {
    const groups = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
    const openToTheWorld = groups.filter((group) =>
      (group.Properties.SecurityGroupIngress || []).some((rule) => rule.CidrIp === '0.0.0.0/0')
    );

    expect(openToTheWorld).toHaveLength(1);
    expect(openToTheWorld[0].Properties.SecurityGroupIngress).toEqual([
      expect.objectContaining({ CidrIp: '0.0.0.0/0', FromPort: 80, ToPort: 80 }),
    ]);
  });

  test('Temporal accepts connections on 7233 from exactly two sources: API and worker', () => {
    const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (rule) => rule.Properties.FromPort === 7233
    );

    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      // The source is another security group, never an IP range.
      expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
      expect(rule.Properties.CidrIp).toBeUndefined();
    }
  });

  test('Redis accepts connections on 6379 from exactly one source: the API', () => {
    const rules = Object.values(template.findResources('AWS::EC2::SecurityGroupIngress')).filter(
      (rule) => rule.Properties.FromPort === 6379
    );

    expect(rules).toHaveLength(1);
    expect(rules[0].Properties.SourceSecurityGroupId).toBeDefined();
  });
});

describe('data and logs', () => {
  test('a single small Redis node', () => {
    template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'redis',
      CacheNodeType: 'cache.t4g.micro',
      NumCacheClusters: 1,
      AutomaticFailoverEnabled: false,
    });
  });

  test('the API gets a Redis URL built from the primary endpoint address and port', () => {
    // Regression test: an earlier version read endpoint attributes that came back
    // empty at deploy time, and the API received "redis://:".
    const redisUrl = environmentOf(containerNamed('web')).REDIS_URL;
    const attributes = redisUrl['Fn::Join'][1]
      .filter((part) => typeof part === 'object')
      .map((part) => part['Fn::GetAtt'][1]);

    expect(attributes).toEqual(['PrimaryEndPoint.Address', 'PrimaryEndPoint.Port']);
  });

  test('log entries expire after one week, and the log group survives a rollback', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    template.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Retain' });
  });
});

test('the stack outputs the public URL of the API', () => {
  template.hasOutput('ApiUrl', {});
});
