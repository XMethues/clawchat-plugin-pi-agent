import {
  mkdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  leaseEntries,
  makeTempDir,
  minimalTestTools
} from "./helpers/inbound-media.js";
import { GatewayStore } from "../src/gateway-store.js";
import { InboundMediaMaterializer } from "../src/inbound-media.js";
import { PiChatSessionFactory } from "../src/pi-session-factory.js";
import type { ClawchatInboundMessage, MediaFragment } from "../src/types.js";

interface GenericFixture {
  label: string;
  kind: "file" | "audio" | "video";
  url: string;
  name: string;
  declaredMime?: string;
  detectedMime: string;
  bytes: Uint8Array;
}

const GENERIC_ATTACHMENTS: readonly GenericFixture[] = [
  {
    label: "PDF",
    kind: "file",
    url: "https://media.clawling.com/private/quarterly-pdf",
    name: "quarterly-report.pdf",
    declaredMime: "application/x-pdf",
    detectedMime: "application/pdf",
    bytes: Uint8Array.from(Buffer.from("%PDF-1.7\nfixture"))
  },
  {
    label: "Office document",
    kind: "file",
    url: "https://media.clawling.com/private/office-document",
    name: "forecast.docx",
    declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    detectedMime: "application/zip",
    bytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])
  },
  {
    label: "audio",
    kind: "audio",
    url: "https://media.clawling.com/private/voice-note",
    name: "voice-note.mp3",
    declaredMime: "audio/mpeg",
    detectedMime: "audio/mpeg",
    bytes: Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00])
  },
  {
    label: "video",
    kind: "video",
    url: "https://media.clawling.com/private/demo-video",
    name: "demo.mp4",
    declaredMime: "video/mp4",
    detectedMime: "video/mp4",
    bytes: Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
  },
  {
    label: "arbitrary binary",
    kind: "file",
    url: "https://media.clawling.com/private/opaque-binary",
    name: "payload.bin",
    detectedMime: "application/octet-stream",
    bytes: Uint8Array.from([0x00, 0xff, 0x01, 0xfe, 0x02, 0xfd])
  }
];

afterEach(async () => {
  await cleanupTempDirs();
});

