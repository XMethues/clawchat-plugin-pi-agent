import { Buffer } from "node:buffer";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  convertToPng,
  formatDimensionNote,
  resizeImage
} from "@earendil-works/pi-coding-agent";
import { hasMediaFragments, renderInboundPrompt, renderInboundPromptHeader } from "./inbound.js";
import type { ClawchatInboundMessage, MediaFragment } from "./types.js";

export interface InboundMediaPolicy {
  maxAttachmentBytes: number;
  maxTurnBytes: number;
  connectionTimeoutMs: number;
  noProgressTimeoutMs: number;
  attachmentTimeoutMs: number;
  turnTimeoutMs: number;
}
export type InboundMediaRemoveFn = (
  path: string,
  options: { recursive: boolean; force: boolean }
) => Promise<void>;


export interface InboundMediaOptions {
  rootDir: string;
  fetchFn?: typeof fetch;
  policy?: Partial<InboundMediaPolicy>;
  delayFn?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  removeFn?: InboundMediaRemoveFn;
}

export interface PiPromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface MaterializedInboundTurn {
  prompt: string;
  images: PiPromptImage[];
  release(): Promise<void>;
}

interface DownloadedAttachment {
  number: number;
  kind: MediaFragment["kind"];
  safeName: string;
  declaredMime?: string;
  detectedMime?: string;
  bytes: Uint8Array;
  byteLength: number;
  path: string;
}

interface DownloadedBody {
  bytes: Uint8Array;
  mimeType: string;
  detectedMime?: string;
}

type UnavailableCategory = "invalid source" | "size limit" | "turn limit" | "download failed";

const DEFAULT_POLICY: InboundMediaPolicy = {
  maxAttachmentBytes: 100 * 1024 * 1024,
  maxTurnBytes: 256 * 1024 * 1024,
  connectionTimeoutMs: 30_000,
  noProgressTimeoutMs: 30_000,
  attachmentTimeoutMs: 2 * 60_000,
  turnTimeoutMs: 5 * 60_000
};
const RETRY_DELAY_MS = 250;
const MAX_DOWNLOAD_ATTEMPTS = 2;
const MAX_REMOVE_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const MAX_FILENAME_BYTES = 120;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export function plainInboundTurn(message: ClawchatInboundMessage): MaterializedInboundTurn {
  return { prompt: renderInboundPrompt(message), images: [], release: async () => undefined };
}

class AttachmentByteBudget {
  private usedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  get used(): number {
    return this.usedBytes;
  }

  remaining(): number {
    return this.maximumBytes - this.usedBytes;
  }

  account(count: number): void {
    this.usedBytes += count;
  }
}

type DelayFn = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type TimeoutKey =
  | "connectionTimeoutMs"
  | "noProgressTimeoutMs"
  | "attachmentTimeoutMs"
  | "turnTimeoutMs";

class DownloadFailure extends Error {
  constructor(
    readonly retryable: boolean,
    message = "Inbound media download failed"
  ) {
    super(message);
  }
}

export class InboundMediaMaterializer {
  private readonly rootDir: string;
  private readonly fetchFn: typeof fetch;
  private readonly policy: InboundMediaPolicy;
  private readonly retryDelayFn: DelayFn;
  private readonly removeFn: InboundMediaRemoveFn;
  private readonly injectedPolicy: Partial<InboundMediaPolicy>;
  private readonly injectedDelayFn: DelayFn | undefined;

  constructor(options: InboundMediaOptions) {
    this.rootDir = resolve(options.rootDir);
    this.fetchFn = options.fetchFn ?? fetch;
    this.injectedPolicy = options.policy ?? {};
    this.policy = { ...DEFAULT_POLICY, ...this.injectedPolicy };
    this.removeFn = options.removeFn ?? rm;
    this.retryDelayFn = options.delayFn ?? defaultDelay;
    this.injectedDelayFn = options.delayFn;
  }

  async cleanupStaleLeases(): Promise<void> {
    await this.ensurePrivateRoot();
    for (const entry of await readdir(this.rootDir)) {
      await this.removeWithRetries(join(this.rootDir, entry));
    }
  }

