declare module "livekit-server-sdk" {
  export class RoomServiceClient {
    constructor(host: string, apiKey?: string, apiSecret?: string);
    [key: string]: any;
  }
  export class SipClient {
    constructor(host: string, apiKey?: string, apiSecret?: string);
    [key: string]: any;
  }
}
