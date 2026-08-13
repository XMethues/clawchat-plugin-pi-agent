import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboundMediaMaterializer } from "../src/inbound-media.js";
import type { ClawchatFragment, ClawchatInboundMessage } from "../src/types.js";

const RED_PNG = pixelPng(255, 0, 0);
const BLUE_PNG = pixelPng(0, 0, 255);
const DOCUMENT = "first document line\nsecond document line\nEND-DOCUMENT";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ordered mixed inbound media", () => {
  it("projects interleaved text, numbered media, and a failure in order while appending successful images in numbered order", async () => {
    const rootDir = join(await tempDir(), "private-media");
    const urls = {
      red: "https://media.clawling.com/private/red",
      document: "https://media.clawling.com/private/document",
      generic: "https://media.clawling.com/private/generic",
      blue: "https://media.clawling.com/private/blue"
    };
    const fixtures = new Map([
      [urls.red, { bytes: RED_PNG, mime: "image/png" }],
      [urls.document, { bytes: utf8(DOCUMENT), mime: "text/plain" }],
      [urls.generic, { bytes: Uint8Array.from([0, 0xff, 1, 0xfe]), mime: "application/octet-stream" }],
      [urls.blue, { bytes: BLUE_PNG, mime: "image/png" }]
    ]);
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const fixture = fixtures.get(String(input));
      return fixture
        ? new Response(fixture.bytes, { headers: { "content-type": fixture.mime } })
        : new Response(null, { status: 404 });
    });
    const materializer = new InboundMediaMaterializer({ rootDir, fetchFn: fetchFn as typeof fetch });
    const result = await materializer.materialize(
      message("mixed", [
        { kind: "text", text: "TEXT-1\n" },
        { kind: "image", url: urls.red, name: "red.png", mime: "image/png" },
        { kind: "text", text: "TEXT-3\n" },
        { kind: "file", url: urls.document, name: "notes.txt", mime: "text/plain" },
        { kind: "file", url: urls.generic, name: "archive.bin", mime: "application/octet-stream" },
        { kind: "file", url: "https://untrusted.example/failure", name: "failed.bin" },
        { kind: "text", text: "TEXT-7\n" },
        { kind: "image", url: urls.blue, name: "blue.png", mime: "image/png" },
        { kind: "text", text: "TEXT-9" }
      ])
    );

    try {
      expect(fetchFn.mock.calls.map(([input]) => String(input))).toEqual([
        urls.red,
        urls.document,
        urls.generic,
        urls.blue
      ]);
      expect(result.images.map(({ data }) => data)).toEqual([
        Buffer.from(RED_PNG).toString("base64"),
        Buffer.from(BLUE_PNG).toString("base64")
      ]);
      const document = attachment(result.prompt, 4);
      const generic = attachment(result.prompt, 5);
      expectInOrder(result.prompt, [
        "TEXT-1",
        "[Image 2]",
        "TEXT-3",
        document.line,
        `<file name="${document.path}">\n${DOCUMENT}\n</file>`,
        generic.line,
        "[Attachment 6 unavailable: invalid source]",
        "TEXT-7",
        "[Image 8]",
        "TEXT-9"
      ]);
      expect(document.name).toBe("notes.txt");
      expect(generic.name).toBe("archive.bin");
      expect(await readFile(document.path)).toEqual(Buffer.from(DOCUMENT));
      expect(await readFile(generic.path)).toEqual(Buffer.from([0, 0xff, 1, 0xfe]));
      expect(result.prompt).not.toMatch(/clawling\.com|untrusted\.example/);
    } finally {
      await result.release();
    }
  });

  it("concatenates adjacent text fragments without inserting a separator around ordered media", async () => {
    const rootDir = join(await tempDir(), "private-media");
    const materializer = new InboundMediaMaterializer({
      rootDir,
      fetchFn: vi.fn(async () => new Response(RED_PNG, { headers: { "content-type": "image/png" } }))
    });
    const result = await materializer.materialize(
      message("adjacent-text", [
        { kind: "text", text: "hel" },
        { kind: "text", text: "lo" },
        {
          kind: "image",
          url: "https://media.clawling.com/private/red",
          name: "red.png",
          mime: "image/png"
        },
        { kind: "text", text: "!" }
      ])
    );

    try {
      expect(result.prompt).toBe(
        ["ClawChat direct message from Alice:", "hello", "[Image 3]", "!"].join("\n")
      );
      expect(result.images).toHaveLength(1);
    } finally {
      await result.release();
    }
  });
});