  async materialize(
    message: ClawchatInboundMessage,
    signal?: AbortSignal
  ): Promise<MaterializedInboundTurn> {
    const fragments = message.payload.message.body.fragments;
    if (!hasMediaFragments(fragments)) {
      return plainInboundTurn(message);
    }

    let leaseDir: string | undefined;
    let releasePromise: Promise<void> | undefined;
    const release = (): Promise<void> => {
      if (!leaseDir) return Promise.resolve();
      if (releasePromise) return releasePromise;
      const directory = leaseDir;
      releasePromise = this.removeWithRetries(directory).then(() => {
        if (leaseDir === directory) leaseDir = undefined;
      });
      return releasePromise;
    };
    const ensureLease = async (): Promise<string> => {
      if (leaseDir) return leaseDir;
      await this.ensurePrivateRoot();
      leaseDir = await mkdtemp(join(this.rootDir, "turn-"));
      await chmod(leaseDir, 0o700);
      return leaseDir;
    };

    const turnController = new AbortController();
    const unlinkCaller = linkAbort(signal, turnController);
    const stopTurnTimeout = startAbortTimer(
      this.policy.turnTimeoutMs,
      turnController,
      new DownloadFailure(false, "Inbound media Turn timed out"),
      this.timeoutDelayFn("turnTimeoutMs")
    );
    const aggregate = { downloadedBytes: 0 };
    const images: PiPromptImage[] = [];
    const projections: string[] = [];
    const usedNames = new Set<string>();
    let previousProjectionWasText = false;
    const addUnavailable = (
      fragment: MediaFragment,
      number: number,
      category: UnavailableCategory
    ): void => {
      if (fragment.kind === "image") {
        projections.push(`[Image ${number} unavailable: ${category}]`);
      } else {
        projections.push(`[Attachment ${number} unavailable: ${category}]`);
      }
    };

    try {
      for (const [index, fragment] of fragments.entries()) {
        if (fragment.kind === "text") {
          if (previousProjectionWasText) {
            const previous = projections.length - 1;
            projections[previous] = projections[previous]! + fragment.text;
          } else {
            projections.push(fragment.text);
          }
          previousProjectionWasText = true;
          continue;
        }
        if (fragment.kind === "mention") continue;
        previousProjectionWasText = false;
        const number = index + 1;
        if (signal?.aborted) throw callerAbortFailure();
        if (turnController.signal.aborted) {
          addUnavailable(fragment, number, "download failed");
          continue;
        }
        if (aggregate.downloadedBytes >= this.policy.maxTurnBytes) {
          addUnavailable(fragment, number, "turn limit");
          continue;
        }

        if (
          advisorySizeExceeds(
            fragment.size,
            this.policy.maxAttachmentBytes,
            this.policy.maxTurnBytes - aggregate.downloadedBytes
          )
        ) {
          addUnavailable(fragment, number, "size limit");
          continue;
        }

        const url = acceptedClawlingUrl(fragment.url);
        if (!url) {
          addUnavailable(fragment, number, "invalid source");
          continue;
        }

        try {
          const downloaded = await this.downloadAttachment(
            url,
            fragment,
            aggregate,
            turnController.signal
          );
          if (signal?.aborted) throw callerAbortFailure();
          if (turnController.signal.aborted) throw failureFromAbort(turnController.signal);

          const processedImage =
            fragment.kind === "image" ? await processInboundImage(downloaded.bytes) : undefined;
          if (fragment.kind === "image" && !processedImage) {
            throw new DownloadFailure(false, "Inbound image could not be decoded");
          }
          if (signal?.aborted) throw callerAbortFailure();
          if (turnController.signal.aborted) throw failureFromAbort(turnController.signal);

          const directory = await ensureLease();
          const safeName = allocateSafeFilename(
            fragment.name,
            number,
            fragment.kind,
            fragment.mime,
            downloaded.detectedMime,
            downloaded.mimeType,
            usedNames
          );
          const sourcePath = join(directory, safeName);
          await writeFile(sourcePath, downloaded.bytes, { flag: "wx", mode: 0o600 });
          if (signal?.aborted) throw callerAbortFailure();
          if (turnController.signal.aborted) throw failureFromAbort(turnController.signal);

          if (processedImage) {
            images.push({
              type: "image",
              data: processedImage.data,
              mimeType: processedImage.mimeType
            });
            projections.push(`[Image ${number}]`, ...processedImage.hints);
            continue;
          }

          const attachment: DownloadedAttachment = {
            number,
            kind: fragment.kind,
            safeName,
            ...(fragment.mime?.trim() ? { declaredMime: fragment.mime.trim() } : {}),
            ...(downloaded.detectedMime ? { detectedMime: downloaded.detectedMime } : {}),
            bytes: downloaded.bytes,
            byteLength: downloaded.bytes.byteLength,
            path: sourcePath
          };
          projections.push(projectAttachment(attachment));
        } catch {
          if (signal?.aborted) throw callerAbortFailure();
          addUnavailable(fragment, number, "download failed");
        }
      }

      return {
        prompt: renderMaterializedPrompt(message, projections),
        images,
        release
      };
    } catch (error: unknown) {
      await release();
      throw error;
    } finally {
      stopTurnTimeout();
      unlinkCaller();
    }
  }

