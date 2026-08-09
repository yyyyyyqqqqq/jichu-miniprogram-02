const SCHOOL_ID_PATTERN = /^s_[a-f0-9]{32}$/;

function normalizeSchoolId(value) {
  const schoolId = typeof value === 'string' ? value.trim() : '';
  return SCHOOL_ID_PATTERN.test(schoolId) ? schoolId : '';
}

function normalizeSchoolVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function getSchoolScopeKey(user) {
  const source = user && typeof user === 'object' ? user : {};
  const userId = typeof source.id === 'string' ? source.id.trim() : '';
  return [
    userId,
    normalizeSchoolId(source.schoolId),
    normalizeSchoolVersion(source.schoolVersion)
  ].join(':');
}

function getSchoolVersionScopeKey(value) {
  const source = value && typeof value === 'object' ? value : {};
  return [
    normalizeSchoolId(source.schoolId),
    normalizeSchoolVersion(source.schoolVersion)
  ].join(':');
}

function decorateHistoricalProduct(product, user) {
  const source = product && typeof product === 'object' ? product : {};
  const currentSchoolId = normalizeSchoolId(user && user.schoolId);
  const productSchoolId = normalizeSchoolId(source.schoolId);
  const schoolRelationKnown = Boolean(currentSchoolId && productSchoolId);
  const isCrossSchool = schoolRelationKnown
    && currentSchoolId !== productSchoolId;
  return {
    ...source,
    schoolRelationKnown,
    isCrossSchool,
    schoolRelationText: isCrossSchool ? '其他学校商品' : ''
  };
}

function decorateConversation(conversation, user) {
  const source = conversation && typeof conversation === 'object'
    ? conversation
    : {};
  return {
    ...source,
    product: decorateHistoricalProduct(source.product, user)
  };
}

function decorateAppointment(appointment, user) {
  const source = appointment && typeof appointment === 'object'
    ? appointment
    : {};
  return {
    ...source,
    product: decorateHistoricalProduct(source.product, user)
  };
}

module.exports = {
  normalizeSchoolId,
  normalizeSchoolVersion,
  getSchoolScopeKey,
  getSchoolVersionScopeKey,
  decorateHistoricalProduct,
  decorateConversation,
  decorateAppointment
};
