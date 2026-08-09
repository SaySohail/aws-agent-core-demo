import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import {
  customerSupportGatewayTargetNames as gatewayTargetNames,
  customerSupportGatewayToolDefinitions,
  REFUND_AUTO_APPROVAL_LIMIT_CENTS
} from '@agent-launchpad/schemas';

/** Agent-specific data-plane resources; safe to tear down separately from customer bootstrap. */
export class CustomerSupportToolsStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('ManagedBy', 'AgentLaunchpad');
    cdk.Tags.of(this).add('Plane', 'DataPlane');
    cdk.Tags.of(this).add('Purpose', 'CustomerSupportTools');
    const table = new dynamodb.Table(this, 'SupportDataTable', {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY
    });
    table.addGlobalSecondaryIndex({
      indexName: 'OrdersByCustomer',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    const seedRole = new iam.Role(this, 'DemoSeedRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    seedRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [table.tableArn] })
    );
    const seedFunction = new NodejsFunction(this, 'DemoSeedFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '..', 'lambda', 'seed-demo-data.ts'),
      handler: 'handler',
      role: seedRole,
      timeout: Duration.seconds(30),
      bundling: { minify: true, target: 'node22' }
    });
    const seedProvider = new cr.Provider(this, 'DemoSeedProvider', {
      onEventHandler: seedFunction
    });
    new cdk.CustomResource(this, 'DemoSupportData', {
      serviceToken: seedProvider.serviceToken,
      properties: { tableName: table.tableName }
    }).node.addDependency(table);
    const createRole = (id: string) =>
      new iam.Role(this, `${id}Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        description: `Least-privilege execution role for ${id}.`
      });
    const tool = (id: string, handler: string, actions: string[], resources: string[]) => {
      const role = createRole(id);
      const group = new logs.LogGroup(this, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [group.logGroupArn]
        })
      );
      role.addToPolicy(new iam.PolicyStatement({ actions, resources }));
      return new NodejsFunction(this, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, '..', 'lambda', 'support-tool.ts'),
        handler,
        role,
        logGroup: group,
        timeout: Duration.seconds(15),
        environment: { SUPPORT_DATA_TABLE_NAME: table.tableName },
        bundling: { minify: true, target: 'node22' }
      });
    };
    const getOrder = tool('GetOrderFunction', 'getOrder', ['dynamodb:GetItem'], [table.tableArn]);
    const searchOrders = tool(
      'SearchOrdersFunction',
      'searchOrders',
      ['dynamodb:Query'],
      [`${table.tableArn}/index/OrdersByCustomer`]
    );
    const createTicket = tool(
      'CreateTicketFunction',
      'createSupportTicket',
      ['dynamodb:PutItem'],
      [table.tableArn]
    );
    const processRefund = tool(
      'ProcessRefundFunction',
      'processRefund',
      ['dynamodb:GetItem', 'dynamodb:TransactWriteItems'],
      [table.tableArn]
    );
    const policyEngine = new bedrockagentcore.CfnPolicyEngine(this, 'SupportPolicyEngine', {
      name: 'AgentLaunchpadSupportPolicy',
      description: 'Deterministic Cedar authorization for Customer Support Gateway actions.',
      tags: [
        { key: 'ManagedBy', value: 'AgentLaunchpad' },
        { key: 'Plane', value: 'DataPlane' },
        { key: 'Purpose', value: 'CustomerSupportTools' }
      ]
    });
    const gatewayRole = new iam.Role(this, 'GatewayServiceRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
        {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': Stack.of(this).formatArn({
              service: 'bedrock-agentcore',
              resource: 'gateway',
              resourceName: '*'
            })
          }
        }
      ),
      description: 'AgentCore Gateway service role limited to support-tool Lambda invocation.'
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          getOrder.functionArn,
          searchOrders.functionArn,
          createTicket.functionArn,
          processRefund.functionArn
        ]
      })
    );
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:GetPolicyEngine'],
        resources: [policyEngine.attrPolicyEngineArn]
      })
    );
    const gateway = new cdk.CfnResource(this, 'CustomerSupportGateway', {
      type: 'AWS::BedrockAgentCore::Gateway',
      properties: {
        Name: 'agent-launchpad-customer-support',
        Description: 'MCP gateway for Customer Support Agent tools.',
        ProtocolType: 'MCP',
        AuthorizerType: 'AWS_IAM',
        RoleArn: gatewayRole.roleArn,
        PolicyEngineConfiguration: { Arn: policyEngine.attrPolicyEngineArn, Mode: 'ENFORCE' },
        Tags: { ManagedBy: 'AgentLaunchpad', Plane: 'DataPlane', Purpose: 'CustomerSupportTools' }
      }
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:AuthorizeAction',
          'bedrock-agentcore:PartiallyAuthorizeActions'
        ],
        resources: [policyEngine.attrPolicyEngineArn, gateway.getAtt('GatewayArn').toString()]
      })
    );
    const target = (
      id: string,
      logicalName: keyof typeof gatewayTargetNames,
      fn: lambda.IFunction
    ) =>
      new cdk.CfnResource(this, id, {
        type: 'AWS::BedrockAgentCore::GatewayTarget',
        properties: {
          GatewayIdentifier: gateway.ref,
          Name: gatewayTargetNames[logicalName],
          Description: `Lambda target for ${logicalName}.`,
          CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
          TargetConfiguration: {
            Mcp: {
              Lambda: {
                LambdaArn: fn.functionArn,
                ToolSchema: {
                  InlinePayload: customerSupportGatewayToolDefinitions
                    .filter((tool) => tool.name === logicalName)
                    .map((tool) => ({
                      Name: tool.name,
                      Description: tool.description,
                      InputSchema: tool.inputSchema
                    }))
                }
              }
            }
          }
        }
      });
    const getTarget = target('GetOrderTarget', 'get_order', getOrder);
    const searchTarget = target('SearchOrdersTarget', 'search_orders', searchOrders);
    const ticketTarget = target('CreateTicketTarget', 'create_support_ticket', createTicket);
    const refundTarget = target('ProcessRefundTarget', 'process_refund', processRefund);
    const statement = (effect: 'permit' | 'forbid', action: string, condition?: string) =>
      cdk.Fn.join('', [
        `${effect}(principal is AgentCore::IamEntity, action == AgentCore::Action::"${action}", resource == AgentCore::Gateway::"`,
        gateway.getAtt('GatewayArn').toString(),
        `")${condition ? ` when { ${condition} }` : ''};`
      ]);
    const policy = (id: string, name: string, cedarStatement: string) => {
      const resource = new bedrockagentcore.CfnPolicy(this, id, {
        name,
        description: `Active Customer Support Gateway authorization policy: ${name}.`,
        policyEngineId: policyEngine.attrPolicyEngineId,
        enforcementMode: 'ACTIVE',
        validationMode: 'FAIL_ON_ANY_FINDINGS',
        definition: { cedar: { statement: cedarStatement } }
      });
      resource.addResourceDependency(getTarget);
      resource.addResourceDependency(searchTarget);
      resource.addResourceDependency(ticketTarget);
      resource.addResourceDependency(refundTarget);
      return resource;
    };
    policy(
      'GetOrderPermitPolicy',
      'SupportGetOrderPermit',
      statement('permit', `${gatewayTargetNames.get_order}___get_order`)
    );
    policy(
      'SearchOrdersPermitPolicy',
      'SupportSearchOrdersPermit',
      statement('permit', `${gatewayTargetNames.search_orders}___search_orders`)
    );
    policy(
      'CreateTicketPermitPolicy',
      'SupportCreateTicketPermit',
      statement('permit', `${gatewayTargetNames.create_support_ticket}___create_support_ticket`)
    );
    policy(
      'RefundPermitPolicy',
      'SupportRefundPermit',
      statement(
        'permit',
        `${gatewayTargetNames.process_refund}___process_refund`,
        `context.input.amountCents <= ${REFUND_AUTO_APPROVAL_LIMIT_CENTS}`
      )
    );
    policy(
      'RefundForbidPolicy',
      'SupportRefundForbid',
      statement(
        'forbid',
        `${gatewayTargetNames.process_refund}___process_refund`,
        `context.input.amountCents > ${REFUND_AUTO_APPROVAL_LIMIT_CENTS}`
      )
    );
    new cdk.CfnOutput(this, 'GatewayId', { value: gateway.ref });
    new cdk.CfnOutput(this, 'GatewayArn', { value: gateway.getAtt('GatewayArn').toString() });
    new cdk.CfnOutput(this, 'GatewayUrl', { value: gateway.getAtt('GatewayUrl').toString() });
    new cdk.CfnOutput(this, 'SupportDataTableName', { value: table.tableName });
    for (const [name, resource] of [
      ['GetOrderTargetId', getTarget],
      ['SearchOrdersTargetId', searchTarget],
      ['CreateTicketTargetId', ticketTarget],
      ['ProcessRefundTargetId', refundTarget]
    ] as const)
      new cdk.CfnOutput(this, name, { value: resource.getAtt('TargetId').toString() });
  }
}
