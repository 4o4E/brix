export interface RemoteRun {
  runId: string;
  output: unknown;
  downloads: { name: string; bytes: number; mimeType: string }[];
}

export class BrixClient {
  inSession<T>(id: string | undefined, fn: (id: string) => Promise<T>, url?: string): Promise<T>;
  run(id: string, name: string, args: unknown): Promise<RemoteRun>;
  put(name: string, source: string, language: 'js' | 'ts'): Promise<unknown>;
  download(runId: string, name: string, destination: string): Promise<{ path: string; bytes: number }>;
}

export function clientFromEnv(env?: NodeJS.ProcessEnv): BrixClient;
