import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileOutline } from '../src/components/FileOutline.js';
import type { FileSummary, SymbolSummary } from '../src/api/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<SymbolSummary> = {}): SymbolSummary {
  return {
    id: 'sym-1',
    name: 'myFunction',
    kind: 'function',
    signature: 'function myFunction(): void',
    summary: 'Does something useful',
    startByte: 0,
    endByte: 100,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FileOutline', () => {
  it('renders placeholder when no file is selected', () => {
    render(<FileOutline fileSummary={null} />);
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it('renders empty-file message when file has no symbols', () => {
    const summary: FileSummary = { filePath: 'src/empty.ts', symbols: [] };
    render(<FileOutline fileSummary={summary} />);
    expect(screen.getByText(/no symbols/i)).toBeInTheDocument();
  });

  it('renders symbol names', () => {
    const summary: FileSummary = {
      filePath: 'src/lib.ts',
      symbols: [makeSymbol({ id: 's1', name: 'doWork' })],
    };
    render(<FileOutline fileSummary={summary} />);
    expect(screen.getByText('doWork')).toBeInTheDocument();
  });

  it('groups symbols by kind', () => {
    const summary: FileSummary = {
      filePath: 'src/lib.ts',
      symbols: [
        makeSymbol({ id: 's1', name: 'MyClass', kind: 'class' }),
        makeSymbol({ id: 's2', name: 'doWork', kind: 'function' }),
        makeSymbol({ id: 's3', name: 'helperFn', kind: 'function' }),
      ],
    };
    render(<FileOutline fileSummary={summary} />);

    // Group headers should be present
    expect(screen.getByText('Classes')).toBeInTheDocument();
    expect(screen.getByText('Functions')).toBeInTheDocument();

    // Symbols should be present
    expect(screen.getByText('MyClass')).toBeInTheDocument();
    expect(screen.getByText('doWork')).toBeInTheDocument();
    expect(screen.getByText('helperFn')).toBeInTheDocument();
  });

  it('shows symbol count per kind group', () => {
    const summary: FileSummary = {
      filePath: 'src/lib.ts',
      symbols: [
        makeSymbol({ id: 's1', name: 'fn1', kind: 'function' }),
        makeSymbol({ id: 's2', name: 'fn2', kind: 'function' }),
      ],
    };
    render(<FileOutline fileSummary={summary} />);
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('renders symbol signature', () => {
    const summary: FileSummary = {
      filePath: 'src/lib.ts',
      symbols: [makeSymbol({ id: 's1', signature: 'function foo(x: number): string' })],
    };
    render(<FileOutline fileSummary={summary} />);
    expect(screen.getByText('function foo(x: number): string')).toBeInTheDocument();
  });

  it('calls onSymbolClick with symbol id when clicked', () => {
    const onSymbolClick = vi.fn();
    const summary: FileSummary = {
      filePath: 'src/lib.ts',
      symbols: [makeSymbol({ id: 'sym-abc', name: 'clickMe' })],
    };
    render(<FileOutline fileSummary={summary} onSymbolClick={onSymbolClick} />);
    fireEvent.click(screen.getByText('clickMe'));
    expect(onSymbolClick).toHaveBeenCalledWith('sym-abc');
  });

  it('renders symbols from multiple kinds in order (classes before functions)', () => {
    const summary: FileSummary = {
      filePath: 'src/lib.ts',
      symbols: [
        makeSymbol({ id: 's1', name: 'doWork', kind: 'function' }),
        makeSymbol({ id: 's2', name: 'MyClass', kind: 'class' }),
      ],
    };
    render(<FileOutline fileSummary={summary} />);
    const headers = screen.getAllByRole('region').map((el) => el.getAttribute('aria-label'));
    const classIdx = headers.indexOf('Classes');
    const fnIdx = headers.indexOf('Functions');
    expect(classIdx).toBeGreaterThanOrEqual(0);
    expect(fnIdx).toBeGreaterThan(classIdx);
  });

  it('displays the file path', () => {
    const summary: FileSummary = {
      filePath: 'src/core/index.ts',
      symbols: [makeSymbol()],
    };
    render(<FileOutline fileSummary={summary} />);
    expect(screen.getByText('src/core/index.ts')).toBeInTheDocument();
  });
});
