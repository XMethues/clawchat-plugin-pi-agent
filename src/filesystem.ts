import { lstat } from "node:fs/promises";

export async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function isFileSystemError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
