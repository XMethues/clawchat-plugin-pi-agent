import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  leaseEntries,
  makeTempDir,
  minimalTestTools,
  utf8
} from "./helpers/inbound-media.js";
import { GatewayStore } from "../src/gateway-store.js";
import { InboundMediaMaterializer } from "../src/inbound-media.js";
import { PiChatSessionFactory } from "../src/pi-session-factory.js";
import type { ClawchatInboundMessage, MediaFragment } from "../src/types.js";

interface TextFixture {
  name: string;
  declaredMime?: string;
  detectedMime: string;
  content: string;
  bytes: Uint8Array;
}

interface RejectedTextFixture {
  label: string;
  name: string;
  declaredMime: string;
  detectedMime: string;
  bytes: Uint8Array;
}

afterEach(async () => {
  await cleanupTempDirs();
});

describe("inbound text documents", () => {
  it("completes a text-document-only Turn with the complete Pi file block and a Turn-scoped path", async () => {
    const parent = await makeTempDir("clawchat-inbound-text-media-");
    const workspace = join(parent, "workspace");
    const mediaRoot = join(parent, "private-media");
    await mkdir(workspace);
    const store = GatewayStore.open(join(parent, "gateway.sqlite"));
    const content = [
      "# Attached release notes",
      "",
      ...Array.from({ length: 96 }, (_, index) => `line ${index + 1}: complete document content`),
      "END-OF-DOCUMENT"
    ].join("\n");
    const bytes = utf8(content);
    const mediaUrl = "https://media.clawling.com/private/release-notes-capability";
    const promptStarted = Promise.withResolvers<void>();
    const promptSettled = Promise.withResolvers<void>();
    const prompt = vi.fn(async (_text: string) => {
      promptStarted.resolve();
      await promptSettled.promise;
    });
    const fetchFn = vi.fn(async () =>
      new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
    );
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir: parent,
      sessionDir: join(parent, "sessions"),
      media: { rootDir: mediaRoot, fetchFn: fetchFn as typeof fetch },
      tools: minimalTestTools,
      createAgentSessionFn: async () => ({
        session: {
          prompt,
          sendCustomMessage: async () => undefined,
          abort: async () => undefined,
          dispose: () => undefined
        }
      }),
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");
    const driver = await factory.openSession({ chatId: "chat-1", ...created });
    let running: Promise<void> | undefined;

    try {
      running = driver.runTurn(fileTurn("text-markdown", mediaUrl, "release-notes.md", "text/markdown"));
      await Promise.race([
        promptStarted.promise,
        running.then(() => {
          throw new Error("text-document-only Turn settled without prompting Pi");
        })
      ]);

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(prompt).toHaveBeenCalledOnce();
      const promptText = prompt.mock.calls[0]![0];
      const file = expectValidTextHandoff(promptText, {
        name: "release-notes.md",
        declaredMime: "text/markdown",
        detectedMime: "application/octet-stream",
        content,
        bytes
      });
      expect(promptText).not.toContain(mediaUrl);
      expect(promptText).toContain("END-OF-DOCUMENT");
      expect(file.path.startsWith(mediaRoot)).toBe(true);
      expect(await readFile(file.path)).toEqual(Buffer.from(bytes));
      expect(await leaseEntries(mediaRoot)).not.toEqual([]);

      promptSettled.resolve();
      await running;
      await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await leaseEntries(mediaRoot)).toEqual([]);
    } finally {
      promptSettled.resolve();
      await running?.catch(() => undefined);
      await driver.dispose();
      store.close();
    }
  });

  it.each(textFixtures())(
    "materializes complete validated $name content as a Pi file block",
    async (fixture) => {
      const { materializer, rootDir } = await makeMaterializer(fixture.bytes, fixture.detectedMime);
      const mediaUrl = `https://media.clawling.com/private/${encodeURIComponent(fixture.name)}`;
      const result = await materializer.materialize(
        fileMessage("validated-text", mediaUrl, fixture.name, fixture.declaredMime)
      );

      const file = expectValidTextHandoff(result.prompt, fixture);
      expect(result.images).toEqual([]);
      expect(result.prompt).not.toContain(mediaUrl);
      expect(await readFile(file.path)).toEqual(Buffer.from(fixture.bytes));
      expect(await leaseEntries(rootDir)).not.toEqual([]);

      await result.release();
      await expect(readFile(file.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await leaseEntries(rootDir)).toEqual([]);
    }
  );

  it.each(rejectedTextFixtures())(
    "hands $label off as a generic local attachment instead of decoding it as text",
    async (fixture) => {
      const { materializer, rootDir } = await makeMaterializer(fixture.bytes, fixture.detectedMime);
      const mediaUrl = `https://media.clawling.com/private/rejected-${encodeURIComponent(fixture.name)}`;
      const result = await materializer.materialize(
        fileMessage("rejected-text", mediaUrl, fixture.name, fixture.declaredMime)
      );

      expect(result.images).toEqual([]);
      expect(result.prompt).not.toContain("<file name=");
      expect(result.prompt).not.toContain("\uFFFD");
      expect(result.prompt).not.toMatch(/attachment unavailable/i);
      expect(result.prompt).not.toContain(mediaUrl);
      const descriptor = genericDescriptor(result.prompt, fixture);
      expect(descriptor.path).toBeDefined();
      expect(isAbsolute(descriptor.path!)).toBe(true);
      expect(descriptor.path!.startsWith(rootDir)).toBe(true);
      expect(await readFile(descriptor.path!)).toEqual(Buffer.from(fixture.bytes));

      await result.release();
      await expect(readFile(descriptor.path!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await leaseEntries(rootDir)).toEqual([]);
    }
  );
});

function textFixtures(): TextFixture[] {
  const fixtures: Array<Omit<TextFixture, "bytes"> & { encoding?: "utf16le" | "utf16be" }> = [
    {
      name: "config.json",
      detectedMime: "application/json",
      content: '{"enabled":true,"scope":"complete"}'
    },
    {
      name: "pipeline.yaml",
      detectedMime: "application/octet-stream",
      content: "name: inbound\nsteps:\n  - validate\n  - deliver"
    },
    {
      name: "document.xml",
      declaredMime: "application/xml",
      detectedMime: "application/octet-stream",
      content: '<document complete="true"><value>42</value></document>'
    },
    {
      name: "records.csv",
      detectedMime: "text/csv",
      content: "name,count\nalpha,1\nbeta,2"
    },
    {
      name: "records.tsv",
      detectedMime: "application/octet-stream",
      content: "name\tcount\nalpha\t1\nbeta\t2"
    },
    {
      name: "handler.ts",
      detectedMime: "application/octet-stream",
      content: "export function answer(value: number): number {\n  return value + 1;\n}"
    },
    {
      name: "little-endian.txt",
      declaredMime: "text/plain",
      detectedMime: "application/octet-stream",
      content: "UTF-16LE: café, 東京, complete",
      encoding: "utf16le"
    },
    {
      name: "big-endian.txt",
      declaredMime: "text/plain",
      detectedMime: "application/octet-stream",
      content: "UTF-16BE: naïve, Αθήνα, complete",
      encoding: "utf16be"
    }
  ];
  return fixtures.map(({ encoding, ...fixture }) => ({
    ...fixture,
    bytes:
      encoding === "utf16le"
        ? utf16LeWithBom(fixture.content)
        : encoding === "utf16be"
          ? utf16BeWithBom(fixture.content)
          : utf8(fixture.content)
  }));
}

function rejectedTextFixtures(): RejectedTextFixture[] {
  return [
    {
      label: "malformed UTF-8",
      name: "malformed.txt",
      declaredMime: "text/plain",
      detectedMime: "text/plain",
      bytes: Uint8Array.from([0x66, 0x6f, 0x80, 0x6f])
    },
    {
      label: "BOM-less UTF-16",
      name: "bomless.txt",
      declaredMime: "text/plain",
      detectedMime: "application/octet-stream",
      bytes: Uint8Array.from(Buffer.from("BOM-less UTF-16 must remain binary", "utf16le"))
    },
    {
      label: "NUL-heavy content",
      name: "nul-heavy.csv",
      declaredMime: "text/csv",
      detectedMime: "text/csv",
      bytes: Uint8Array.from([0x61, 0x2c, 0x62, 0x0a, 0, 0, 0, 0, 0x31, 0x2c, 0x32])
    },
    {
      label: "binary content with misleading text metadata",
      name: "actually-binary.md",
      declaredMime: "text/markdown",
      detectedMime: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xff])
    },
    {
      label: "ASCII PDF with a text-looking filename",
      name: "report.txt",
      declaredMime: "application/pdf",
      detectedMime: "application/pdf",
      bytes: utf8("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF")
    }
  ];
}