  private async ensurePrivateRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
  }

  private async removeWithRetries(path: string): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < MAX_REMOVE_ATTEMPTS; attempt += 1) {
      try {
        await this.removeFn(path, { recursive: true, force: true });
        return;
      } catch (error: unknown) {
        failure = error;
      }
    }
    throw failure;
  }

  private timeoutDelayFn(key: TimeoutKey): DelayFn {
    return Object.hasOwn(this.injectedPolicy, key) && this.injectedDelayFn
      ? this.injectedDelayFn
      : defaultDelay;
  }

  private async downloadAttachment(
    initialUrl: string,
    fragment: MediaFragment,
    aggregate: { downloadedBytes: number },
    turnSignal: AbortSignal
  ): Promise<DownloadedBody> {
    const attachmentController = new AbortController();
    const unlinkTurn = linkAbort(turnSignal, attachmentController);
    const stopAttachmentTimeout = startAbortTimer(
      this.policy.attachmentTimeoutMs,
      attachmentController,
      new DownloadFailure(false, "Inbound media attachment timed out"),
      this.timeoutDelayFn("attachmentTimeoutMs")
    );

    try {
      for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
        const attemptBudget = new AttachmentByteBudget(this.policy.maxAttachmentBytes);
        try {
          return await this.downloadAttempt(
            initialUrl,
            fragment,
            aggregate,
            attemptBudget,
            attachmentController.signal
          );
        } catch (error: unknown) {
          aggregate.downloadedBytes -= attemptBudget.used;
          const failure =
            error instanceof DownloadFailure
              ? error
              : new DownloadFailure(false, "Inbound media processing failed");
          if (
            attempt < MAX_DOWNLOAD_ATTEMPTS - 1 &&
            failure.retryable &&
            !attachmentController.signal.aborted &&
            !turnSignal.aborted
          ) {
            await this.retryDelayFn(RETRY_DELAY_MS, attachmentController.signal);
            continue;
          }
          throw failure;
        }
      }
      throw new DownloadFailure(false);
    } finally {
      stopAttachmentTimeout();
      unlinkTurn();
    }
  }

  private async downloadAttempt(
    initialUrl: string,
    fragment: MediaFragment,
    aggregate: { downloadedBytes: number },
    attemptBudget: AttachmentByteBudget,
    attachmentSignal: AbortSignal
  ): Promise<DownloadedBody> {
    let currentUrl = initialUrl;

    for (let redirectCount = 0; ; redirectCount += 1) {
      if (attachmentSignal.aborted) throw failureFromAbort(attachmentSignal);
      const requestController = new AbortController();
      const unlinkAttachment = linkAbort(attachmentSignal, requestController);

      try {
        const stopConnectionTimeout = startAbortTimer(
          this.policy.connectionTimeoutMs,
          requestController,
          new DownloadFailure(true, "Inbound media connection timed out"),
          this.timeoutDelayFn("connectionTimeoutMs")
        );
        let response: Response;

        try {
          response = await this.fetchFn(currentUrl, {
            redirect: "manual",
            signal: requestController.signal
          });
        } catch {
          if (requestController.signal.aborted) throw failureFromAbort(requestController.signal);
          throw new DownloadFailure(true);
        } finally {
          stopConnectionTimeout();
        }

        if (requestController.signal.aborted) {
          cancelResponseBody(response);
          throw failureFromAbort(requestController.signal);
        }

        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308
        ) {
          cancelResponseBody(response);
          if (redirectCount >= MAX_REDIRECTS) throw new DownloadFailure(false);
          const redirectedUrl = acceptedRedirectUrl(response.headers.get("location"), currentUrl);
          if (!redirectedUrl) throw new DownloadFailure(false);
          currentUrl = redirectedUrl;
          continue;
        }

        if (!response.ok) {
          cancelResponseBody(response);
          throw new DownloadFailure(
            response.status === 408 ||
              response.status === 429 ||
              (response.status >= 500 && response.status <= 599)
          );
        }

        const detectedMime = normalizeMimeType(response.headers.get("content-type"));
        const mimeType =
          fragment.kind === "image"
            ? imageMimeType(response.headers.get("content-type"), fragment.mime)
            : detectedMime ?? normalizeMimeType(fragment.mime) ?? "application/octet-stream";
        if (!mimeType) {
          cancelResponseBody(response);
          throw new DownloadFailure(false);
        }

        const remainingAttachmentBytes = attemptBudget.remaining();
        const remainingTurnBytes = this.policy.maxTurnBytes - aggregate.downloadedBytes;
        const declaredContentLength = contentLength(response.headers.get("content-length"));
        if (
          advisorySizeExceeds(
            declaredContentLength,
            remainingAttachmentBytes,
            remainingTurnBytes
          )
        ) {
          cancelResponseBody(response);
          throw new DownloadFailure(false);
        }

        return await this.readResponseBody(
          response,
          mimeType,
          detectedMime,
          declaredContentLength,
          aggregate,
          requestController,
          attemptBudget
        );
      } finally {
        unlinkAttachment();
      }
    }
  }

  private async readResponseBody(
    response: Response,
    mimeType: string,
    detectedMime: string | undefined,
    declaredContentLength: number | undefined,
    aggregate: { downloadedBytes: number },
    requestController: AbortController,
    attemptBudget: AttachmentByteBudget
  ): Promise<DownloadedBody> {
    if (requestController.signal.aborted) {
      cancelResponseBody(response);
      throw failureFromAbort(requestController.signal);
    }
    if (!response.body) {
      return {
        bytes: new Uint8Array(),
        mimeType,
        ...(detectedMime ? { detectedMime } : {})
      };
    }

    const reader = response.body.getReader();
    const cancelReader = () => {
      void reader.cancel(requestController.signal.reason).catch(() => undefined);
    };
    if (requestController.signal.aborted) {
      cancelReader();
      throw failureFromAbort(requestController.signal);
    }
    requestController.signal.addEventListener("abort", cancelReader, { once: true });
    const bodyBuffer = new BoundedBodyBuffer(
      Math.min(
        attemptBudget.remaining(),
        this.policy.maxTurnBytes - aggregate.downloadedBytes
      ),
      declaredContentLength
    );
    let completed = false;

    try {
      for (;;) {
        const stopNoProgressTimeout = startAbortTimer(
          this.policy.noProgressTimeoutMs,
          requestController,
          new DownloadFailure(true, "Inbound media download made no progress"),
          this.timeoutDelayFn("noProgressTimeoutMs")
        );
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          for (;;) {
            const abortedRead = Promise.withResolvers<never>();
            const rejectAbortedRead = () =>
              abortedRead.reject(failureFromAbort(requestController.signal));
            if (requestController.signal.aborted) rejectAbortedRead();
            else {
              requestController.signal.addEventListener("abort", rejectAbortedRead, {
                once: true
              });
            }
            try {
              read = await Promise.race([reader.read(), abortedRead.promise]);
            } catch {
              if (requestController.signal.aborted) {
                throw failureFromAbort(requestController.signal);
              }
              throw new DownloadFailure(true);
            } finally {
              requestController.signal.removeEventListener("abort", rejectAbortedRead);
            }
            if (read.done || read.value.byteLength > 0) break;
          }
        } finally {
          stopNoProgressTimeout();
        }

        if (requestController.signal.aborted) throw failureFromAbort(requestController.signal);
        if (read.done) break;

        const count = read.value.byteLength;
        attemptBudget.account(count);
        aggregate.downloadedBytes += count;
        if (
          attemptBudget.used > this.policy.maxAttachmentBytes ||
          aggregate.downloadedBytes > this.policy.maxTurnBytes
        ) {
          throw new DownloadFailure(false);
        }
        bodyBuffer.append(read.value);
      }

      completed = true;
      return {
        bytes: bodyBuffer.finish(),
        mimeType,
        ...(detectedMime ? { detectedMime } : {})
      };
    } finally {
      requestController.signal.removeEventListener("abort", cancelReader);
      if (!completed) void reader.cancel().catch(() => undefined);
      else reader.releaseLock();
    }
  }
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function startAbortTimer(
  milliseconds: number,
  controller: AbortController,
  reason: DownloadFailure,
  delayFn: DelayFn
): () => void {
  const timerController = new AbortController();
  void delayFn(milliseconds, timerController.signal).then(
    () => {
      if (!timerController.signal.aborted) controller.abort(reason);
    },
    () => undefined
  );
  return () => timerController.abort();
}

function linkAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function failureFromAbort(signal: AbortSignal): DownloadFailure {
  return signal.reason instanceof DownloadFailure
    ? signal.reason
    : new DownloadFailure(false, "Inbound media materialization was aborted");
}

function callerAbortFailure(): Error {
  return new Error("Inbound media materialization was aborted");
}

function acceptedRedirectUrl(location: string | null, baseUrl: string): string | undefined {
  if (!location) return undefined;
  try {
    return acceptedClawlingUrl(new URL(location, baseUrl).href);
  } catch {
    return undefined;
  }
}

function contentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function advisorySizeExceeds(
  value: number | undefined,
  attachmentBudget: number,
  turnBudget: number
): boolean {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    value >= 0 &&
    (value > attachmentBudget || value > turnBudget)
  );
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

class BoundedBodyBuffer {
  private storage: Uint8Array;
  private byteLength = 0;

  constructor(
    private readonly maximumByteLength: number,
    capacityHint: number | undefined
  ) {
    const trustedHint =
      capacityHint !== undefined &&
      capacityHint >= 0 &&
      capacityHint <= maximumByteLength
        ? capacityHint
        : 0;
    this.storage = new Uint8Array(trustedHint);
  }

  append(chunk: Uint8Array): void {
    const requiredLength = this.byteLength + chunk.byteLength;
    if (requiredLength > this.maximumByteLength) throw new DownloadFailure(false);
    if (requiredLength > this.storage.byteLength) this.grow(requiredLength);
    this.storage.set(chunk, this.byteLength);
    this.byteLength = requiredLength;
  }

