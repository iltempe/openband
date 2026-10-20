export const REPO: string;
export const PACKAGE_SPEC: string;
export const versionSpec: (version: string) => string;
export const NPX_ARGS: string[];
export const RUN: string;
export const isOurPackage: (arg: unknown) => boolean;
export const SERVER_ENTRY: { command: string; args: string[] };