function expectValidTextHandoff(prompt: string, fixture: TextFixture): { path: string } {
  const identity = prompt.split("\n").find((line) => line.startsWith("[Attachment 1:"));
  expect(identity).toBeDefined();
  expect(identity).toContain(fixture.name);
  expect(prompt.match(/<file name=/g)).toHaveLength(1);
  const match = prompt.match(/<file name="([^"]+)">\n([\s\S]*?)\n<\/file>/);
  expect(match).not.toBeNull();
  const path = match![1]!;
  expect(isAbsolute(path)).toBe(true);
  expect(match![0]).toBe(`<file name="${path}">\n${fixture.content}\n</file>`);
  return { path };
}

function genericDescriptor(prompt: string, fixture: RejectedTextFixture): { path?: string } {
  const prefix =
    `[Attachment 1: kind=file; name=${fixture.name}; declared MIME=${fixture.declaredMime}; ` +
    `detected MIME=${fixture.detectedMime}; bytes=${fixture.bytes.byteLength}; path=`;
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  expect(line).toBeDefined();
  expect(line).toMatch(/^\[Attachment 1: kind=file; name=[^;]+; declared MIME=[^;]+; detected MIME=[^;]+; bytes=\d+; path=[^\]]+\]$/);
  return line ? { path: line.slice(prefix.length, -1) } : {};
}