  finish(): Uint8Array {
    if (this.byteLength === this.storage.byteLength) return this.storage;
    return this.storage.subarray(0, this.byteLength);
  }

  private grow(requiredLength: number): void {
    let capacity = this.storage.byteLength;
    if (capacity === 0) {
      capacity = Math.min(this.maximumByteLength, Math.max(requiredLength, 16 * 1024));
    }
    while (capacity < requiredLength) {
      const doubled =
        capacity <= Math.floor(this.maximumByteLength / 2)
          ? capacity * 2
          : this.maximumByteLength;
      capacity = Math.min(this.maximumByteLength, Math.max(requiredLength, doubled));
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.storage.subarray(0, this.byteLength));
    this.storage = grown;
  }
}

function acceptedClawlingUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const acceptedHost = ["clawling.com", "clawling.chat"].some(
      (root) => url.hostname === root || url.hostname.endsWith(`.${root}`)
    );
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !acceptedHost
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeMimeType(value: string | null | undefined): string | undefined {
  const candidate = (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return candidate.includes("/") ? candidate : undefined;
}
interface ProcessedInboundImage {
  data: string;
  mimeType: string;
  hints: string[];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SUPPORTED_INLINE_IMAGE_MIME_TYPES: Readonly<Record<string, true>> = Object.freeze({
  "image/jpeg": true,
  "image/png": true,
  "image/gif": true,
  "image/webp": true
});

async function processInboundImage(bytes: Uint8Array): Promise<ProcessedInboundImage | null> {
  const detectedMime = detectSupportedImageMimeType(bytes);
  if (!detectedMime) return null;

  let normalizedBytes = bytes;
  let normalizedMime = detectedMime;
  let convertedFrom: string | undefined;
  if (SUPPORTED_INLINE_IMAGE_MIME_TYPES[detectedMime] !== true) {
    const sourceData = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64"
    );
    const converted = await convertToPng(sourceData, detectedMime);
    if (!converted) return null;
    normalizedBytes = Buffer.from(converted.data, "base64");
    normalizedMime = converted.mimeType;
    convertedFrom = detectedMime;
  }

  const resized = await resizeImage(normalizedBytes, normalizedMime);
  if (!resized) return null;

  const hints: string[] = [];
  if (convertedFrom !== undefined && convertedFrom !== resized.mimeType) {
    hints.push(`[Image converted from ${convertedFrom} to ${resized.mimeType}.]`);
  }
  const dimensionNote = formatDimensionNote(resized);
  if (dimensionNote) hints.push(dimensionNote);
  return { data: resized.data, mimeType: resized.mimeType, hints };
}

function detectSupportedImageMimeType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return bytes[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return isPng(bytes) && !isAnimatedPng(bytes) ? "image/png" : null;
  }
  if (startsWithAscii(bytes, 0, "GIF")) return "image/gif";
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(bytes, 0, "BM") && isBmp(bytes)) return "image/bmp";
  return null;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 16 &&
    readUint32BE(bytes, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(bytes, 12, "IHDR")
  );
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = readUint32BE(bytes, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(bytes, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(bytes, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > bytes.byteLength) return false;
    offset = nextOffset;
  }
  return false;
}

