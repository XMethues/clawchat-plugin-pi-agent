import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  chunkedResponse,
  failingAfterChunks,
  leaseEntries,
  makeMaterializer,
  partiallyFailingResponse,
  pngResponse,
  SMALL_PNG,
  splitEvery,
  stalledResponse
} from "./helpers/inbound-media.js";
import type { ClawchatInboundMessage, MediaFragment } from "../src/types.js";

const SMALL_BMP = Uint8Array.from([
  0x42, 0x4d, 0x3a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00,
  0x28, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x13, 0x0b, 0x00, 0x00,
  0x13, 0x0b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0x00
]);
afterEach(async () => {
  await cleanupTempDirs();
});

describe("InboundMediaMaterializer download boundary", () => {
  it("rejects a redirect outside Clawling before requesting its target", async () => {
    const sourceUrl = "https://media.clawling.com/private/source";
    const redirectedUrl = "https://attacker.example/redirect-secret";
    const requested: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url === sourceUrl && init?.redirect === "manual") {
        return new Response(null, { status: 302, headers: { location: redirectedUrl } });
      }
      if (url === sourceUrl) requested.push(redirectedUrl); // Simulate fetch automatic redirect mode.
      return pngResponse();
    });
    const { materializer, rootDir } = await makeMaterializer(fetchFn);

    const result = await materializer.materialize(imageMessage("redirect", [image(sourceUrl)]));

    expect(requested).toEqual([sourceUrl]);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(result.images).toEqual([]);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    expect(result.prompt).not.toContain("attacker.example");
    expect(result.prompt).not.toContain("redirect-secret");
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("stops streaming without retry when the per-attachment byte budget is exceeded", async () => {
    const streamed = chunkedResponse([new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]);
    const retryDelay = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined);
    const fetchFn = vi.fn(async () => streamed.response);
    const { materializer, rootDir } = await makeMaterializer(fetchFn, {
      policy: { maxAttachmentBytes: 16, maxTurnBytes: 64 },
      delayFn: retryDelay
    });

    const result = await materializer.materialize(
      imageMessage("attachment-budget", [image("https://media.clawling.com/large", { size: 1 })])
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(retryDelay).not.toHaveBeenCalled();
    expect(streamed.pulls()).toBe(2);
    await streamed.cancelled;
    expect(result.images).toEqual([]);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("enforces the aggregate Turn budget against streamed bytes, not metadata", async () => {
    const second = chunkedResponse(splitEvery(SMALL_PNG, 8));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(pngResponse())
      .mockResolvedValueOnce(second.response);
    const { materializer, rootDir } = await makeMaterializer(fetchFn, {
      policy: {
        maxAttachmentBytes: SMALL_PNG.byteLength + 16,
        maxTurnBytes: SMALL_PNG.byteLength + 10
      }
    });

    const result = await materializer.materialize(
      imageMessage("turn-budget", [
        image("https://media.clawling.com/first", { size: 1 }),
        image("https://media.clawling.com/second", { size: 1 })
      ])
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(second.pulls()).toBe(2);
    await second.cancelled;
    expect(result.images).toHaveLength(1);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    expect(await leaseEntries(rootDir)).not.toEqual([]);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it.each([
    ["network error", () => Promise.reject(new TypeError("socket reset"))],
    ["HTTP 408", () => Promise.resolve(new Response(null, { status: 408 }))],
    ["HTTP 429", () => Promise.resolve(new Response(null, { status: 429 }))],
    ["HTTP 503", () => Promise.resolve(new Response(null, { status: 503 }))]
  ])("retries one transient %s and then succeeds", async (_label, firstAttempt) => {
    const retryDelay = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined);
    const fetchFn = vi.fn().mockImplementationOnce(firstAttempt).mockResolvedValueOnce(pngResponse());
    const { materializer, rootDir } = await makeMaterializer(fetchFn, { delayFn: retryDelay });

    const result = await materializer.materialize(
      imageMessage("retry", [image("https://media.clawling.com/retry")])
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(result.images).toHaveLength(1);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("retries once after a body fails after emitting bytes", async () => {
    const retryDelay = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(partiallyFailingResponse(SMALL_PNG.subarray(0, 8)))
      .mockResolvedValueOnce(pngResponse());
    const { materializer, rootDir } = await makeMaterializer(fetchFn, { delayFn: retryDelay });

    const result = await materializer.materialize(
      imageMessage("partial-body-retry", [image("https://media.clawling.com/partial")])
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(result.images).toHaveLength(1);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it.each(["maxAttachmentBytes", "maxTurnBytes"] as const)(
    "does not count bytes from a failed body against the retry's %s budget",
    async (budgetKey) => {
      const failedBytes = 8;
      const combinedBudget = failedBytes + SMALL_PNG.byteLength - 1;
      const retryDelay = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined);
      const second = chunkedResponse(splitEvery(SMALL_PNG, 8));
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(partiallyFailingResponse(SMALL_PNG.subarray(0, failedBytes)))
        .mockResolvedValueOnce(second.response);
      const { materializer, rootDir } = await makeMaterializer(fetchFn, {
        delayFn: retryDelay,
        policy: {
          maxAttachmentBytes:
            budgetKey === "maxAttachmentBytes" ? combinedBudget : combinedBudget + 100,
          maxTurnBytes: budgetKey === "maxTurnBytes" ? combinedBudget : combinedBudget + 100
        }
      });

      const result = await materializer.materialize(
        imageMessage(`partial-${budgetKey}`, [image("https://media.clawling.com/budgeted-retry")])
      );

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(retryDelay).toHaveBeenCalledOnce();
      expect(result.images).toHaveLength(1);
      expect(result.prompt).toContain("[Image 1]");
      await result.release();
      expect(await leaseEntries(rootDir)).toEqual([]);
    }
  );

  it("retries a late full-size partial transfer with a fresh attachment budget", async () => {
    const retryDelay = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined);
    const first = failingAfterChunks(splitEvery(SMALL_PNG, 8));
    const fetchFn = vi.fn().mockResolvedValueOnce(first.response).mockResolvedValueOnce(pngResponse());
    const { materializer, rootDir } = await makeMaterializer(fetchFn, {
      delayFn: retryDelay,
      policy: { maxAttachmentBytes: SMALL_PNG.byteLength + 8 }
    });

    const result = await materializer.materialize(
      imageMessage("late-partial-retry", [image("https://media.clawling.com/late-partial")])
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();
    expect(result.images).toHaveLength(1);
    expect(result.prompt).toContain("[Image 1]");
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("completes an unknown-length body streamed in multiple chunks", async () => {
    const streamed = chunkedResponse(splitEvery(SMALL_PNG, 7), { "content-type": "image/png" });
    const { materializer, rootDir } = await makeMaterializer(vi.fn(async () => streamed.response));

    const result = await materializer.materialize(
      imageMessage("unknown-length", [image("https://media.clawling.com/unknown-length")])
    );

    expect(streamed.pulls()).toBeGreaterThan(1);
    expect(result.images).toHaveLength(1);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("does not retry a terminal HTTP 4xx response", async () => {
    const retryDelay = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined);
    const secretUrl = "https://media.clawling.com/private-not-found";
    const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));
    const { materializer, rootDir } = await makeMaterializer(fetchFn, { delayFn: retryDelay });

    const result = await materializer.materialize(imageMessage("terminal-4xx", [image(secretUrl)]));

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(retryDelay).not.toHaveBeenCalled();
    expect(result.images).toEqual([]);
    expect(result.prompt).not.toContain(secretUrl);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("keeps a later successful image when an earlier image fails", async () => {
    const failedUrl = "https://media.clawling.com/private-failed";
    const successfulUrl = "https://media.clawling.com/private-success";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(pngResponse());
    const { materializer, rootDir } = await makeMaterializer(fetchFn);

    const result = await materializer.materialize(
      imageMessage("partial-success", [image(failedUrl), image(successfulUrl)])
    );

    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([failedUrl, successfulUrl]);
    expect(result.images).toHaveLength(1);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    expect(result.prompt).not.toContain(failedUrl);
    expect(result.prompt).not.toContain(successfulUrl);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });
  it.each([
    ["missing", undefined, undefined],
    ["misleading", "image/jpeg", "image/gif"]
  ])(
    "normalizes real PNG bytes when %s MIME metadata is present",
    async (_label, responseMime, declaredMime) => {
      const url = "https://media.clawling.com/private-mislabeled-png";
      const fetchFn = vi.fn(
        async () =>
          new Response(
            SMALL_PNG,
            responseMime ? { headers: { "content-type": responseMime } } : undefined
          )
      );
      const { materializer, rootDir } = await makeMaterializer(fetchFn);

      const fragment = declaredMime ? image(url, { mime: declaredMime }) : image(url);
      const result = await materializer.materialize(
        imageMessage("normalized-png", [fragment])
      );

      expect(result.images).toEqual([
        {
          type: "image",
          data: Buffer.from(SMALL_PNG).toString("base64"),
          mimeType: "image/png"
        }
      ]);
      expect(result.prompt).toContain("[Image 1]");
      expect(result.prompt).not.toContain("unavailable");
      expect(result.prompt).not.toContain(url);
      await result.release();
      expect(await leaseEntries(rootDir)).toEqual([]);
    }
  );

  it("converts a real BMP to supported PNG input with Pi's conversion hint", async () => {
    const url = "https://media.clawling.com/private-bitmap";
    const fetchFn = vi.fn(
      async () => new Response(SMALL_BMP, { headers: { "content-type": "image/bmp" } })
    );
    const { materializer, rootDir } = await makeMaterializer(fetchFn);

    const result = await materializer.materialize(
      imageMessage("converted-bmp", [image(url, { name: "pixel.bmp", mime: "image/bmp" })])
    );

    expect(result.images).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png" })
    ]);
    expect(Buffer.from(result.images[0]!.data, "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(result.prompt).toContain("[Image converted from image/bmp to image/png.]");
    expect(result.prompt).not.toContain("unavailable");
    expect(result.prompt).not.toContain(url);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("keeps invalid image bytes a bounded URL-free image failure", async () => {
    const url = `https://media.clawling.com/private-invalid-${"x".repeat(4_096)}`;
    const fetchFn = vi.fn(async () => new Response(Uint8Array.from([0x42, 0x4d])));
    const { materializer, rootDir } = await makeMaterializer(fetchFn);

    const result = await materializer.materialize(
      imageMessage("invalid-image", [image(url)])
    );

    expect(result.images).toEqual([]);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    expect(result.prompt.length).toBeLessThan(512);
    expect(result.prompt).not.toContain(url);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it("returns a bounded URL-free prompt when all media-only images fail", async () => {
    const secret = "secret-" + "x".repeat(4_096);
    const urls = [
      `https://media.clawling.com/${secret}`,
      `https://cdn.clawling.chat/${secret}`
    ];
    const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));
    const { materializer, rootDir } = await makeMaterializer(fetchFn);

    const result = await materializer.materialize(
      imageMessage("all-failed", urls.map((url) => image(url)))
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.images).toEqual([]);
    expect(result.prompt).toMatch(/^ClawChat direct message from Alice:/);
    expect(result.prompt.length).toBeLessThan(512);
    expect(result.prompt).not.toContain("clawling.com");
    expect(result.prompt).not.toContain("clawling.chat");
    expect(result.prompt).not.toContain(secret);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  });

  it.each([
    ["connection", "connectionTimeoutMs", 11, false],
    ["no-progress", "noProgressTimeoutMs", 12, true]
  ] as const)(
    "retries once after a per-attempt %s timeout when attachment and Turn budgets remain",
    async (_scope, policyKey, milliseconds, bodyStall) => {
      const delays = new ManualDelays();
      const stalled = bodyStall ? stalledResponse() : undefined;
      let firstRequestSignal: AbortSignal | undefined;
      const fetchFn = vi
        .fn()
        .mockImplementationOnce(
          async (_input: string | URL | Request, init?: RequestInit) => {
            firstRequestSignal = init?.signal ?? undefined;
            return stalled?.response ?? (await rejectWhenAborted(firstRequestSignal));
          }
        )
        .mockResolvedValueOnce(pngResponse());
      const { materializer, rootDir } = await makeMaterializer(fetchFn, {
        policy: timeoutPolicy({ [policyKey]: milliseconds }),
        delayFn: delays.delay
      });
      const pending = materializer.materialize(
        imageMessage(`retry-${_scope}-timeout`, [
          image("https://media.clawling.com/stalled")
        ])
      );

      if (stalled) await stalled.started;
      await delays.expire(milliseconds);
      await delays.expire(250);
      const result = await pending;

      expect(firstRequestSignal?.aborted).toBe(true);
      if (stalled) await expect(stalled.cancelled).resolves.toBeDefined();
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result.images).toHaveLength(1);
      expect(result.prompt).toContain("[Image 1]");
      await result.release();
      expect(await leaseEntries(rootDir)).toEqual([]);
    },
    1_000
  );

  it("keeps the attachment deadline terminal instead of retrying the attempt", async () => {
    const delays = new ManualDelays();
    const stalled = stalledResponse();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return stalled.response;
    });
    const { materializer, rootDir } = await makeMaterializer(fetchFn, {
      policy: timeoutPolicy({ attachmentTimeoutMs: 13 }),
      delayFn: delays.delay
    });
    const pending = materializer.materialize(
      imageMessage("attachment-timeout", [
        image("https://media.clawling.com/stalled")
      ])
    );

    await stalled.started;
    await delays.expire(13);
    const result = await pending;

    expect(requestSignal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result.images).toEqual([]);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  }, 1_000);

  it("stops a timed-out Turn before starting later media requests", async () => {
    const delays = new ManualDelays();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return await rejectWhenAborted(requestSignal);
    });
    const { materializer, rootDir } = await makeMaterializer(fetchFn, {
      policy: timeoutPolicy({ turnTimeoutMs: 14 }),
      delayFn: delays.delay
    });
    const pending = materializer.materialize(
      imageMessage("turn-timeout", [
        image("https://media.clawling.com/first-stalled"),
        image("https://media.clawling.com/must-not-start")
      ])
    );

    await delays.expire(14);
    const result = await pending;

    expect(requestSignal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result.images).toEqual([]);
    expect(result.prompt).toMatch(/\[Image \d+ unavailable:/);
    await result.release();
    expect(await leaseEntries(rootDir)).toEqual([]);
  }, 1_000);

  it("caller cancellation aborts the body and releases an existing partial lease", async () => {
    const stalled = stalledResponse();
    const fetchFn = vi.fn().mockResolvedValueOnce(pngResponse()).mockResolvedValueOnce(stalled.response);
    const { materializer, rootDir } = await makeMaterializer(fetchFn);
    const controller = new AbortController();
    const pending = materializer.materialize(
      imageMessage("caller-abort", [
        image("https://media.clawling.com/leased-first"),
        image("https://media.clawling.com/stalled-second")
      ]),
      controller.signal
    );

    await stalled.started;
    expect(await leaseEntries(rootDir)).not.toEqual([]);
    controller.abort(new Error("caller stopped"));
    const failure = await pending.then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/abort|caller stopped/i);
    expect(String(failure)).not.toContain("clawling.com");
    await expect(stalled.cancelled).resolves.toBeDefined();
    expect(await leaseEntries(rootDir)).toEqual([]);
  }, 1_000);
});

type ImageFragment = MediaFragment & { kind: "image" };
type DelayFn = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
interface TimeoutPolicy {
  connectionTimeoutMs: number;
  noProgressTimeoutMs: number;
  attachmentTimeoutMs: number;
  turnTimeoutMs: number;
}

function image(url: string, overrides: Partial<ImageFragment> = {}): ImageFragment {
  return { kind: "image", url, name: "pixel.png", mime: "image/png", ...overrides };
}

function imageMessage(id: string, fragments: ImageFragment[]): ClawchatInboundMessage {
  return {
    version: "2",
    event: "message.send",
    trace_id: `trace-${id}`,
    emitted_at: 1,
    chat_id: "chat-1",
    chat_type: "direct",
    sender: { id: "user-1", type: "direct", nick_name: "Alice" },
    payload: {
      message_id: `message-${id}`,
      message: { body: { fragments } }
    }
  };
}

function timeoutPolicy(overrides: Partial<TimeoutPolicy>): TimeoutPolicy {
  return {
    connectionTimeoutMs: 101,
    noProgressTimeoutMs: 102,
    attachmentTimeoutMs: 103,
    turnTimeoutMs: 104,
    ...overrides
  };
}

function rejectWhenAborted(signal: AbortSignal | undefined): Promise<Response> {
  if (!signal) return Promise.reject(new Error("fetch did not receive an AbortSignal"));
  return new Promise<Response>((_resolve, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

class ManualDelays {
  private readonly pending: Array<{
    milliseconds: number;
    resolve: () => void;
    signal?: AbortSignal;
    abort: () => void;
  }> = [];

  readonly delay: DelayFn = async (milliseconds, signal) => {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) return abort();
      this.pending.push({ milliseconds, resolve, abort, ...(signal ? { signal } : {}) });
      signal?.addEventListener("abort", abort, { once: true });
    });
  };

  async expire(milliseconds: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const index = this.pending.findIndex(
        (entry) => entry.milliseconds === milliseconds && !entry.signal?.aborted
      );
      if (index >= 0) {
        const [entry] = this.pending.splice(index, 1);
        entry!.signal?.removeEventListener("abort", entry!.abort);
        entry!.resolve();
        await Promise.resolve();
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`No delay was scheduled for ${milliseconds} ms`);
  }
}
