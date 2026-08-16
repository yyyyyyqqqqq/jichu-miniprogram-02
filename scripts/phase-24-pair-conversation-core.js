const crypto = require('crypto');

const USER_ID_PATTERN = /^u_[a-f0-9]{32}$/;
const CONVERSATION_ID_PATTERN = /^c_[a-f0-9]{64}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const LAST_MESSAGE_MAX_LENGTH = 80;
const MESSAGE_SUMMARIES = Object.freeze({
  image: '[图片]',
  voice: '[语音]',
  location: '[位置]',
  product: '[商品]',
  system: '[系统消息]',
  unsupported: '[不支持的消息]'
});
const CANONICAL_FIELDS = Object.freeze([
  '_id', 'participantPairKey',
  'participantAUserId', 'participantBUserId',
  'participantAOpenid', 'participantBOpenid',
  'participantAUnreadCount', 'participantBUnreadCount',
  'productId', 'productSnapshot', 'lastProductId', 'lastProductSnapshot',
  'lastMessage', 'lastMessageType', 'lastMessageAt', 'lastSenderOpenid',
  'contextUpdatedAt', 'status', 'schemaVersion', 'createdAt', 'updatedAt'
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toMillis(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function latestDate(...values) {
  return values.flat().filter(Boolean).sort((left, right) => (
    toMillis(right) - toMillis(left)
  ))[0] || null;
}

function earliestDate(values) {
  return values.filter(Boolean).sort((left, right) => (
    toMillis(left) - toMillis(right)
  ))[0] || null;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalProjection(document) {
  return Object.fromEntries(CANONICAL_FIELDS.map((field) => [
    field,
    document && Object.prototype.hasOwnProperty.call(document, field)
      ? document[field]
      : null
  ]));
}

function documentsEquivalent(left, right) {
  return JSON.stringify(canonicalProjection(left))
    === JSON.stringify(canonicalProjection(right));
}

function createParticipantPair(userIdA, userIdB) {
  const ids = [normalizeText(userIdA), normalizeText(userIdB)].sort();
  if (
    ids[0] === ids[1]
    || !ids.every((id) => USER_ID_PATTERN.test(id))
  ) {
    return null;
  }
  const hash = digest(`${ids[0]}:${ids[1]}`);
  return {
    userIdA: ids[0],
    userIdB: ids[1],
    conversationId: `c_${hash}`,
    participantPairKey: `pp_${hash}`
  };
}

function getUserOpenid(user) {
  return normalizeText(user && (user.openid || user._openid));
}

function getConversationUserIds(conversation, userIdByOpenid) {
  const participantAUserId = normalizeText(
    conversation.participantAUserId
      || userIdByOpenid.get(normalizeText(conversation.participantAOpenid))
  );
  const participantBUserId = normalizeText(
    conversation.participantBUserId
      || userIdByOpenid.get(normalizeText(conversation.participantBOpenid))
  );
  return { participantAUserId, participantBUserId };
}

function messageSummary(message) {
  if (!message) return '';
  if (message.type === 'text') {
    return normalizeText(message.content).slice(0, LAST_MESSAGE_MAX_LENGTH);
  }
  if (message.type === 'system') {
    return normalizeText(message.content).slice(0, LAST_MESSAGE_MAX_LENGTH)
      || MESSAGE_SUMMARIES.system;
  }
  return MESSAGE_SUMMARIES[message.type] || MESSAGE_SUMMARIES.unsupported;
}

function buildMigrationPlan(snapshot, options = {}) {
  const conversations = Array.isArray(snapshot.conversations)
    ? snapshot.conversations
    : [];
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const appointments = Array.isArray(snapshot.appointments)
    ? snapshot.appointments
    : [];
  const users = Array.isArray(snapshot.users) ? snapshot.users : [];
  const products = Array.isArray(snapshot.products) ? snapshot.products : [];
  const issues = [];
  const userById = new Map(users.map((user) => [normalizeText(user._id), user]));
  const userIdByOpenid = new Map(users.map((user) => [
    getUserOpenid(user),
    normalizeText(user._id)
  ]).filter(([openid, userId]) => openid && userId));
  const productById = new Map(products.map((product) => [
    normalizeText(product._id),
    product
  ]));
  const conversationById = new Map(conversations.map((conversation) => [
    normalizeText(conversation._id),
    conversation
  ]));
  const groups = new Map();

  conversations.filter((conversation) => (
    normalizeText(conversation.status) !== 'merged'
  )).forEach((conversation) => {
    const sourceId = normalizeText(conversation._id);
    if (!CONVERSATION_ID_PATTERN.test(sourceId)) {
      issues.push({ code: 'INVALID_CONVERSATION_ID', sourceId });
      return;
    }
    const ids = getConversationUserIds(conversation, userIdByOpenid);
    const pair = createParticipantPair(
      ids.participantAUserId,
      ids.participantBUserId
    );
    if (!pair) {
      issues.push({ code: 'INVALID_PARTICIPANT_PAIR', sourceId });
      return;
    }
    const key = `${pair.userIdA}:${pair.userIdB}`;
    if (!groups.has(key)) groups.set(key, { pair, conversations: [] });
    groups.get(key).conversations.push(conversation);
    const existingPairKey = normalizeText(conversation.participantPairKey);
    if (existingPairKey && existingPairKey !== pair.participantPairKey) {
      issues.push({ code: 'PAIR_KEY_CONFLICT', sourceId });
    }
  });

  const messagesByConversation = new Map();
  messages.forEach((message) => {
    const sourceId = normalizeText(message.conversationId);
    if (!conversationById.has(sourceId)) {
      issues.push({ code: 'ORPHAN_MESSAGE', messageId: normalizeText(message._id) });
      return;
    }
    if (!messagesByConversation.has(sourceId)) {
      messagesByConversation.set(sourceId, []);
    }
    messagesByConversation.get(sourceId).push(message);
  });

  appointments.forEach((appointment) => {
    if (!conversationById.has(normalizeText(appointment.conversationId))) {
      issues.push({
        code: 'ORPHAN_APPOINTMENT',
        appointmentId: normalizeText(appointment._id)
      });
    }
  });

  const canonicalWrites = [];
  const canonicalStates = [];
  const messageUpdates = [];
  const appointmentUpdates = [];
  const archives = [];
  const uniqueMessageKeys = new Set();

  groups.forEach((group) => {
    const { pair } = group;
    const sourceConversations = group.conversations;
    const openidA = getUserOpenid(userById.get(pair.userIdA));
    const openidB = getUserOpenid(userById.get(pair.userIdB));
    if (!openidA || !openidB) {
      issues.push({ code: 'PARTICIPANT_OPENID_MISSING', pairKey: pair.participantPairKey });
      return;
    }
    const groupMessages = sourceConversations.flatMap((conversation) => (
      messagesByConversation.get(normalizeText(conversation._id)) || []
    )).sort((left, right) => (
      toMillis(left.createdAt) - toMillis(right.createdAt)
      || normalizeText(left._id).localeCompare(normalizeText(right._id))
    ));
    const latestMessage = groupMessages[groupMessages.length - 1] || null;
    const contextSource = [...sourceConversations].sort((left, right) => (
      toMillis(latestDate(
        right.contextUpdatedAt,
        right.updatedAt,
        right.lastMessageAt,
        right.createdAt
      )) - toMillis(latestDate(
        left.contextUpdatedAt,
        left.updatedAt,
        left.lastMessageAt,
        left.createdAt
      ))
    ))[0];
    const lastProductId = normalizeText(
      contextSource.lastProductId || contextSource.productId
    );
    if (!PRODUCT_ID_PATTERN.test(lastProductId)) {
      issues.push({ code: 'CONTEXT_PRODUCT_MISSING', pairKey: pair.participantPairKey });
    }
    const product = productById.get(lastProductId);
    const productSnapshot = contextSource.lastProductSnapshot
      || contextSource.productSnapshot
      || (product ? {
        title: normalizeText(product.title),
        coverImage: normalizeText(product.coverImage)
          || normalizeText(Array.isArray(product.images) && product.images[0]),
        price: Number(product.price) || 0,
        status: normalizeText(product.status),
        ownerPublicUserId: normalizeText(product.sellerId)
      } : null);
    const unreadByUserId = new Map([[pair.userIdA, 0], [pair.userIdB, 0]]);
    sourceConversations.forEach((conversation) => {
      const ids = getConversationUserIds(conversation, userIdByOpenid);
      unreadByUserId.set(
        ids.participantAUserId,
        (unreadByUserId.get(ids.participantAUserId) || 0)
          + Math.max(0, Number(conversation.participantAUnreadCount) || 0)
      );
      unreadByUserId.set(
        ids.participantBUserId,
        (unreadByUserId.get(ids.participantBUserId) || 0)
          + Math.max(0, Number(conversation.participantBUnreadCount) || 0)
      );
    });
    const latestMessageTime = latestMessage && latestMessage.createdAt;
    const createdAt = earliestDate(sourceConversations.map((item) => item.createdAt));
    const updatedAt = latestDate(
      latestMessageTime,
      sourceConversations.map((item) => item.updatedAt),
      sourceConversations.map((item) => item.lastMessageAt)
    );
    const existingCanonical = conversationById.get(pair.conversationId) || null;
    const contextUpdatedAt = existingCanonical
      && normalizeText(existingCanonical.status || 'active') !== 'merged'
      && normalizeText(existingCanonical.participantPairKey) === pair.participantPairKey
      ? existingCanonical.contextUpdatedAt
      : latestDate(
        contextSource.contextUpdatedAt,
        contextSource.updatedAt,
        contextSource.lastMessageAt
      );
    const lastSenderOpenid = normalizeText(
      latestMessage && latestMessage.senderOpenid
    );
    const canonicalWrite = {
      exists: conversationById.has(pair.conversationId),
      before: conversationById.get(pair.conversationId) || null,
      document: {
        _id: pair.conversationId,
        participantPairKey: pair.participantPairKey,
        participantAUserId: pair.userIdA,
        participantBUserId: pair.userIdB,
        participantAOpenid: openidA,
        participantBOpenid: openidB,
        participantAUnreadCount: unreadByUserId.get(pair.userIdA) || 0,
        participantBUnreadCount: unreadByUserId.get(pair.userIdB) || 0,
        productId: lastProductId,
        productSnapshot,
        lastProductId,
        lastProductSnapshot: productSnapshot,
        lastMessage: messageSummary(latestMessage),
        lastMessageType: normalizeText(latestMessage && latestMessage.type),
        lastMessageAt: latestMessageTime || updatedAt || createdAt,
        lastSenderOpenid,
        contextUpdatedAt,
        status: 'active',
        schemaVersion: 2,
        createdAt,
        updatedAt: updatedAt || createdAt
      },
      sourceConversationIds: sourceConversations.map((item) => normalizeText(item._id))
    };
    if (
      canonicalWrite.before
      && normalizeText(canonicalWrite.before.status) === 'merged'
    ) {
      issues.push({
        code: 'CANONICAL_ID_OCCUPIED_BY_MERGED_ALIAS',
        canonicalConversationId: pair.conversationId
      });
    }
    canonicalStates.push(canonicalWrite);
    if (
      !canonicalWrite.exists
      || !documentsEquivalent(canonicalWrite.before, canonicalWrite.document)
    ) {
      canonicalWrites.push(canonicalWrite);
    }

    sourceConversations.forEach((conversation) => {
      const sourceId = normalizeText(conversation._id);
      if (sourceId !== pair.conversationId) {
        archives.push({
          conversationId: sourceId,
          canonicalConversationId: pair.conversationId,
          before: conversation
        });
      }
      (messagesByConversation.get(sourceId) || []).forEach((message) => {
        const contextProductId = normalizeText(
          message.contextProductId || message.productId
            || conversation.lastProductId || conversation.productId
        );
        if (!PRODUCT_ID_PATTERN.test(contextProductId)) {
          issues.push({ code: 'MESSAGE_CONTEXT_UNRESOLVED', messageId: normalizeText(message._id) });
        }
        const uniqueKey = [
          pair.conversationId,
          normalizeText(message.senderOpenid),
          normalizeText(message.clientMessageId)
        ].join(':');
        if (uniqueMessageKeys.has(uniqueKey)) {
          issues.push({ code: 'MESSAGE_UNIQUE_CONFLICT', messageId: normalizeText(message._id) });
        }
        uniqueMessageKeys.add(uniqueKey);
        const update = {
          messageId: normalizeText(message._id),
          beforeConversationId: sourceId,
          canonicalConversationId: pair.conversationId,
          beforeContextProductId: normalizeText(message.contextProductId),
          contextProductId
        };
        if (
          update.beforeConversationId !== update.canonicalConversationId
          || update.beforeContextProductId !== update.contextProductId
        ) {
          messageUpdates.push(update);
        }
      });
    });
  });

  appointments.forEach((appointment) => {
    const source = conversationById.get(normalizeText(appointment.conversationId));
    if (!source) return;
    const ids = getConversationUserIds(source, userIdByOpenid);
    const pair = createParticipantPair(ids.participantAUserId, ids.participantBUserId);
    if (!pair) return;
    const update = {
      appointmentId: normalizeText(appointment._id),
      beforeConversationId: normalizeText(appointment.conversationId),
      canonicalConversationId: pair.conversationId,
      productId: normalizeText(appointment.productId)
    };
    if (update.beforeConversationId !== update.canonicalConversationId) {
      appointmentUpdates.push(update);
    }
  });

  const blockingIssues = issues.filter((issue) => ![
    'CONTEXT_PRODUCT_MISSING'
  ].includes(issue.code));
  return {
    schemaVersion: 1,
    migrationId: normalizeText(options.migrationId)
      || `phase24_pair_${new Date().toISOString().replace(/[-:.TZ]/g, '')}`,
    generatedAt: new Date().toISOString(),
    canonicalWrites,
    canonicalStates,
    messageUpdates,
    appointmentUpdates,
    archives,
    issues,
    safeToApply: blockingIssues.length === 0,
    summary: {
      sourceConversations: conversations.length,
      logicalPairs: groups.size,
      duplicatePairs: [...groups.values()].filter((group) => group.conversations.length > 1).length,
      sourceMessages: messages.length,
      sourceAppointments: appointments.length,
      canonicalCreates: canonicalWrites.filter((item) => !item.exists).length,
      canonicalUpdates: canonicalWrites.filter((item) => item.exists).length,
      messageRepoints: messageUpdates.filter((item) => item.beforeConversationId !== item.canonicalConversationId).length,
      messageContextsBackfilled: messageUpdates.filter((item) => !item.beforeContextProductId).length,
      appointmentRepoints: appointmentUpdates.filter((item) => item.beforeConversationId !== item.canonicalConversationId).length,
      archivedAliases: archives.length,
      issues: issues.length
    }
  };
}

function publicPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    generatedAt: plan.generatedAt,
    safeToApply: plan.safeToApply,
    summary: plan.summary,
    issueCodes: plan.issues.reduce((counts, issue) => {
      counts[issue.code] = (counts[issue.code] || 0) + 1;
      return counts;
    }, {})
  };
}

module.exports = {
  USER_ID_PATTERN,
  CONVERSATION_ID_PATTERN,
  PRODUCT_ID_PATTERN,
  createParticipantPair,
  messageSummary,
  canonicalProjection,
  documentsEquivalent,
  buildMigrationPlan,
  publicPlan
};
