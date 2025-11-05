/**
 * Shared UI state for category panels across TagEditor and MultiFileEditor.
 * This allows collapsed/expanded state to persist when switching between files.
 */

let collapsedGroupsState: Set<string> | null = null;
let tagEditorScrollTop = 0;
let multiEditorScrollTop = 0;

export function getCollapsedGroups(): Set<string> | null {
  return collapsedGroupsState;
}

export function initializeCollapsedGroups(categories: string[]): void {
  if (collapsedGroupsState === null) {
    collapsedGroupsState = new Set(categories);
  }
}

export function setCollapsedGroups(groups: Set<string>): void {
  collapsedGroupsState = groups;
}

export function getTagEditorScrollTop(): number {
  return tagEditorScrollTop;
}

export function setTagEditorScrollTop(scrollTop: number): void {
  tagEditorScrollTop = scrollTop;
}

export function getMultiEditorScrollTop(): number {
  return multiEditorScrollTop;
}

export function setMultiEditorScrollTop(scrollTop: number): void {
  multiEditorScrollTop = scrollTop;
}
