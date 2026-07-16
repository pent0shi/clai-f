
export interface SecretRequest {
  readonly title: string;
  readonly prompt: string;
}

export interface SecretPort {
  request(request: SecretRequest): Promise<string | undefined>;
}
