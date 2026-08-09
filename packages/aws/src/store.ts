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
  delete(
    key: Record<string, string>,
    condition?: string,
    conditionValues?: Record<string, unknown>
  ): Promise<void>;
  query(input: QueryInput): Promise<QueryResult>;
}

export interface QueryInput {
  readonly indexName?: string | undefined;
  readonly partitionKey: 'pk' | 'gsi1pk' | 'gsi2pk' | 'gsi3pk' | 'gsi4pk';
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
  readonly conditionNames?: Record<string, string>;
  readonly conditionValues?: Record<string, unknown>;
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

  async update({ key, updates, condition, conditionNames, conditionValues }: UpdateInput) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const fields = Object.keys(updates);
    const assignments = Object.entries(updates).flatMap(([field, value], position) => {
      const name = `#f${position}`;
      names[name] = field;
      if (value === undefined) return [];
      const placeholder = `:v${position}`;
      values[placeholder] = value;
      return `${name} = ${placeholder}`;
    });
    const removals = Object.entries(updates)
      .filter(([, value]) => value === undefined)
      .map(([field]) => `#f${fields.indexOf(field)}`);
    await this.documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: [assignments.length ? `SET ${assignments.join(', ')}` : '', removals.length ? `REMOVE ${removals.join(', ')}` : ''].filter(Boolean).join(' '),
        ExpressionAttributeNames: { ...names, ...conditionNames },
        ExpressionAttributeValues: values,
        ConditionExpression: condition,
        ...(conditionValues ? { ExpressionAttributeValues: { ...values, ...conditionValues } } : {})
      })
    );
  }

  async delete(
    key: Record<string, string>,
    condition?: string,
    conditionValues?: Record<string, unknown>
  ) {
    await this.documentClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: key,
        ConditionExpression: condition,
        ...(conditionValues ? { ExpressionAttributeValues: conditionValues } : {})
      })
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
          : input.indexName === 'DeploymentsByAgent'
            ? 'gsi2sk'
            : input.indexName === 'RuntimeVersionsByAgent'
              ? 'gsi4sk'
              : 'gsi3sk'
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
