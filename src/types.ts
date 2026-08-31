export type MediaBackend = "worker" | "direct-r2";
export type MediaKind = "image" | "video";

export interface CloudflareMediaOptions {
  backend: MediaBackend;
  publicOrigin: string;
  imageTransformOrigin?: string;
  bucketName?: string;
  keyPrefix?: string;
  contentDirectory?: string;
  outputDirectory?: string;
  cacheDirectory?: string;
  manifestFilename?: string;
  ignorePatterns?: string[];
  excludeDrafts?: boolean;
  imageWidths?: number[];
  defaultImageWidth?: number;
  imageQuality?: number;
  imageSizes?: string;
  uploadConcurrency?: number;
  multipartConcurrency?: number;
  multipartPartSize?: number;
  workerUploadTokenEnvironment?: string;
}

export interface ResolvedCloudflareMediaOptions {
  backend: MediaBackend;
  publicOrigin: string;
  imageTransformOrigin: string;
  bucketName?: string;
  keyPrefix: string;
  contentDirectory: string;
  outputDirectory: string;
  cacheDirectory: string;
  manifestFilename: string;
  ignorePatterns: string[];
  excludeDrafts: boolean;
  imageWidths: number[];
  defaultImageWidth: number;
  imageQuality: number;
  imageSizes: string;
  uploadConcurrency: number;
  multipartConcurrency: number;
  multipartPartSize: number;
  workerUploadTokenEnvironment: string;
}

export interface MediaReference {
  notePath: string;
  target: string;
}

export interface MediaManifestEntry {
  sourcePath: string;
  outputPath: string;
  kind: MediaKind;
  mimeType: string;
  byteSize: number;
  sha256: string;
  key: string;
  publicUrl: string;
  width?: number;
  height?: number;
  references: MediaReference[];
}

export interface MediaManifest {
  version: 3;
  generatedAt: string;
  backend: MediaBackend;
  entries: MediaManifestEntry[];
  publishedNotes: string[];
}