function isBmp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 26) return false;
  const declaredFileSize = readUint32LE(bytes, 2);
  const pixelDataOffset = readUint32LE(bytes, 10);
  const dibHeaderSize = readUint32LE(bytes, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(bytes, 22);
    bitsPerPixel = readUint16LE(bytes, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (bytes.byteLength < 30) return false;
    colorPlanes = readUint16LE(bytes, 26);
    bitsPerPixel = readUint16LE(bytes, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return (
    bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte)
  );
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.byteLength < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function imageMimeType(responseType: string | null, declaredType: string | undefined): string {
  const candidate = normalizeMimeType(responseType) ?? normalizeMimeType(declaredType);
  return candidate?.startsWith("image/") ? candidate : "application/octet-stream";
}

const MIME_FILENAME_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "application/pdf": ".pdf",
  "application/x-pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "application/zip": ".zip",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-wav": ".wav",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpeg",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/webm": ".webm"
});

const OFFICE_PACKAGE_MIME_TYPES: Readonly<Record<string, boolean>> = Object.freeze({
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
  "application/vnd.oasis.opendocument.text": true,
  "application/vnd.oasis.opendocument.spreadsheet": true,
  "application/vnd.oasis.opendocument.presentation": true
});

const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function safeFilename(
  name: string | undefined,
  number: number,
  kind: MediaFragment["kind"],
  declaredMime: string | undefined,
  detectedMime: string | undefined,
  effectiveMime: string
): string {
  const fallback = `${kind}-${number}${inferFilenameExtension(
    declaredMime,
    detectedMime,
    effectiveMime
  )}`;
  const leaf = name?.split(/[\\/]/).at(-1);
  const stripped = leaf
    ?.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[<>:"|?*'&]/g, "_")
    .trim()
    .normalize("NFC")
    .replace(/[. ]+$/u, "");
  const candidate =
    !stripped || stripped === "." || stripped === ".." ? fallback : stripped;
  const portable = WINDOWS_RESERVED_BASENAME.test(candidate)
    ? `_${candidate}`
    : candidate;
  const bounded = boundFilename(portable, MAX_FILENAME_BYTES);
  return !bounded || bounded === "." || bounded === ".." ? fallback : bounded;
}

function inferFilenameExtension(
  declaredMime: string | undefined,
  detectedMime: string | undefined,
  effectiveMime: string
): string {
  const declared = normalizeMimeType(declaredMime);
  const detected = normalizeMimeType(detectedMime);
  if (detected === "application/zip" && declared && OFFICE_PACKAGE_MIME_TYPES[declared]) {
    return MIME_FILENAME_EXTENSIONS[declared]!;
  }
  const detectedExtension = detected ? MIME_FILENAME_EXTENSIONS[detected] : undefined;
  if (detectedExtension) return detectedExtension;
  if (!detected || detected === "application/octet-stream") {
    const declaredExtension = declared ? MIME_FILENAME_EXTENSIONS[declared] : undefined;
    if (declaredExtension) return declaredExtension;
  }
  return MIME_FILENAME_EXTENSIONS[normalizeMimeType(effectiveMime) ?? ""] ?? "";
}

function allocateSafeFilename(
  name: string | undefined,
  number: number,
  kind: MediaFragment["kind"],
  declaredMime: string | undefined,
  detectedMime: string | undefined,
  effectiveMime: string,
  usedNames: Set<string>
): string {
  const preferred = safeFilename(
    name,
    number,
    kind,
    declaredMime,
    detectedMime,
    effectiveMime
  );
  let allocated = preferred;
  for (
    let collision = 2;
    usedNames.has(allocated.normalize("NFD").toLowerCase());
    collision += 1
  ) {
    allocated = appendFilenameSuffix(preferred, `-${collision}`);
  }
  usedNames.add(allocated.normalize("NFD").toLowerCase());
  return allocated;
}

function appendFilenameSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const stem = extension ? name.slice(0, dot) : name;
  const extensionBytes = UTF8_ENCODER.encode(extension).byteLength;
  const suffixBytes = UTF8_ENCODER.encode(suffix).byteLength;
  if (extensionBytes + suffixBytes < MAX_FILENAME_BYTES) {
    const boundedStem = truncateUtf8(
      stem,
      MAX_FILENAME_BYTES - extensionBytes - suffixBytes
    );
    return `${boundedStem}${suffix}${extension}`;
  }
  return `${truncateUtf8(stem, MAX_FILENAME_BYTES - suffixBytes)}${suffix}`;
}

