export function chainStart(): void {
  chainMiddleA();
  chainMiddleB();
}

export function chainMiddleA(): void {
  chainTerminalWorker();
}

export function chainMiddleB(): void {
  chainEnd();
}

export function chainTerminalWorker(): void {
  // terminal: matches *Worker endHint
}

export function chainEnd(): void {
  // another terminal leaf
}
