import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';

export interface PersistenceClient {
  get(key: Record<string, string>): Promise<Record<string, unknown> | undefined>;
  batchGet(keys: readonly Record<string, string>[]): Promise<readonly Record<string, unknown>[]>;
  put(item: Record<string, unknown>, condition?: string): Promise<void>;
  update(input: UpdateInput): Promise<void>;
  delete(key: Record<string, string>, condition?: string): Promise<void>;
  query(input: QueryInput): Promise<QueryResult>;
}

export interface QueryInput {
  readonly indexName?: string | undefined;
  readonly partitionKey: 'pk' | 'gsi1pk' | 'gsi2pk';
  readonly partitionValue: string;
  readonly sortKeyPrefix?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: Record<string, string> | undefined;
}

export interface QueryResult {
  readonly items: readonly Record<string, unknown>[];
  readonly nextKey?: Record<string, string>;
}

export interface UpdateInput {
  readonly key: Record<string, string>;
  readonly updates: Record<string, unknown>;
  readonly condition?: string;
}

/** Concrete server-side adapter; repositories accept the narrow port above for testability. */
export class DynamoDbPersistenceClient implements PersistenceClient {
  public constructor(
    private readonly documentClient: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async get(key: Record<string, string>) {
    return (await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: key })))
      .Item;
  }

  async batchGet(keys: readonly Record<string, string>[]) {
    if (!keys.length) return [];
    const response = await this.documentClient.send(
      new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: [...keys] } } })
    );
    return response.Responses?.[this.tableName] ?? [];
  }

  async put(item: Record<string, unknown>, condition?: string) {
    await this.documentClient.send(
      new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: condition })
    );
  }

  async update({ key, updates, condition }: UpdateInput) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const assignments = Object.entries(updates).map(([field, value], index) => {
      const name = `#f${index}`;
      const placeholder = `:v${index}`;
      names[name] = field;
      values[placeholder] = value;
      return `${name} = ${placeholder}`;
    });
    await this.documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: condition
      })
    );
  }

  async delete(key: Record<string, string>, condition?: string) {
    await this.documentClient.send(
      new DeleteCommand({ TableName: this.tableName, Key: key, ConditionExpression: condition })
    );
  }

  async query(input: QueryInput): Promise<QueryResult> {
    const names: Record<string, string> = { '#pk': input.partitionKey };
    const values: Record<string, unknown> = { ':pk': input.partitionValue };
    let expression = '#pk = :pk';
    if (input.sortKeyPrefix) {
      names['#sk'] = input.indexName
        ? input.indexName === 'MembershipsByUser'
          ? 'gsi1sk'
          : 'gsi2sk'
        : 'sk';
      values[':prefix'] = input.sortKeyPrefix;
      expression += ' AND begins_with(#sk, :prefix)';
    }
    const response = await this.documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: input.indexName,
        KeyConditionExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        Limit: input.limit,
        ExclusiveStartKey: input.cursor
      })
    );
    const nextKey = response.LastEvaluatedKey as Record<string, string> | undefined;
    return nextKey ? { items: response.Items ?? [], nextKey } : { items: response.Items ?? [] };
  }
}