describe("invalid media sources", () => {
  it("materializes an all-invalid media-only direct Turn as numbered failures without fetching", async () => {
    const rootDir = join(await tempDir(), "private-media");
    const fetchFn = vi.fn();
    const materializer = new InboundMediaMaterializer({
      rootDir,
      fetchFn: fetchFn as typeof fetch
    });

    const result = await materializer.materialize(
      message("invalid-sources", [
        { kind: "image", url: "", name: "missing.png", mime: "image/png" },
        { kind: "file", url: " \t ", name: "missing.pdf", mime: "application/pdf" }
      ])
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.images).toEqual([]);
    expect(result.prompt).toBe(
      [
        "ClawChat direct message from Alice:",
        "[Image 1 unavailable: invalid source]",
        "[Attachment 2 unavailable: invalid source]"
      ].join("\n")
    );
    expect(await readdir(rootDir).catch(() => [])).toEqual([]);
    await result.release();
  });
});

describe("mixed-media private filenames", () => {
  it("preserves normal Unicode and deterministically bounds and isolates duplicate and hostile names", async () => {
    const parent = await tempDir();
    const rootDir = join(parent, "private-media");
    const names = [
      "résumé-東京.bin",
      "résumé-東京.bin",
      "nested/collide.bin",
      "nested\\collide.bin",
      "../collide.bin",
      "/var/tmp/absolute.bin",
      "C:\\temp\\drive.bin",
      "nul\0-c0\u0001-c1\u0085-bidi\u061c\u200e\u200f\u202e\u2066evil.bin",
      `${"界".repeat(100)}.bin`
    ];
    const fixtures = names.map((name, index) => ({
      name,
      url: `https://media.clawling.com/private/name-${index}`,
      bytes: Uint8Array.from([0, index + 1, 0xff])
    }));
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const fixture = fixtures.find(({ url }) => url === String(input))!;
      return new Response(fixture.bytes, { headers: { "content-type": "application/octet-stream" } });
    });
    const materializer = new InboundMediaMaterializer({ rootDir, fetchFn: fetchFn as typeof fetch });
    const inbound = message(
      "names",
      fixtures.map(({ name, url }) => ({ kind: "file", name, url, mime: "application/octet-stream" }))
    );
    const first = await materializer.materialize(inbound);
    const second = await materializer.materialize(inbound);

    try {
      const firstFiles = fixtures.map((_, index) => attachment(first.prompt, index + 1));
      const secondFiles = fixtures.map((_, index) => attachment(second.prompt, index + 1));
      const basenames = firstFiles.map(({ path }) => basename(path));
      expect(firstFiles[0]!.name).toBe("résumé-東京.bin");
      expect(firstFiles[1]!.name).toBe("résumé-東京-2.bin");
      expect(firstFiles[8]!.name).toContain("界");
      expect(new Set(basenames).size).toBe(basenames.length);
      expect(secondFiles.map(({ path }) => basename(path))).toEqual(basenames);

      for (const [index, file] of firstFiles.entries()) {
        expect(Buffer.byteLength(file.name, "utf8")).toBeLessThanOrEqual(120);
        expect(file.name).not.toMatch(/[\\/\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
        expect(file.name === "." || file.name === "..").toBe(false);
        const lease = await realpath(dirname(file.path));
        const local = relative(lease, await realpath(file.path));
        expect(local).not.toBe("");
        expect(local.startsWith("..") || isAbsolute(local)).toBe(false);
        expect((await stat(file.path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
        expect(await readFile(file.path)).toEqual(Buffer.from(fixtures[index]!.bytes));
      }
      expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
      expect(await readdir(parent)).toEqual(["private-media"]);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("makes Windows-forbidden, trailing, and reserved device names portable", async () => {
    const rootDir = join(await tempDir(), "private-media");
    const names = [
      `quote<colon>:"name.txt`,
      "nested/slash.txt",
      "nested\\backslash.txt",
      "pipe|question?star*.txt",
      "trailing-dots...   ",
      "trailing-space.txt   ",
      "CON",
      "nul.txt",
      "Lpt9.log"
    ];
    const materializer = new InboundMediaMaterializer({
      rootDir,
      fetchFn: vi.fn(async () =>
        new Response(Uint8Array.from([0, 1, 0xff]), {
          headers: { "content-type": "application/octet-stream" }
        })
      ) as typeof fetch
    });
    const result = await materializer.materialize(
      message(
        "portable-names",
        names.map((name, index) => ({
          kind: "file",
          url: `https://media.clawling.com/private/portable-${index}`,
          name,
          mime: "application/octet-stream"
        }))
      )
    );

    try {
      const safeNames = names.map((_, index) => attachment(result.prompt, index + 1).name);
      expect(safeNames).toEqual([
        "quote_colon___name.txt",
        "slash.txt",
        "backslash.txt",
        "pipe_question_star_.txt",
        "trailing-dots",
        "trailing-space.txt",
        "_CON",
        "_nul.txt",
        "_Lpt9.log"
      ]);
      for (const safeName of safeNames) {
        expect(safeName).not.toMatch(/[<>:"/\\|?*]/u);
        expect(safeName).not.toMatch(/[. ]$/u);
        expect(safeName).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
        expect(Buffer.byteLength(safeName, "utf8")).toBeLessThanOrEqual(120);
      }
    } finally {
      await result.release();
    }
  });

  it("replaces file-block attribute delimiters while keeping the private text path readable", async () => {
    const rootDir = join(await tempDir(), "private-media");
    const content = "safe local text";
    const materializer = new InboundMediaMaterializer({
      rootDir,
      fetchFn: vi.fn(async () =>
        new Response(content, { headers: { "content-type": "text/plain" } })
      ) as typeof fetch
    });
    const result = await materializer.materialize(
      message("file-delimiters", [
        {
          kind: "file",
          url: "https://media.clawling.com/private/text",
          name: `quarterly"<&>.txt`,
          mime: "text/plain"
        }
      ])
    );

    try {
      expect(result.prompt.match(/<file name="/g)).toHaveLength(1);
      expect(result.prompt.match(/<\/file>/g)).toHaveLength(1);
      expect(result.prompt).not.toMatch(/&(?:amp|quot|lt|gt);/);
      const block = result.prompt.match(/<file name="([^"]+)">\n([\s\S]*?)\n<\/file>/);
      expect(block).not.toBeNull();
      const path = block![1]!;
      expect(basename(path)).not.toMatch(/["'&<>]/);
      expect(block![2]).toBe(content);
      expect(await readFile(path, "utf8")).toBe(content);
    } finally {
      await result.release();
    }
  });

});

describe("materialized mixed-media replies", () => {
  it("accepts message.reply through the same path without changing author-final identifiers", async () => {
    const rootDir = join(await tempDir(), "private-media");
    const url = "https://media.clawling.com/private/reply-file";
    const materializer = new InboundMediaMaterializer({
      rootDir,
      fetchFn: vi.fn(async () =>
        new Response(Uint8Array.from([0, 1, 0xff]), {
          headers: { "content-type": "application/octet-stream" }
        })
      ) as typeof fetch
    });
    const reply = message(
      "author-final",
      [
        { kind: "text", text: "REPLY-BEFORE\n" },
        { kind: "file", url, name: "reply.bin", mime: "application/octet-stream" },
        { kind: "text", text: "\nREPLY-AFTER" }
      ],
      "message.reply"
    );
    reply.trace_id = "trace-author-final";
    reply.payload.message_id = "message-author-final";
    reply.payload.message.context = { reply_to_msg_id: "message-original" };
    const authorFinal = reply as ClawchatInboundMessage & {
      payload: ClawchatInboundMessage["payload"] & { stream_merged: boolean };
    };
    authorFinal.payload.stream_merged = false;
    const original = structuredClone(authorFinal);

    const result = await materializer.materialize(authorFinal);
    try {
      const file = attachment(result.prompt, 2);
      expectInOrder(result.prompt, ["REPLY-BEFORE", file.line, "REPLY-AFTER"]);
      expect(result.images).toEqual([]);
      expect(result.prompt).not.toContain(url);
      expect(authorFinal).toEqual(original);
      expect({
        event: authorFinal.event,
        traceId: authorFinal.trace_id,
        messageId: authorFinal.payload.message_id,
        streamMerged: authorFinal.payload.stream_merged,
        replyTo: authorFinal.payload.message.context?.reply_to_msg_id
      }).toEqual({
        event: "message.reply",
        traceId: "trace-author-final",
        messageId: "message-author-final",
        streamMerged: false,
        replyTo: "message-original"
      });
    } finally {
      await result.release();
    }
  });
});

function message(
  id: string,
  fragments: ClawchatFragment[],
  event: "message.send" | "message.reply" = "message.send"
): ClawchatInboundMessage {
  return {
    version: "2",
    event,
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

function attachment(prompt: string, number: number): { line: string; name: string; path: string } {
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(`[Attachment ${number}:`));
  expect(line, `attachment ${number}`).toBeDefined();
  const name = line!.match(/; name=([^;]+);/)?.[1];
  const path = line!.match(/; path=([^\]]+)\]$/)?.[1];
  expect(name, `attachment ${number} name`).toBeDefined();
  expect(path, `attachment ${number} path`).toBeDefined();
  return { line: line!, name: name!, path: path! };
}

function expectInOrder(prompt: string, projections: string[]): void {
  let cursor = -1;
  for (const projection of projections) {
    const next = prompt.indexOf(projection, cursor + 1);
    expect(next, `ordered projection ${JSON.stringify(projection)}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clawchat-inbound-mixed-media-"));
  tempDirs.push(path);
  return path;
}

function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function pixelPng(red: number, green: number, blue: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))),
      pngChunk("IEND", Buffer.alloc(0))
    ])
  );
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const kind = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
