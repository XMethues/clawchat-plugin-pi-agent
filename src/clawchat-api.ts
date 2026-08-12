import { isUnknownRecord } from "./type-guards.js";

export type ClawchatApiErrorKind = "validation" | "auth" | "api" | "transport";

export class ClawchatApiError extends Error {
  constructor(
    readonly kind: ClawchatApiErrorKind,
    message: string,
    readonly options: {
      status?: number;
      path?: string;
      code?: number | string;
      data?: Record<string, unknown>;
      retryable?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "ClawchatApiError";
  }
}

export interface ClawchatApiClientOptions {
  restUrl: string;
  mediaUrl: string;
  accessToken: () => string;
  refreshAccessToken?: () => Promise<void>;
  fetchFn?: typeof fetch;
}

export interface RotatedTokens {
  accessToken: string;
  refreshToken: string;
}

interface ApiEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

export class ClawchatApiClient {
  private readonly restUrl: string;
  private readonly mediaUrl: string;
  private readonly accessToken: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly refreshAccessToken: (() => Promise<void>) | undefined;
  private refreshInFlight: Promise<void> | undefined;

  constructor(options: ClawchatApiClientOptions) {
    this.restUrl = options.restUrl;
    this.mediaUrl = options.mediaUrl;
    this.accessToken = options.accessToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.refreshAccessToken = options.refreshAccessToken;
  }

  async get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    return this.request("GET", `${path}${search.size > 0 ? `?${search}` : ""}`);
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.request("POST", path, body);
  }

  async patch(path: string, body: unknown): Promise<unknown> {
    return this.request("PATCH", path, body);
  }

  async delete(path: string, body?: unknown): Promise<unknown> {
    return this.request("DELETE", path, body);
  }

  async upload(path: string, file: { bytes: Uint8Array; filename: string; mime: string }): Promise<Record<string, unknown>> {
    return this.uploadRequest(path, file);
  }

  async refresh(refreshToken: string, deviceId: string): Promise<RotatedTokens> {
    if (!refreshToken.trim()) throw new ClawchatApiError("validation", "refresh_token is required");
    if (!deviceId.trim()) throw new ClawchatApiError("validation", "device_id is required");
    const path = "/v1/auth/refresh";
    let response: Response;
    try {
      response = await this.fetchFn(`${this.restUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-device-id": deviceId },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
    } catch (error: unknown) {
      throw new ClawchatApiError("transport", error instanceof Error ? error.message : String(error), {
        path,
        retryable: true
      });
    }
    const envelope = await this.parseEnvelope(response, path);
    const code = normalizeCode(envelope.code);
    if (code !== 0) {
      const kind: ClawchatApiErrorKind = code === 10003 ? "auth" : code === 400 ? "validation" : "api";
      throw new ClawchatApiError(kind, stringValue(envelope.msg) || "token refresh failed", {
        status: response.status,
        path,
        ...(code !== undefined ? { code } : {}),
        ...(isUnknownRecord(envelope.data) ? { data: envelope.data } : {}),
        retryable: kind === "api"
      });
    }
    if (!isUnknownRecord(envelope.data)) {
      throw new ClawchatApiError("transport", "refresh response missing data", { status: response.status, path });
    }
    const accessToken = opaqueTokenValue(envelope.data.access_token);
    const nextRefreshToken = opaqueTokenValue(envelope.data.refresh_token);
    if (!accessToken || !nextRefreshToken) {
      throw new ClawchatApiError("transport", "refresh response missing rotated tokens", {
        status: response.status,
        path
      });
    }
    return { accessToken, refreshToken: nextRefreshToken };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { response, envelope, code } = await this.authenticatedEnvelope(
      path,
      (accessToken) =>
        this.fetchFn(`${this.restUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
    );
    if (!isSuccessfulResponse(response, code)) {
      const kind = classifyApiFailure(response, code);
      throw new ClawchatApiError(
        kind,
        stringValue(envelope.msg) || `ClawChat API request failed (${response.status})`,
        {
          status: response.status,
          path,
          ...(code !== undefined ? { code } : {}),
          ...(isUnknownRecord(envelope.data) ? { data: envelope.data } : {}),
          retryable: response.status >= 500 || code === 1
        }
      );
    }
    return envelope.data === undefined ? envelope : envelope.data;
  }

  private async uploadRequest(
    path: string,
    file: { bytes: Uint8Array; filename: string; mime: string }
  ): Promise<Record<string, unknown>> {
    const blobBytes =
      file.bytes.buffer instanceof ArrayBuffer &&
      file.bytes.byteOffset === 0 &&
      file.bytes.byteLength === file.bytes.buffer.byteLength
        ? file.bytes.buffer
        : Uint8Array.from(file.bytes).buffer;
    const { response, envelope, code } = await this.authenticatedEnvelope(
      path,
      (accessToken) => {
        const form = new FormData();
        form.append("file", new Blob([blobBytes], { type: file.mime }), file.filename);
        return this.fetchFn(
          `${path === "/media/upload" ? this.mediaUrl : this.restUrl}${path}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}` },
            body: form
          }
        );
      }
    );
    return this.unwrapRecord(response, path, envelope, code);
  }

