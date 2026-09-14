import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  overwrite?: boolean;
  flag?: string;
  beforeRename?: () => void;
}

export function writeAtomicFile(
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  options?: AtomicWriteOptions | BufferEncoding,
): void {
  const opts: AtomicWriteOptions =
    typeof options === "string" ? { encoding: options } : (options ?? {});
  const encoding = opts.encoding ?? "utf8";
  const overwrite = opts.overwrite ?? opts.flag !== "wx";

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (!overwrite && existsSync(filePath)) {
    const err = new Error(`EEXIST: file already exists, open '${filePath}'`);
    (err as NodeJS.ErrnoException).code = "EEXIST";
    throw err;
  }

  const tempFile = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);

  let fd: number | null = null;
  try {
    fd = openSync(tempFile, "wx", opts.mode);
    if (typeof content === "string") {
      writeFileSync(fd, content, { encoding });
    } else {
      writeFileSync(fd, content);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    if (!overwrite && existsSync(filePath)) {
      const err = new Error(`EEXIST: file already exists, open '${filePath}'`);
      (err as NodeJS.ErrnoException).code = "EEXIST";
      throw err;
    }

    opts.beforeRename?.();

    renameSync(tempFile, filePath);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    try {
      if (existsSync(tempFile)) {
        rmSync(tempFile, { force: true });
      }
    } catch {
      // ignore cleanup error
    }
    throw error;
  }
}