function boundFilename(name: string, maxBytes: number): string {
  if (UTF8_ENCODER.encode(name).byteLength <= maxBytes) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const extension = name.slice(dot);
    const extensionBytes = UTF8_ENCODER.encode(extension).byteLength;
    if (extensionBytes < maxBytes) {
      return `${truncateUtf8(name.slice(0, dot), maxBytes - extensionBytes)}${extension}`;
    }
  }
  return truncateUtf8(name, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return UTF8_DECODER.decode(bytes.subarray(0, end));
}


function projectAttachment(attachment: DownloadedAttachment): string {
  const descriptor = describeAttachment(attachment);
  const content = decodeTextAttachment(attachment);
  return content === undefined
    ? descriptor
    : `${descriptor}\n<file name="${attachment.path}">\n${content}\n</file>`;
}

function decodeTextAttachment(attachment: DownloadedAttachment): string | undefined {
  if (attachment.kind !== "file" || !isTextCandidate(attachment)) return undefined;

  const bytes = attachment.bytes;
  if (hasKnownBinarySignature(bytes)) return undefined;
  try {
    let content: string;
    if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      content = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    } else if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      content = new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
    } else {
      if (looksLikeBomlessUtf16(bytes)) return undefined;
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    return isBinaryHeavy(content) ? undefined : content;
  } catch {
    return undefined;
  }
}

function isTextCandidate(attachment: DownloadedAttachment): boolean {
  const declaredMime = normalizeMimeType(attachment.declaredMime);
  const detectedMime = normalizeMimeType(attachment.detectedMime);
  const dot = attachment.safeName.lastIndexOf(".");
  const extension = dot > 0 ? attachment.safeName.slice(dot).toLowerCase() : "";
  return (
    isTextMimeType(declaredMime) ||
    isTextMimeType(detectedMime) ||
    TEXT_EXTENSIONS[extension] === true
  );
}

function isTextMimeType(mimeType: string | undefined): boolean {
  return (
    mimeType?.startsWith("text/") === true ||
    mimeType?.endsWith("+json") === true ||
    mimeType?.endsWith("+xml") === true ||
    mimeType?.endsWith("+yaml") === true ||
    (mimeType !== undefined && TEXT_MIME_TYPES[mimeType] === true)
  );
}



function hasKnownBinarySignature(bytes: Uint8Array): boolean {
  const isPdf =
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
  const isZip =
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08));
  return isPdf || isZip;
}

function looksLikeBomlessUtf16(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes.byteLength % 2 !== 0) return false;
  const pairs = bytes.byteLength / 2;
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < bytes.byteLength; index += 2) {
    if (bytes[index] === 0) evenNuls += 1;
    if (bytes[index + 1] === 0) oddNuls += 1;
  }
  return (
    (oddNuls * 2 >= pairs && evenNuls * 10 <= pairs) ||
    (evenNuls * 2 >= pairs && oddNuls * 10 <= pairs)
  );
}

