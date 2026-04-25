import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getAllFileHashes } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_file_tree';

export const description =
  'Get the directory tree of an indexed repo with file counts per directory. ' +
  'Shows which source files have been indexed, organized as a tree structure.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
};

interface DirNode {
  type: 'dir';
  children: Record<string, DirNode | FileNode>;
  fileCount: number;
}

interface FileNode {
  type: 'file';
}

export function handler(args: { repoId: string }): CallToolResult {
  const t0 = Date.now();
  const db = openDatabase(args.repoId);
  const hashes = getAllFileHashes(db, args.repoId);
  db.close();

  const root: DirNode = { type: 'dir', children: {}, fileCount: 0 };
  const files = Array.from(hashes.keys()).sort();

  for (const filePath of files) {
    const parts = filePath.split('/');
    let node = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children[part]) {
        node.children[part] = { type: 'dir', children: {}, fileCount: 0 };
      }
      node = node.children[part] as DirNode;
    }

    const fileName = parts[parts.length - 1];
    node.children[fileName] = { type: 'file' };
    node.fileCount++;

    // Bubble fileCount up to parents
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const depth1 = parts.slice(0, i + 1);
      void depth1;
    }
  }

  function countFiles(node: DirNode): number {
    let count = 0;
    for (const child of Object.values(node.children)) {
      if (child.type === 'file') count++;
      else count += countFiles(child as DirNode);
    }
    node.fileCount = count;
    return count;
  }
  countFiles(root);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            totalFiles: files.length,
            tree: root.children,
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
