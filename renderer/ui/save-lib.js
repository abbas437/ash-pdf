// Pure helper for saveTab (app.js): how a save over a digitally signed original is written.

/**
 * 'plain': no signed original to keep (unsigned, other path), or a Save As that cannot be an update;
 * 'update': try an incremental update (core appendIncrementalUpdate) that keeps the signed bytes,
 * written in place or, for Save As (asNew), to the copy, so the copy stays validly signed;
 * 'ask': only a full rewrite is possible, which breaks the signature, so confirm first. That is the
 * case after a page operation (tab.bytes is no longer the file), for a certified original that
 * forbids annotation changes (tab.certified), and while tab.requiresFullSave is set (the old bytes
 * still hold content that must go, e.g. applied redactions). Save As then writes the copy in full
 * without asking ('plain'): the signed original is not touched.
 */
export function signedSaveMode(tab, asNew = false) {
  if (!tab?.path || !tab.signedPath || tab.signedPath !== tab.path) return 'plain';
  if (tab.requiresFullSave || tab.certified || tab.bytes !== tab.fileBytes) return asNew ? 'plain' : 'ask';
  return 'update';
}