async function makeMaterializer(bytes: Uint8Array, detectedMime: string) {
  const parent = await makeTempDir("clawchat-inbound-text-media-");
  const rootDir = join(parent, "leases");
  return {
    rootDir,
    materializer: new InboundMediaMaterializer({
      rootDir,
      fetchFn: vi.fn(async () =>
        new Response(bytes, { headers: { "content-type": detectedMime } })
      ) as typeof fetch
    })
  };
}

function fileTurn(id: string, url: string, name: string, mime: string) {
  return {
    id,
    chatId: "chat-1",
    messageId: `message-${id}`,
    status: "running" as const,
    frame: fileMessage(id, url, name, mime)
  };
}

function fileMessage(
  id: string,
  url: string,
  name: string,
  mime?: string
): ClawchatInboundMessage {
  const fragment: MediaFragment = {
    kind: "file",
    url,
    name,
    ...(mime ? { mime } : {})
  };
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
      message: { body: { fragments: [fragment] } }
    }
  };
}

function utf16LeWithBom(content: string): Uint8Array {
  return Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]));
}

function utf16BeWithBom(content: string): Uint8Array {
  const littleEndian = Buffer.from(content, "utf16le");
  for (let index = 0; index < littleEndian.length; index += 2) {
    [littleEndian[index], littleEndian[index + 1]] = [littleEndian[index + 1]!, littleEndian[index]!];
  }
  return Uint8Array.from(Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian]));
}
