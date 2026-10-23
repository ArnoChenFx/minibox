export declare function sshHost(name: string): string;
export declare function installCommands(origin: string): string;
export declare function windowsInstallCommands(origin: string): string;
export declare function setupCommands(origin: string): string;
export declare function windowsSetupCommands(origin: string): string;
export declare function connectCommands(name: string): string;
export interface DirectAddress {
  host: string;
  port: number;
}
export declare function directAddress(
  direct: { host?: string | null; port?: number } | null,
  hostname: string,
): DirectAddress | null;
export declare function directCommand(user: string, address: DirectAddress): string;
