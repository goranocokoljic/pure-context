import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FileTree } from '../src/components/FileTree.js';
import { useRepoStore } from '../src/stores/repoStore.js';
import type { FileTreeNode } from '../src/api/types.js';

// ─── Reset store between tests ────────────────────────────────────────────────

beforeEach(() => {
  useRepoStore.setState({
    repos: [],
    reposLoaded: false,
    trees: {},
    outlines: {},
    selectedRepoId: null,
    selectedFilePath: null,
    expandedDirs: {},
  });
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockTree: Record<string, FileTreeNode> = {
  src: {
    type: 'dir',
    fileCount: 2,
    children: {
      'index.ts': { type: 'file' },
      'utils.ts': { type: 'file' },
    },
  },
  'README.md': { type: 'file' },
};

function renderTree(onFileClick = vi.fn()) {
  return render(
    <MemoryRouter>
      <FileTree tree={mockTree} repoId="repo1" onFileClick={onFileClick} />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FileTree', () => {
  it('renders top-level entries', () => {
    renderTree();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('directories start collapsed — children not visible', () => {
    renderTree();
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('utils.ts')).not.toBeInTheDocument();
  });

  it('clicking a directory expands it to show children', () => {
    renderTree();
    fireEvent.click(screen.getByText('src'));
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText('utils.ts')).toBeInTheDocument();
  });

  it('clicking an expanded directory collapses it', () => {
    renderTree();
    fireEvent.click(screen.getByText('src'));   // expand
    fireEvent.click(screen.getByText('src'));   // collapse
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });

  it('clicking a file calls onFileClick with the path', () => {
    const onFileClick = vi.fn();
    renderTree(onFileClick);
    fireEvent.click(screen.getByText('README.md'));
    expect(onFileClick).toHaveBeenCalledWith('README.md');
  });

  it('clicking a nested file calls onFileClick with full path', () => {
    const onFileClick = vi.fn();
    renderTree(onFileClick);
    fireEvent.click(screen.getByText('src'));         // expand
    fireEvent.click(screen.getByText('index.ts'));
    expect(onFileClick).toHaveBeenCalledWith('src/index.ts');
  });

  it('renders empty state when tree has no entries', () => {
    render(
      <MemoryRouter>
        <FileTree tree={{}} repoId="repo1" onFileClick={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No files found')).toBeInTheDocument();
  });

  it('shows file count on directory button', () => {
    renderTree();
    // The directory button contains the fileCount (2)
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('persist expand state in the store (toggleDir)', () => {
    renderTree();
    fireEvent.click(screen.getByText('src'));
    const expanded = useRepoStore.getState().expandedDirs['repo1'];
    expect(expanded?.has('src')).toBe(true);
  });
});
