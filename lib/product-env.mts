export type ProductEnv = Record<string, string | undefined>;

export function productEnv(env: ProductEnv, suffix: string): string | undefined {
  return env[`KHEREP_${suffix}`];
}
