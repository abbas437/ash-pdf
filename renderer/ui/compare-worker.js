// Compare worker: comparePages (compare-lib.js) off the UI thread, so the window and the Cancel button of a compare
// stay responsive while a large sheet is compared. compare-lib.js imports nothing, so the module loads here as it
// is (no vendor copy). Messages: compareRequest / compareReply / compareErrorReply in compare-lib.js; a 'ping'
// answers true.
import { comparePages, compareReply, compareErrorReply } from './compare-lib.js';

self.onmessage = ({ data: { id, method, a, b, width, height, opts } }) => {
  let reply;
  try {
    if (method === 'ping') reply = compareReply(id, true);
    else if (method === 'compare') reply = compareReply(id, comparePages(a, b, width, height, opts));
    else throw new Error(`compare worker: unknown method ${method}`);
  } catch (err) {
    reply = compareErrorReply(id, err);
  }
  self.postMessage(reply.msg, reply.transfer);
};