describe("generic inbound media materialization", () => {
  it("hands PDF, Office, audio, video, and arbitrary binary fragments to Pi as numbered private files", async () => {
    const profileDir = await makeTempDir("clawchat-generic-media-");
    const workspace = join(profileDir, "workspace");
    const mediaRoot = join(profileDir, "private-media");
    await mkdir(workspace);
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const fixture = GENERIC_ATTACHMENTS.find(({ url }) => url === String(input));
      if (!fixture) return new Response(null, { status: 404 });
      return new Response(fixture.bytes, {
        headers: { "content-type": fixture.detectedMime }
      });
    });
    const maxAttachmentBytes = Math.max(...GENERIC_ATTACHMENTS.map(({ bytes }) => bytes.byteLength));
    const maxTurnBytes = GENERIC_ATTACHMENTS.reduce((sum, { bytes }) => sum + bytes.byteLength, 0);
    const materializer = new InboundMediaMaterializer({
      rootDir: mediaRoot,
      fetchFn: fetchFn as typeof fetch,
      policy: { maxAttachmentBytes, maxTurnBytes }
    });
    const result = await materializer.materialize(
      genericMessage(
        "all-generic",
        GENERIC_ATTACHMENTS.map(({ kind, url, name, declaredMime }) => ({
          kind,
          url,
          name,
          size: 1,
          ...(declaredMime ? { mime: declaredMime } : {})
        }))
      )
    );
    const localPaths: string[] = [];

    try {
      expect(fetchFn.mock.calls.map(([input]) => String(input))).toEqual(
        GENERIC_ATTACHMENTS.map(({ url }) => url)
      );
      expect(result.images).toEqual([]);
      expect(result.prompt).toMatch(/^ClawChat direct message from Alice:\n/);
      expect(result.prompt).not.toContain("clawling.com");

      for (const [index, fixture] of GENERIC_ATTACHMENTS.entries()) {
        const number = index + 1;
        const line = requireAttachmentLine(result.prompt, number);
        const localPath = requireDescriptorPath(line);
        localPaths.push(localPath);

        expect(line).toBe(
          renderExpectedDescriptor({ number, fixture, localPath })
        );
        expect(isAbsolute(localPath)).toBe(true);
        expect(isWithin(mediaRoot, localPath)).toBe(true);
        expect(isWithin(workspace, localPath)).toBe(false);
        expect(await readFile(localPath)).toEqual(Buffer.from(fixture.bytes));
        expect((await stat(localPath)).mode & 0o077).toBe(0);
      }
    } finally {
      await result.release();
    }

    for (const localPath of localPaths) {
      await expect(readFile(localPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await leaseEntries(mediaRoot)).toEqual([]);
  });

  it("infers stable safe extensions for unnamed known package MIME types", async () => {
    const profileDir = await makeTempDir("clawchat-generic-media-");
    const mediaRoot = join(profileDir, "private-media");
    const fixtures = [
      {
        kind: "file" as const,
        url: "https://media.clawling.com/private/unnamed-pdf",
        declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        detectedMime: "application/pdf",
        extension: ".pdf"
      },
      {
        kind: "file" as const,
        url: "https://media.clawling.com/private/unnamed-office",
        declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        detectedMime: "application/zip",
        extension: ".docx"
      },
      {
        kind: "audio" as const,
        url: "https://media.clawling.com/private/unnamed-audio",
        declaredMime: "audio/mpeg",
        detectedMime: "application/octet-stream",
        extension: ".mp3"
      },
      {
        kind: "video" as const,
        url: "https://media.clawling.com/private/unnamed-video",
        detectedMime: "video/mp4",
        extension: ".mp4"
      }
    ];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const fixture = fixtures.find(({ url }) => url === String(input))!;
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": fixture.detectedMime }
      });
    });
    const materializer = new InboundMediaMaterializer({
      rootDir: mediaRoot,
      fetchFn: fetchFn as typeof fetch
    });
    const result = await materializer.materialize(
      genericMessage(
        "unnamed-known-types",
        fixtures.map(({ kind, url, declaredMime }) => ({
          kind,
          url,
          ...(declaredMime ? { mime: declaredMime } : {})
        }))
      )
    );

    try {
      for (const [index, fixture] of fixtures.entries()) {
        const path = requireDescriptorPath(requireAttachmentLine(result.prompt, index + 1));
        expect(basename(path)).toBe(`${fixture.kind}-${index + 1}${fixture.extension}`);
        expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
      }
    } finally {
      await result.release();
    }
  });

  it("applies the bounded downloader to a generic attachment instead of publishing an oversized file", async () => {
    const profileDir = await makeTempDir("clawchat-generic-media-");
    const mediaRoot = join(profileDir, "private-media");
    const mediaUrl = "https://media.clawling.com/private/oversized-pdf";
    const fetchFn = vi.fn(async () =>
      new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
        headers: { "content-type": "application/pdf" }
      })
    );
    const materializer = new InboundMediaMaterializer({
      rootDir: mediaRoot,
      fetchFn: fetchFn as typeof fetch,
      policy: { maxAttachmentBytes: 4, maxTurnBytes: 16 }
    });

    const result = await materializer.materialize(
      genericMessage("bounded-generic", [
        {
          kind: "file",
          url: mediaUrl,
          name: "oversized.pdf",
          mime: "application/pdf",
          size: 1
        }
      ])
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result.images).toEqual([]);
    expect(result.prompt).toContain("[Attachment 1 unavailable:");
    expect(result.prompt).not.toContain(mediaUrl);
    expect(await leaseEntries(mediaRoot)).toEqual([]);
    await result.release();
  });
});

