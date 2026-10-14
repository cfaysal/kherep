import type { ServiceAdapter, ServicePlatform } from "./service-types.mts";
import { MacServiceAdapter, validateServiceName } from "./service-platform-mac.mts";
import { splitWindowsService, WindowsServiceAdapter } from "./service-platform-windows.mts";

export function servicePlatform(serviceRoot: string, platform: NodeJS.Platform = process.platform): ServiceAdapter {
  if (platform === "darwin") return new MacServiceAdapter(serviceRoot);
  if (platform === "win32") return new WindowsServiceAdapter();
  throw new Error("managed daemon services are supported only on macOS and Windows");
}

export function supportedServicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform {
  if (platform === "darwin" || platform === "win32") return platform;
  throw new Error("managed daemon services are supported only on macOS and Windows");
}

export function serviceSelector(
  platform: ServicePlatform, serviceName: string, taskPath?: string,
): { serviceName: string; taskPath?: string } {
  if (platform === "win32") return splitWindowsService(serviceName, taskPath);
  if (taskPath) throw new Error("task path applies only to Windows Scheduled Tasks");
  return { serviceName: validateServiceName(serviceName) };
}
