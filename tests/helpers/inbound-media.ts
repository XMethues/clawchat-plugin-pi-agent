import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClawchatToolEnvironment } from "../../src/clawchat-tools.js";
import {
  InboundMediaMaterializer,
  type InboundMediaOptions
} from "../../src/inbound-media.js";

/**
 * Minimal Clawchat tool environment for suites that never run group turns, so
 * the group-memory surface is never reached. Do not use where a group turn
 * (or any tool execution) can occur.
 */
export const minimalTestTools = {
  memory: {} as never,
  api: {} as never,
  profile: () => ({}) as never
} as unknown as ClawchatToolEnvironment;

export const SMALL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  )
);
export const IMAGE_HEADERS = { "content-type": "image/png", "content-length": "1" };

const tempDirs: string[] = [];

export function registerTempDir(path: string): void {
  tempDirs.push(path);
}

export async function makeTempDir(prefix = "clawchat-test-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  registerTempDir(path);
  return path;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function leaseEntries(rootDir: string): Promise<string[]> {
  try {
    return await readdir(rootDir, { recursive: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function makeMaterializer(
  fetchFn: unknown,
  overrides: Partial<InboundMediaOptions> = {}
): Promise<{ rootDir: string; materializer: InboundMediaMaterializer }> {
  const parent = await makeTempDir("clawchat-inbound-media-");
  const rootDir = join(parent, "leases");
  return {
    rootDir,
    materializer: new InboundMediaMaterializer({
      rootDir,
      fetchFn: fetchFn as typeof fetch,
      ...overrides
    })
  };
}

export function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

export function pngResponse(): Response {
  return new Response(SMALL_PNG, { headers: IMAGE_HEADERS });
}

export function chunkedResponse(
  chunks: Uint8Array[],
  headers: ConstructorParameters<typeof Headers>[0] = IMAGE_HEADERS
) {
  let index = 0;
  let pullCount = 0;
  const cancelled = Promise.withResolvers<unknown>();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1;
          const chunk = chunks[index++];
          if (!chunk) return controller.close();
          controller.enqueue(chunk);
          if (index === chunks.length) controller.close();
        },
        cancel: cancelled.resolve
      },
      { highWaterMark: 0 }
    ),
    { headers }
  );
  return { response, pulls: () => pullCount, cancelled: cancelled.promise };
}

export function partiallyFailingResponse(chunk: Uint8Array): Response {
  let emitted = false;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (emitted) {
            controller.error(new TypeError("socket reset"));
            return;
          }
          emitted = true;
          controller.enqueue(chunk);
        }
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "image/png" } }
  );
}

export function failingAfterChunks(
  chunks: Uint8Array[]
): { response: Response; cancelled: Promise<unknown> } {
  const cancelled = Promise.withResolvers<unknown>();
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[index++];
          if (!chunk) {
            controller.error(new TypeError("socket reset"));
            return;
          }
          controller.enqueue(chunk);
        },
        cancel: cancelled.resolve
      },
      { highWaterMark: 0 }
    ),
    { headers: { "content-type": "image/png" } }
  );
  return { response, cancelled: cancelled.promise };
}

export function stalledResponse() {
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<unknown>();
  let firstPull = true;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!firstPull) {
            started.resolve();
            return new Promise<void>(() => undefined);
          }
          firstPull = false;
          controller.enqueue(SMALL_PNG.subarray(0, 8));
        },
        cancel: cancelled.resolve
      },
      { highWaterMark: 0 }
    ),
    { headers: IMAGE_HEADERS }
  );
  return { response, started: started.promise, cancelled: cancelled.promise };
}

export function splitEvery(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return chunks;
}
