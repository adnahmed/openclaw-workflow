declare module 'openclaw/plugin-sdk/plugin-entry' {
  export function definePluginEntry(entry: {
    id: string;
    name: string;
    description: string;
    configSchema?: any;
    register(api: any): void | Promise<void>;
  }): any;
}
