import { isAbsolute, resolve } from "node:path";

export function resolveRepositoryPath(
  configuredPath: string,
  controlPackageRoot: string,
): string {
  if (isAbsolute(configuredPath)) return resolve(configuredPath);
  return resolve(controlPackageRoot, "..", "..", configuredPath);
}
