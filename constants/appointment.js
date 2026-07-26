const APPOINTMENT_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed'
};

const APPOINTMENT_STATUS_META = {
  [APPOINTMENT_STATUS.PENDING]: {
    text: '待确认',
    className: 'pending'
  },
  [APPOINTMENT_STATUS.ACCEPTED]: {
    text: '已接受',
    className: 'accepted'
  },
  [APPOINTMENT_STATUS.REJECTED]: {
    text: '已拒绝',
    className: 'rejected'
  },
  [APPOINTMENT_STATUS.CANCELLED]: {
    text: '已取消',
    className: 'cancelled'
  },
  [APPOINTMENT_STATUS.COMPLETED]: {
    text: '已完成',
    className: 'completed'
  }
};

const APPOINTMENT_LIST_FILTER = {
  ALL: 'all',
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  ENDED: 'ended'
};

const APPOINTMENT_LIMITS = {
  NOTE_MAX_LENGTH: 200,
  LOCATION_NAME_MAX_LENGTH: 80,
  LOCATION_ADDRESS_MAX_LENGTH: 120,
  MAX_FUTURE_DAYS: 30
};

module.exports = {
  APPOINTMENT_STATUS,
  APPOINTMENT_STATUS_META,
  APPOINTMENT_LIST_FILTER,
  APPOINTMENT_LIMITS
};
