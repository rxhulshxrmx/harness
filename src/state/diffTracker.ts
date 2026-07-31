import type * as vscodeTypes from "vscode";

declare function require(id: "vscode"): typeof vscodeTypes;

export interface DiffTracker {
  beginTurn(): void;
  snapshot(filePath: string, contentBefore: string | null | undefined): void;
  endTurn(): string[];
  getSnapshot(filePath: string): string | null | undefined;
}

export function createDiffTracker(): DiffTracker {
  let snapshots = new Map<string, string | null | undefined>();

  return {
    beginTurn() {
      snapshots = new Map();
    },
    snapshot(filePath, contentBefore) {
      if (!snapshots.has(filePath)) {
        snapshots.set(filePath, contentBefore);
      }
    },
    endTurn() {
      return [...snapshots.keys()];
    },
    getSnapshot(filePath) {
      return snapshots.get(filePath);
    },
  };
}

export const diffTracker = createDiffTracker();

export class BeforeContentProvider implements vscodeTypes.TextDocumentContentProvider {
  private readonly tracker: DiffTracker;

  constructor(tracker: DiffTracker) {
    this.tracker = tracker;
  }

  provideTextDocumentContent(uri: vscodeTypes.Uri): string {
    const filePath = decodeURIComponent(uri.path);
    const before = this.tracker.getSnapshot(filePath);
    if (before == null) return "";
    return before;
  }
}
