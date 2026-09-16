declare module "livekit-server-sdk" {
  export class RoomServiceClient {
    constructor(host: string, apiKey?: string, apiSecret?: string);
    [key: string]: any;
  }
  export class SipClient {
    constructor(host: string, apiKey?: string, apiSecret?: string);
    [key: string]: any;
  }
  export class AgentDispatchClient {
    constructor(host: string, apiKey?: string, apiSecret?: string);
    createDispatch(roomName: string, agentName: string, options?: { metadata?: string }): Promise<unknown>;
  }
  export class AccessToken {
    constructor(apiKey?: string, apiSecret?: string, options?: { identity?: string; name?: string; ttl?: number | string; metadata?: string });
    addGrant(grant: Record<string, unknown>): void;
    toJwt(): Promise<string>;
  }
}
