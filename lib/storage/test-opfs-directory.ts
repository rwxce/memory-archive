/**
 * In-memory stand-in for an OPFS directory, for tests (Node has no OPFS). It follows the
 * behaviours the blob store relies on: `NotFoundError` for missing entries, a writable's
 * content replacing the file only on `close()` (`abort()` discards it), a sync access
 * handle writing straight into the file (it keeps the existing bytes until `truncate`), and `move()` renaming atomically.
 * `capabilities` switches features off to exercise the fallbacks.
 */

import type {
  OpfsDirectoryHandle,
  OpfsFileHandle,
  OpfsSyncAccessHandle,
  OpfsWritable,
} from './opfs-blob-store';

export interface MemoryDirectoryCapabilities {
  /** `createWritable` (default true). */
  writable?: boolean;
  /** `createSyncAccessHandle` (default true). */
  syncAccess?: boolean;
  /** `move` (default true). */
  move?: boolean;
  /**
   * Fault hooks, read at write time so a test can switch them on after setup. They only hit
   * blob files (64-hex names), never the temp files, so the copy fallback is what fails.
   */
  faults?: {
    /** Writes throw. */
    failWrite?: boolean;
    /** Writes store the data with one byte flipped. */
    corruptWrite?: boolean;
    /** Sync access writes report 0 bytes written. */
    shortWrite?: boolean;
  };
}

interface FileNode {
  data: Uint8Array;
}
interface DirNode {
  entries: Map<string, FileNode | DirNode>;
}

const isDir = (node: FileNode | DirNode): node is DirNode => 'entries' in node;

const notFound = (name: string) => new DOMException(`${name} not found`, 'NotFoundError');

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function createMemoryDirectory(capabilities: MemoryDirectoryCapabilities = {}): OpfsDirectoryHandle {
  const { writable = true, syncAccess = true, move = true, faults = {} } = capabilities;
  const isBlobName = (name: string) => /^[0-9a-f]{64}$/.test(name);
  const faulty = (name: string, data: Uint8Array): Uint8Array => {
    if (!isBlobName(name)) return data;
    if (faults.failWrite) throw new Error('disk full');
    if (!faults.corruptWrite || data.length === 0) return data;
    const copy = data.slice();
    copy[0] ^= 0xff;
    return copy;
  };

  function fileHandle(parent: DirNode, name: string): OpfsFileHandle {
    const node = () => {
      const current = parent.entries.get(name);
      if (!current || isDir(current)) throw notFound(name);
      return current;
    };
    const handle: OpfsFileHandle = {
      kind: 'file',
      name,
      async getFile() {
        // A snapshot, like the real thing: later writes do not change a File already handed out.
        return new File([node().data.slice()], name);
      },
    };
    if (writable) {
      handle.createWritable = async (): Promise<OpfsWritable> => {
        node();
        let pending: Uint8Array = new Uint8Array(0);
        let closed = false;
        return {
          async write(data) {
            if (closed) throw new TypeError('writable is closed');
            pending = concat(pending, faulty(name, data));
          },
          async close() {
            closed = true;
            node().data = pending;
          },
          async abort() {
            closed = true;
            pending = new Uint8Array(0);
          },
        };
      };
    }
    if (syncAccess) {
      handle.createSyncAccessHandle = async (): Promise<OpfsSyncAccessHandle> => {
        const file = node();
        return {
          write(rawBuffer, { at }) {
            if (isBlobName(name) && faults.shortWrite) return 0;
            const buffer = faulty(name, rawBuffer);
            const next = new Uint8Array(Math.max(file.data.length, at + buffer.length));
            next.set(file.data);
            next.set(buffer, at);
            file.data = next;
            return buffer.length;
          },
          truncate(size) {
            file.data = file.data.slice(0, size);
          },
          flush() {},
          close() {},
        };
      };
    }
    if (move) {
      handle.move = async (destination, newName) => {
        const target = (destination as unknown as { __node: DirNode }).__node;
        const file = node();
        parent.entries.delete(name);
        target.entries.set(newName, file);
        // Keep this handle usable after the move, as a real one is.
        parent = target;
        name = newName;
      };
    }
    return handle;
  }

  function dirHandle(dir: DirNode, name: string): OpfsDirectoryHandle {
    const handle = {
      kind: 'directory' as const,
      name,
      __node: dir,
      async getDirectoryHandle(child: string, options?: { create?: boolean }) {
        let node = dir.entries.get(child);
        if (!node && options?.create) dir.entries.set(child, (node = { entries: new Map() }));
        if (!node || !isDir(node)) throw notFound(child);
        return dirHandle(node, child);
      },
      async getFileHandle(child: string, options?: { create?: boolean }) {
        let node = dir.entries.get(child);
        if (!node && options?.create) dir.entries.set(child, (node = { data: new Uint8Array(0) }));
        if (!node || isDir(node)) throw notFound(child);
        return fileHandle(dir, child);
      },
      async removeEntry(child: string) {
        if (!dir.entries.delete(child)) throw notFound(child);
      },
      async *entries(): AsyncGenerator<[string, OpfsFileHandle | OpfsDirectoryHandle]> {
        for (const [child, node] of [...dir.entries]) {
          yield [child, isDir(node) ? dirHandle(node, child) : fileHandle(dir, child)];
        }
      },
    };
    return handle;
  }

  return dirHandle({ entries: new Map() }, '');
}
