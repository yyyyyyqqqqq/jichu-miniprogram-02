const DEFAULT_USER_NICKNAME = '校园用户';
const DEFAULT_USER_AVATAR_TEXT = '校';
const LEGACY_PLACEHOLDER_NICKNAMES = new Set([
  '微信用户',
  '即出用户',
  '匿名用户'
]);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeUserNickname(value) {
  const nickname = normalizeText(value);
  return nickname && !LEGACY_PLACEHOLDER_NICKNAMES.has(nickname)
    ? nickname
    : DEFAULT_USER_NICKNAME;
}

function normalizeUserAvatarUrl(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildUserPresentation(value = {}) {
  const user = value && typeof value === 'object' ? value : {};
  const nickname = normalizeUserNickname(user.nickname);
  const avatarUrl = normalizeUserAvatarUrl(user.avatarUrl || user.avatar);
  return {
    nickname,
    avatarUrl,
    avatarText: nickname.slice(0, 1) || DEFAULT_USER_AVATAR_TEXT,
    usesDefaultNickname: nickname === DEFAULT_USER_NICKNAME,
    usesDefaultAvatar: !avatarUrl
  };
}

module.exports = {
  DEFAULT_USER_NICKNAME,
  DEFAULT_USER_AVATAR_TEXT,
  normalizeUserNickname,
  normalizeUserAvatarUrl,
  buildUserPresentation
};
