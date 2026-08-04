/**
 * Reads one page of a conversation's visible turns.
 *
 * Page 1 is the *newest* turns, and each page reads oldest-to-newest within
 * itself. A chat is read from the bottom, so paging from the start meant any
 * thread longer than one page opened on its oldest messages — and every reply
 * sent afterwards landed on a page no client had asked for, which reads as the
 * answer never arriving. Both the app and the web client want the same end of
 * the thread, so this is the shape of the endpoint rather than an opt-in flag.
 *
 * The Message model is passed in rather than imported so the ordering can be
 * unit-tested against a fake, the way invoiceNumberService is.
 */

/** tool_call / tool_result rows are internal plumbing and never leave the server. */
const VISIBLE_KINDS = ['user_message', 'model_answer'];

export const readThreadPage = async (MessageModel, { conversationId, shopId, skip, limit }) => {
  const query = { conversation: conversationId, shop: shopId, kind: { $in: VISIBLE_KINDS } };
  // Descending in the query so `skip` counts back from the newest turn, then
  // reversed so the page itself still reads in conversation order.
  const [newestFirst, total] = await Promise.all([
    MessageModel.find(query)
      .sort({ turnIndex: -1 })
      .skip(skip)
      .limit(limit)
      .select('role parts toolsUsed createdAt'),
    MessageModel.countDocuments(query),
  ]);

  return { messages: [...newestFirst].reverse(), total };
};