describe("PiChatSessionFactory generic attachment handoff", () => {
  it("loads a configured Pi Package tool that consumes the leased generic path during the Turn", async () => {
    const profileDir = await makeTempDir("clawchat-generic-media-");
    const workspace = join(profileDir, "workspace");
    const mediaRoot = join(profileDir, "private-media");
    const packageSource = "./packages/attachment-reader";
    const packageDir = join(profileDir, "packages", "attachment-reader");
    const extensionPath = join(packageDir, "extension.js");
    await mkdir(workspace);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(profileDir, "settings.json"),
      JSON.stringify({ packages: [packageSource] })
    );
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "synthetic-attachment-reader",
        private: true,
        type: "module",
        pi: { extensions: ["./extension.js"] }
      })
    );
    await writeFile(
      extensionPath,
      [
        'import { readFile, stat } from "node:fs/promises";',
        "",
        "export default function register(pi) {",
        "  pi.registerTool({",
        '    name: "read_leased_attachment",',
        '    label: "Read leased attachment",',
        '    description: "Read the local attachment path from the current Turn.",',
        "    parameters: {",
        '      type: "object",',
        '      properties: { path: { type: "string" } },',
        '      required: ["path"],',
        "      additionalProperties: false",
        "    },",
        "    async execute(_toolCallId, { path }) {",
        "      const file = await stat(path);",
        "      const bytes = await readFile(path);",
        "      const details = {",
        "        existsDuringExecution: file.isFile(),",
        '        bytesBase64: bytes.toString("base64")',
        "      };",
        '      return { content: [{ type: "text", text: JSON.stringify(details) }], details };',
        "    }",
        "  });",
        "}",
        ""
      ].join("\n")
    );

    const store = GatewayStore.open(join(profileDir, "gateway.sqlite"));
    const mediaUrl = "https://media.clawling.com/private/package-readable-pdf";
    const sourceBytes = Uint8Array.from(Buffer.from("%PDF-1.7\npackage-readable"));
    const expectedDetails = {
      existsDuringExecution: true,
      bytesBase64: Buffer.from(sourceBytes).toString("base64")
    };
    const fetchFn = vi.fn(async () =>
      new Response(sourceBytes, { headers: { "content-type": "application/pdf" } })
    );
    const promptStarted = Promise.withResolvers<void>();
    const promptSettled = Promise.withResolvers<void>();
    let executeAttachmentReader: ((path: string) => Promise<unknown>) | undefined;
    let toolExecutionResult: unknown;
    let promptedPath: string | undefined;
    const prompt = vi.fn(async (text: string) => {
      expect(executeAttachmentReader).toBeDefined();
      expect(text).not.toContain(mediaUrl);
      const line = requireAttachmentLine(text, 1);
      promptedPath = requireDescriptorPath(line);
      toolExecutionResult = await executeAttachmentReader!(promptedPath);
      promptStarted.resolve();
      await promptSettled.promise;
    });
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir: profileDir,
      sessionDir: join(profileDir, "sessions"),
      media: { rootDir: mediaRoot, fetchFn: fetchFn as typeof fetch },
      tools: minimalTestTools,
      createAgentSessionFn: async ({ agentDir, resourceLoader }) => {
        expect(agentDir).toBe(profileDir);
        expect(resourceLoader).toBeInstanceOf(DefaultResourceLoader);
        expect(resourceLoader).toBeDefined();
        const loaded = resourceLoader!.getExtensions();
        expect(loaded.errors).toEqual([]);
        const packageExtension = loaded.extensions.find(
          ({ sourceInfo }) =>
            sourceInfo.origin === "package" &&
            sourceInfo.scope === "user" &&
            sourceInfo.source === packageSource
        );
        expect(packageExtension).toBeDefined();
        expect(packageExtension!.resolvedPath).toBe(extensionPath);
        const attachmentReader = packageExtension!.tools.get("read_leased_attachment");
        expect(attachmentReader).toBeDefined();
        executeAttachmentReader = (path) =>
          attachmentReader!.definition.execute(
            "synthetic-tool-call",
            { path },
            undefined,
            undefined,
            undefined as never
          );
        return {
          session: {
            prompt,
            sendCustomMessage: async () => undefined,
            abort: async () => undefined,
            dispose: () => undefined
          }
        };
      },
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");
    const driver = await factory.openSession({ chatId: "chat-1", ...created });
    let running: Promise<void> | undefined;

    try {
      running = driver.runTurn(
        genericTurn("turn-package-handoff", {
          kind: "file",
          url: mediaUrl,
          name: "package-readable.pdf",
          mime: "application/pdf"
        })
      );
      await Promise.race([
        promptStarted.promise,
        running.then(() => {
          throw new Error("generic-only Turn settled without executing the package tool");
        })
      ]);

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(prompt).toHaveBeenCalledOnce();
      expect(promptedPath).toBeDefined();
      expect(isWithin(mediaRoot, promptedPath!)).toBe(true);
      expect(toolExecutionResult).toEqual({
        content: [{ type: "text", text: JSON.stringify(expectedDetails) }],
        details: expectedDetails
      });

      promptSettled.resolve();
      await running;
      await expect(readFile(promptedPath!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await leaseEntries(mediaRoot)).toEqual([]);
    } finally {
      promptSettled.resolve();
      await running?.catch(() => undefined);
      await driver.dispose();
      store.close();
    }
  });
});

function renderExpectedDescriptor({
  number,
  fixture,
  localPath
}: {
  number: number;
  fixture: GenericFixture;
  localPath: string;
}): string {
  const fields = [
    `kind=${fixture.kind}`,
    `name=${fixture.name}`,
    ...(fixture.declaredMime ? [`declared MIME=${fixture.declaredMime}`] : []),
    `detected MIME=${fixture.detectedMime}`,
    `bytes=${fixture.bytes.byteLength}`,
    `path=${localPath}`
  ];
  return `[Attachment ${number}: ${fields.join("; ")}]`;
}

function requireAttachmentLine(prompt: string, number: number): string {
  const prefix = `[Attachment ${number}:`;
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Prompt did not contain ${prefix}`);
  return line;
}

function requireDescriptorPath(descriptor: string): string {
  const match = /; path=(.+)]$/.exec(descriptor);
  if (!match?.[1]) throw new Error(`Attachment descriptor did not contain a terminal path: ${descriptor}`);
  return match[1];
}

function isWithin(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate);
}

function genericMessage(id: string, fragments: MediaFragment[]): ClawchatInboundMessage {
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

function genericTurn(id: string, fragment: MediaFragment) {
  return {
    id,
    chatId: "chat-1",
    messageId: `message-${id}`,
    status: "running" as const,
    frame: genericMessage(id, [fragment])
  };
}