function isBinaryHeavy(content: string): boolean {
  if (content.length === 0) return false;
  let nuls = 0;
  let controls = 0;
  for (let index = 0; index < content.length; index += 1) {
    const codePoint = content.charCodeAt(index);
    if (codePoint === 0) nuls += 1;
    else if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      codePoint === 0x7f
    ) {
      controls += 1;
    }
  }
  return nuls * 20 > content.length || (controls >= 2 && controls * 10 >= content.length);
}

const TEXT_MIME_TYPES: Record<string, true> = {
  "application/csv": true,
  "application/ecmascript": true,
  "application/graphql": true,
  "application/javascript": true,
  "application/json": true,
  "application/jsonlines": true,
  "application/markdown": true,
  "application/sql": true,
  "application/tab-separated-values": true,
  "application/toml": true,
  "application/tsv": true,
  "application/typescript": true,
  "application/vnd.ms-excel": true,
  "application/x-httpd-php": true,
  "application/x-httpd-php-source": true,
  "application/x-javascript": true,
  "application/x-latex": true,
  "application/x-markdown": true,
  "application/x-ndjson": true,
  "application/x-perl": true,
  "application/x-python": true,
  "application/x-ruby": true,
  "application/x-sh": true,
  "application/x-shellscript": true,
  "application/x-typescript": true,
  "application/x-tex": true,
  "application/x-yaml": true,
  "application/xml": true,
  "application/yaml": true
};

const TEXT_EXTENSIONS: Record<string, true> = {
  ".bash": true,
  ".bat": true,
  ".c": true,
  ".cc": true,
  ".cfg": true,
  ".cjs": true,
  ".clj": true,
  ".cljs": true,
  ".cljc": true,
  ".cmd": true,
  ".conf": true,
  ".cpp": true,
  ".cs": true,
  ".css": true,
  ".cts": true,
  ".csv": true,
  ".cxx": true,
  ".dart": true,
  ".edn": true,
  ".env": true,
  ".erl": true,
  ".ex": true,
  ".exs": true,
  ".fish": true,
  ".fs": true,
  ".fsx": true,
  ".go": true,
  ".gql": true,
  ".graphql": true,
  ".h": true,
  ".hpp": true,
  ".hrl": true,
  ".hs": true,
  ".htm": true,
  ".html": true,
  ".ini": true,
  ".java": true,
  ".js": true,
  ".json": true,
  ".jsonl": true,
  ".jsx": true,
  ".kt": true,
  ".kts": true,
  ".less": true,
  ".lhs": true,
  ".log": true,
  ".lua": true,
  ".md": true,
  ".markdown": true,
  ".mdown": true,
  ".mjs": true,
  ".mkd": true,
  ".ml": true,
  ".mli": true,
  ".mts": true,
  ".ndjson": true,
  ".php": true,
  ".pl": true,
  ".pm": true,
  ".properties": true,
  ".proto": true,
  ".ps1": true,
  ".py": true,
  ".pyi": true,
  ".r": true,
  ".rb": true,
  ".rs": true,
  ".sass": true,
  ".scala": true,
  ".scss": true,
  ".sh": true,
  ".sql": true,
  ".svelte": true,
  ".swift": true,
  ".tab": true,
  ".tex": true,
  ".text": true,
  ".toml": true,
  ".ts": true,
  ".tsv": true,
  ".tsx": true,
  ".txt": true,
  ".vb": true,
  ".vue": true,
  ".xhtml": true,
  ".xml": true,
  ".yaml": true,
  ".yml": true,
  ".zsh": true
};

function describeAttachment(attachment: DownloadedAttachment): string {
  const fields = [
    `kind=${attachment.kind}`,
    `name=${attachment.safeName}`,
    ...(attachment.declaredMime ? [`declared MIME=${attachment.declaredMime}`] : []),
    ...(attachment.detectedMime ? [`detected MIME=${attachment.detectedMime}`] : []),
    `bytes=${attachment.byteLength}`,
    `path=${attachment.path}`
  ];
  return `[Attachment ${attachment.number}: ${fields.join("; ")}]`;
}

function renderMaterializedPrompt(
  message: ClawchatInboundMessage,
  projections: string[]
): string {
  const header = renderInboundPromptHeader(message);
  return projections.length > 0 ? `${header}\n${projections.join("\n")}` : `${header}\n`;
}
