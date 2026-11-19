export function childEnv(input: {
  processEnv: Record<string, string | undefined>;
  fileConfig: Record<string, string | undefined>;
  configPath: string;
}): Record<string, string | undefined>;
