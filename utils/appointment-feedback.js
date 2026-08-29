const AppointmentService = require('../services/appointment-service');

let crossSchoolModalVisible = false;

function showCreateFailure(error) {
  const feedback = AppointmentService.getCreateErrorFeedback(error);
  if (feedback.type !== 'modal') {
    wx.showToast({
      title: feedback.title,
      icon: feedback.icon,
      duration: feedback.duration
    });
    return 'toast';
  }
  if (crossSchoolModalVisible) {
    return 'modal';
  }
  crossSchoolModalVisible = true;
  try {
    wx.showModal({
      title: feedback.title,
      content: feedback.content,
      showCancel: feedback.showCancel,
      confirmText: feedback.confirmText,
      complete() {
        crossSchoolModalVisible = false;
      }
    });
  } catch (modalError) {
    crossSchoolModalVisible = false;
    throw modalError;
  }
  return 'modal';
}

function showCrossSchoolCreateForbidden() {
  return showCreateFailure({
    code: 'CROSS_SCHOOL_RELATION_FORBIDDEN'
  });
}

module.exports = {
  showCreateFailure,
  showCrossSchoolCreateForbidden
};
