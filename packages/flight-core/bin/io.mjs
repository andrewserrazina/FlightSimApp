// Shared file helpers for the recording CLIs: plain .jsonl or gzip-compressed .jsonl.gz.
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

export const readRecording = (file) => {
  const buf = readFileSync(file);
  return (file.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8");
};
export const writeRecording = (file, text) => writeFileSync(file, file.endsWith(".gz") ? gzipSync(Buffer.from(text, "utf8"), { level: 9 }) : text);
