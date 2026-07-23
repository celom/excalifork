// -----------------------------------------------------------------------------
// in-memory FileSystemDirectoryHandle fake, shared by the folder-sync and
// folder-import tests
// -----------------------------------------------------------------------------

export class FakeDirectory {
  readonly kind = "directory" as const;
  name: string;
  files = new Map<string, string>();
  directories = new Map<string, FakeDirectory>();

  constructor(name = "") {
    this.name = name;
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let directory = this.directories.get(name);
    if (!directory) {
      if (!opts?.create) {
        throw new DOMException("not found", "NotFoundError");
      }
      directory = new FakeDirectory(name);
      this.directories.set(name, directory);
    }
    return directory;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name) && !opts?.create) {
      throw new DOMException("not found", "NotFoundError");
    }
    return {
      kind: "file" as const,
      name,
      getFile: async () => new File([this.files.get(name) ?? ""], name),
      createWritable: async () => ({
        write: async (content: string) => {
          this.files.set(name, content);
        },
        close: async () => {},
      }),
    };
  }

  async removeEntry(name: string) {
    if (this.files.delete(name)) {
      return;
    }
    const directory = this.directories.get(name);
    if (directory) {
      if (directory.files.size || directory.directories.size) {
        throw new DOMException("not empty", "InvalidModificationError");
      }
      this.directories.delete(name);
      return;
    }
    throw new DOMException("not found", "NotFoundError");
  }

  async *values() {
    for (const name of this.files.keys()) {
      yield await this.getFileHandle(name);
    }
    for (const directory of this.directories.values()) {
      yield directory;
    }
  }

  async *entries() {
    for await (const handle of this.values()) {
      yield [handle.name, handle] as const;
    }
  }

  /** test helper: seed a file at a (possibly nested) slash-separated path */
  async seedFile(path: string, content: string) {
    const segments = path.split("/");
    const filename = segments.pop()!;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let directory: FakeDirectory = this;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const writable = await (
      await directory.getFileHandle(filename, { create: true })
    ).createWritable();
    await writable.write(content);
    await writable.close();
  }

  /** test helper: flat map of path → content */
  snapshot(prefix = ""): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, content] of this.files) {
      result[`${prefix}${name}`] = content;
    }
    for (const [name, directory] of this.directories) {
      Object.assign(result, directory.snapshot(`${prefix}${name}/`));
    }
    return result;
  }
}

export const asRoot = (fake: FakeDirectory) =>
  fake as unknown as FileSystemDirectoryHandle;
