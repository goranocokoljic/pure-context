import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ─── Mock the API client ──────────────────────────────────────────────────────
// vi.mock factory is hoisted before variable declarations, so we must not
// reference outer `const` bindings inside the factory. Use vi.fn() inline
// and retrieve the mock via vi.mocked() after the import.

vi.mock('../src/api/client.js', () => ({
  api: {
    listRepos: vi.fn(),
  },
  ApiClientError: class ApiClientError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiClientError';
      this.status = status;
    }
  },
}));

// ─── Mock react-router-dom navigate ──────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// Import after mocks are registered
import { api } from '../src/api/client.js';
import RepoList from '../src/pages/RepoList.js';
import type { RepoMeta } from '../src/api/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    repoId: 'repo1',
    rootPath: '/home/user/projects/my-project',
    symbolCount: 42,
    fileCount: 10,
    lastIndexed: '2026-04-19T10:00:00Z',
    ...overrides,
  };
}

function renderRepoList() {
  return render(
    <MemoryRouter>
      <RepoList />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(api.listRepos).mockClear();
});

describe('RepoList', () => {
  it('shows loading skeletons while fetching', () => {
    vi.mocked(api.listRepos).mockReturnValue(new Promise(() => {}));
    renderRepoList();
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders repo cards after successful load', async () => {
    const repo = makeRepo({ rootPath: '/home/user/awesome-app' });
    vi.mocked(api.listRepos).mockResolvedValue({ repos: [repo], _meta: { timingMs: 1 } });
    renderRepoList();
    expect(await screen.findByText('awesome-app')).toBeInTheDocument();
  });

  it('renders symbol and file counts', async () => {
    const repo = makeRepo({ symbolCount: 99, fileCount: 7 });
    vi.mocked(api.listRepos).mockResolvedValue({ repos: [repo], _meta: { timingMs: 1 } });
    renderRepoList();
    expect(await screen.findByText('99')).toBeInTheDocument();
    expect(await screen.findByText('7')).toBeInTheDocument();
  });

  it('shows empty state when no repos exist', async () => {
    vi.mocked(api.listRepos).mockResolvedValue({ repos: [], _meta: { timingMs: 1 } });
    renderRepoList();
    expect(await screen.findByText(/no repositories indexed/i)).toBeInTheDocument();
  });

  it('shows error message on API failure', async () => {
    vi.mocked(api.listRepos).mockRejectedValue(new Error('Connection refused'));
    renderRepoList();
    expect(await screen.findByText(/connection refused/i)).toBeInTheDocument();
  });

  it('filters repos by name when filter input changes', async () => {
    const repos = [
      makeRepo({ repoId: 'r1', rootPath: '/projects/alpha' }),
      makeRepo({ repoId: 'r2', rootPath: '/projects/beta' }),
    ];
    vi.mocked(api.listRepos).mockResolvedValue({ repos, _meta: { timingMs: 1 } });
    renderRepoList();

    await screen.findByText('alpha');
    const input = screen.getByPlaceholderText(/filter repositories/i);
    fireEvent.change(input, { target: { value: 'alpha' } });

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
  });

  it('shows "no match" message when filter matches nothing', async () => {
    vi.mocked(api.listRepos).mockResolvedValue({ repos: [makeRepo()], _meta: { timingMs: 1 } });
    renderRepoList();
    await screen.findByText('my-project');

    const input = screen.getByPlaceholderText(/filter repositories/i);
    fireEvent.change(input, { target: { value: 'zzz-nonexistent' } });
    expect(screen.getByText(/no repositories match/i)).toBeInTheDocument();
  });

  it('navigates to repo detail when card is clicked', async () => {
    const repo = makeRepo({ repoId: 'abc123', rootPath: '/projects/myapp' });
    vi.mocked(api.listRepos).mockResolvedValue({ repos: [repo], _meta: { timingMs: 1 } });
    renderRepoList();

    const card = await screen.findByRole('button', { name: /open myapp/i });
    fireEvent.click(card);
    expect(mockNavigate).toHaveBeenCalledWith('/repos/abc123');
  });
});
