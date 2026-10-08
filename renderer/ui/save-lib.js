// Pure helper for saveTab (app.js): how a save over a digitally signed original is written.

/**
 * 'plain': not a save over the signed file the tab was opened from (Save As, unsigned, other path);
 * 'update': try an incremental update (core appendIncrementalUpdate) that keeps the signed bytes;
 * 'ask': only a full rewrite is possible, which breaks the signature, so confirm first. That is the
 * case after a page operation (tab.bytes is no longer the file), for a certified original that
 * forbids annotation changes (tab.certified), and while tab.requiresFullSave is set (the old bytes
 * still hold content that must go, e.g. applied redactions).
 */
export function signedSaveMode(tab, asNew = false) {
  if (asNew || !tab?.path || !tab.signedPath || tab.signedPath !== tab.path) return 'plain';
  if (tab.requiresFullSave || tab.certified || tab.bytes !== tab.fileBytes) return 'ask';
  return 'update';
}
