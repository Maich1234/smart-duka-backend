import Conversation from '../models/Conversation.js';
import Message from '../models/Message.js';
import { runChatTurn } from '../services/ai/chat/chatOrchestrator.js';
import { readThreadPage } from '../services/conversationThreadService.js';
import { parsePagination } from '../utils/pagination.js';

/**
 * POST /ai/chat — sends one message and returns the AI's reply.
 * `conversationId` continues an existing thread; omitting it starts a new
 * one. The conversation lookup/creation happens here (controller owns
 * shop+owner scoping, per convention) — runChatTurn trusts the doc it's handed.
 */
export const postChatMessage = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const ownerId = req.user._id;
    const { conversationId, message } = req.body;

    let conversation = null;
    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, shop: shopId, owner: ownerId });
      if (!conversation) {
        return res.status(404).json({ success: false, message: 'Conversation not found.' });
      }
    } else {
      conversation = await Conversation.create({ shop: shopId, owner: ownerId });
    }

    const result = await runChatTurn({ shopId, conversation, userText: message });

    res.json({
      success: true,
      data: {
        conversationId: result.conversationId,
        message: {
          role: 'model',
          text: result.text,
          toolsUsed: result.toolsUsed,
          createdAt: new Date().toISOString(),
        },
        source: result.source,
      },
    });
  } catch (err) {
    console.error('[AI Chat] postChatMessage error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process chat message.' });
  }
};

/** GET /ai/chat/conversations — newest-first list of this owner's threads. */
export const listConversations = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const ownerId = req.user._id;
    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 50 });

    const query = { shop: shopId, owner: ownerId, archived: false };
    const [conversations, total] = await Promise.all([
      Conversation.find(query)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('title lastMessageAt messageCount createdAt'),
      Conversation.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: conversations,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[AI Chat] listConversations error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load conversations.' });
  }
};

/**
 * GET /ai/chat/conversations/:id — a thread's text turns only. tool_call/
 * tool_result rows are internal plumbing and never leave the server.
 *
 * Page 1 is the *newest* turns, and each page reads oldest-to-newest within
 * itself. A chat is read from the bottom: paging from the start meant any
 * thread longer than one page opened on its oldest messages, and every reply
 * sent afterwards landed on a page no client had asked for — which reads as
 * the answer never arriving. Both clients want the same end of the thread, so
 * this is the default rather than an opt-in flag.
 */
export const getConversation = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const ownerId = req.user._id;
    const conversation = await Conversation.findOne({ _id: req.params.id, shop: shopId, owner: ownerId });
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' });
    }

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100 });
    const { messages, total } = await readThreadPage(Message, {
      conversationId: conversation._id,
      shopId,
      skip,
      limit,
    });

    res.json({
      success: true,
      data: {
        conversation: {
          _id: conversation._id,
          title: conversation.title,
          lastMessageAt: conversation.lastMessageAt,
          messageCount: conversation.messageCount,
          createdAt: conversation.createdAt,
        },
        messages: messages.map((m) => ({
          _id: m._id,
          role: m.role,
          text: m.parts.map((p) => p.text).filter(Boolean).join(''),
          toolsUsed: m.toolsUsed,
          createdAt: m.createdAt,
        })),
      },
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[AI Chat] getConversation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load conversation.' });
  }
};

/** DELETE /ai/chat/conversations/:id — soft delete; transcripts are never hard-deleted. */
export const archiveConversation = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const ownerId = req.user._id;
    const conversation = await Conversation.findOneAndUpdate(
      { _id: req.params.id, shop: shopId, owner: ownerId },
      { $set: { archived: true } }
    );
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[AI Chat] archiveConversation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to archive conversation.' });
  }
};
