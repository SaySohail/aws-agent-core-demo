import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput
} from '@aws-sdk/client-bedrock-runtime';

export interface ModelClient {
  converse(input: ConverseCommandInput, abortSignal: AbortSignal): Promise<ConverseCommandOutput>;
}

export class BedrockConverseModelClient implements ModelClient {
  private readonly client: BedrockRuntimeClient;

  public constructor(
    region: string,
    client = new BedrockRuntimeClient({ region, maxAttempts: 2 })
  ) {
    this.client = client;
  }

  public async converse(
    input: ConverseCommandInput,
    abortSignal: AbortSignal
  ): Promise<ConverseCommandOutput> {
    return this.client.send(new ConverseCommand(input), { abortSignal });
  }
}
