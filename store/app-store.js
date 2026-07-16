const state = {
  initialized: false,
  initializedAt: ''
};

function initialize() {
  if (state.initialized) {
    return getState();
  }

  state.initialized = true;
  state.initializedAt = new Date().toISOString();

  const app = getApp({ allowDefault: true });
  if (app && app.globalData) {
    app.globalData.initializedAt = state.initializedAt;
  }

  return getState();
}

function getState() {
  return {
    initialized: state.initialized,
    initializedAt: state.initializedAt
  };
}

module.exports = {
  initialize,
  getState
};
