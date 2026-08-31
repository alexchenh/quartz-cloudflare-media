import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type {
  MediaManifestEntry,
  ResolvedCloudflareMediaOptions,
} from "./types.js";

export interface MediaTransport {
  exists(entry: MediaManifestEntry): Promise<boolean>;
  upload(root: string, entry: MediaManifestEntry): Promise<void>;
  list(prefix: string): Promise<string[]>;
  close(): void;
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

class DirectR2Transport implements MediaTransport {
  readonly #client: S3Client;
  constructor(private readonly options: ResolvedCloudflareMediaOptions) {
    const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
    this.#client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  async #head(
    entry: MediaManifestEntry,
  ): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: entry.key,
        }),
      );
    } catch (error) {
      const candidate = error as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        candidate.name === "NotFound" ||
        candidate.$metadata?.httpStatusCode === 404
      )
        return undefined;
      throw error;
    }
  }
  async exists(entry: MediaManifestEntry): Promise<boolean> {
    return Boolean(await this.#head(entry));
  }
  async upload(root: string, entry: MediaManifestEntry): Promise<void> {
    const source = path.resolve(
      root,
      this.options.contentDirectory,
      entry.sourcePath,
    );
    const upload = new Upload({
      client: this.#client,
      queueSize: this.options.multipartConcurrency,
      partSize: this.options.multipartPartSize,
      leavePartsOnError: false,
      params: {
        Bucket: this.options.bucketName,
        Key: entry.key,
        Body: createReadStream(source),
        ContentType: entry.mimeType,
        ContentDisposition: "inline",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: { sha256: entry.sha256 },
      },
    });
    await upload.done();
  }
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? [])
        if (object.Key) keys.push(object.Key);
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }
  close(): void {
    this.#client.destroy();
  }
}

interface MultipartCreated {
  uploadId: string;
}
interface UploadedPart {
  partNumber: number;
  etag: string;
}

class WorkerTransport implements MediaTransport {
  readonly #token: string;
  constructor(private readonly options: ResolvedCloudflareMediaOptions) {
    this.#token = requiredEnvironment(options.workerUploadTokenEnvironment);
  }
  #url(route: string, key?: string): string {
    return `${this.options.publicOrigin}${route}${key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : ""}`;
  }
  #headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${this.#token}`);
    return headers;
  }
  async #request(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: this.#headers(init.headers),
    });
    if (!response.ok)
      throw new Error(
        `Worker request failed (${response.status}) ${init.method ?? "GET"} ${new URL(url).pathname}`,
      );
    return response;
  }
  async exists(entry: MediaManifestEntry): Promise<boolean> {
    const response = await fetch(this.#url("/v1/upload", entry.key), {
      method: "HEAD",
      headers: this.#headers(),
    });
    if (response.status === 404) return false;
    if (!response.ok)
      throw new Error(`Worker existence check failed (${response.status})`);
    return true;
  }
  async upload(root: string, entry: MediaManifestEntry): Promise<void> {
    const source = path.resolve(
      root,
      this.options.contentDirectory,
      entry.sourcePath,
    );
    if (entry.byteSize <= this.options.multipartPartSize) {
      await this.#request(this.#url("/v1/upload", entry.key), {
        method: "PUT",
        body: createReadStream(source) as unknown as BodyInit,
        // Node fetch requires duplex when streaming a request body.
        duplex: "half",
        headers: {
          "content-type": entry.mimeType,
          "x-content-sha256": entry.sha256,
        },
      } as RequestInit);
      return;
    }
    const created = await this.#request(
      this.#url("/v1/multipart/create", entry.key),
      {
        method: "POST",
        headers: {
          "content-type": entry.mimeType,
          "x-content-sha256": entry.sha256,
        },
      },
    ).then((response) => response.json() as Promise<MultipartCreated>);
    const handle = await open(source, "r");
    const parts: UploadedPart[] = [];
    try {
      let offset = 0;
      let partNumber = 1;
      while (offset < entry.byteSize) {
        const length = Math.min(
          this.options.multipartPartSize,
          entry.byteSize - offset,
        );
        const buffer = Buffer.allocUnsafe(length);
        const result = await handle.read(buffer, 0, length, offset);
        const part = await this.#request(
          this.#url(
            `/v1/multipart/${encodeURIComponent(created.uploadId)}/part/${partNumber}`,
            entry.key,
          ),
          { method: "PUT", body: buffer.subarray(0, result.bytesRead) },
        ).then((response) => response.json() as Promise<UploadedPart>);
        parts.push(part);
        offset += result.bytesRead;
        partNumber++;
      }
      await this.#request(
        this.#url(
          `/v1/multipart/${encodeURIComponent(created.uploadId)}/complete`,
          entry.key,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts }),
        },
      );
    } catch (error) {
      await fetch(
        this.#url(
          `/v1/multipart/${encodeURIComponent(created.uploadId)}/abort`,
          entry.key,
        ),
        {
          method: "DELETE",
          headers: this.#headers(),
        },
      );
      throw error;
    } finally {
      await handle.close();
    }
  }
  async list(prefix: string): Promise<string[]> {
    const response = await this.#request(
      `${this.options.publicOrigin}/v1/objects?prefix=${encodeURIComponent(prefix)}`,
      { method: "GET" },
    );
    const parsed = (await response.json()) as { keys?: unknown };
    if (
      !Array.isArray(parsed.keys) ||
      !parsed.keys.every((key) => typeof key === "string")
    )
      throw new Error("Worker returned an invalid object listing");
    return parsed.keys;
  }
  close(): void {}
}

export function createTransport(
  options: ResolvedCloudflareMediaOptions,
): MediaTransport {
  return options.backend === "worker"
    ? new WorkerTransport(options)
    : new DirectR2Transport(options);
}
