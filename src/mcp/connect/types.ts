export interface ServerConfigOptions {
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface ConnectResult {
  client: string;
  displayName: string;
  configPath: string;
  created: boolean;
  updated: boolean;
}

export interface ClientAdapter {
  readonly clientName: string;
  readonly displayName: string;
  readonly defaultPathDescription: string;
  resolveConfigPath(baseDir?: string): string;
  mergeConfig(
    existingContent: string | null,
    options?: ServerConfigOptions,
  ): string;
}