  private async authenticatedEnvelope(
    path: string,
    execute: (accessToken: string) => Promise<Response>,
    allowRefresh = true
  ): Promise<{ response: Response; envelope: ApiEnvelope; code: number | string | undefined }> {
    let response: Response;
    try {
      response = await execute(this.requireToken());
    } catch (error: unknown) {
      throw new ClawchatApiError("transport", error instanceof Error ? error.message : String(error), {
        path,
        retryable: true
      });
    }
    const envelope = await this.parseEnvelope(response, path);
    const code = normalizeCode(envelope.code);
    if (isAuthFailure(response, code) && allowRefresh && this.refreshAccessToken) {
      await this.refreshToken();
      return this.authenticatedEnvelope(path, execute, false);
    }
    return { response, envelope, code };
  }

  private async refreshToken(): Promise<void> {
    if (!this.refreshAccessToken) return;
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshAccessToken().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    await this.refreshInFlight;
  }

  private unwrapRecord(
    response: Response,
    path: string,
    envelope: ApiEnvelope,
    code: number | string | undefined
  ): Record<string, unknown> {
    if (!isSuccessfulResponse(response, code)) {
      throw new ClawchatApiError(
        classifyApiFailure(response, code),
        stringValue(envelope.msg) || "upload failed",
        {
          status: response.status,
          path,
          ...(code !== undefined ? { code } : {}),
          ...(isUnknownRecord(envelope.data) ? { data: envelope.data } : {})
        }
      );
    }
    const value = envelope.data === undefined ? envelope : envelope.data;
    if (!isUnknownRecord(value)) {
      throw new ClawchatApiError("transport", "upload response missing data", { path });
    }
    return value;
  }

  private async parseEnvelope(response: Response, path: string): Promise<ApiEnvelope> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error: unknown) {
      throw new ClawchatApiError("transport", `ClawChat API returned non-JSON: ${error instanceof Error ? error.message : String(error)}`, {
        status: response.status,
        path,
        retryable: response.status >= 500
      });
    }
    if (!isUnknownRecord(parsed)) {
      throw new ClawchatApiError("transport", "ClawChat API returned an invalid envelope", {
        status: response.status,
        path
      });
    }
    return parsed;
  }

  private requireToken(): string {
    const token = this.accessToken();
    if (!token.trim()) throw new ClawchatApiError("auth", "ClawChat is not activated");
    return token;
  }
}

function normalizeCode(value: unknown): number | string | undefined {
  if (typeof value === "number" || typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return undefined;
}

function isSuccessfulResponse(
  response: Response,
  code: number | string | undefined
): boolean {
  return code === undefined ? response.ok : code === 0;
}

function isAuthFailure(response: Response, code: number | string | undefined): boolean {
  return (
    code === 10003 ||
    code === 40101 ||
    (code === undefined && (response.status === 401 || response.status === 403))
  );
}

function classifyApiFailure(
  response: Response,
  code: number | string | undefined
): ClawchatApiErrorKind {
  if (isAuthFailure(response, code)) return "auth";
  if (code === 400) return "validation";
  return "api";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function opaqueTokenValue(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

