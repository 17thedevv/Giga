export interface AppConfig {
  readonly port: number;
}

export const DEFAULT_PORT = 3000;

export function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === '') {
    return DEFAULT_PORT;
  }

  const trimmed = rawPort.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid PORT configuration: "${rawPort}". PORT must be an integer between 1 and 65535.`
    );
  }

  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT configuration: "${rawPort}". PORT must be an integer between 1 and 65535.`
    );
  }

  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT),
  };
}
