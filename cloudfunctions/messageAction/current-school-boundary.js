'use strict';

const SCHOOL_ID_PATTERN = /^s_[0-9a-f]{32}$/;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isActiveUser(user, expectedOpenid) {
  return Boolean(
    user
    && user.status === 'active'
    && normalizeString(user.openid) === normalizeString(expectedOpenid)
  );
}

function canCreateCurrentSchoolRelation({
  buyer,
  buyerOpenid,
  seller,
  sellerOpenid,
  product,
  school
} = {}) {
  const buyerSchoolId = normalizeString(buyer && buyer.schoolId);
  const sellerSchoolId = normalizeString(seller && seller.schoolId);
  const productSchoolId = normalizeString(product && product.schoolId);
  const schoolId = normalizeString(school && school._id) || productSchoolId;
  return Boolean(
    isActiveUser(buyer, buyerOpenid)
    && isActiveUser(seller, sellerOpenid)
    && SCHOOL_ID_PATTERN.test(buyerSchoolId)
    && SCHOOL_ID_PATTERN.test(sellerSchoolId)
    && SCHOOL_ID_PATTERN.test(productSchoolId)
    && SCHOOL_ID_PATTERN.test(schoolId)
    && buyerSchoolId === productSchoolId
    && sellerSchoolId === productSchoolId
    && schoolId === productSchoolId
    && school
    && school.platformStatus === 'active'
    && school.officialStatus === 'valid'
  );
}

module.exports = Object.freeze({
  canCreateCurrentSchoolRelation
});
