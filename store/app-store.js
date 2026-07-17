const state = {
  initialized: false,
  initializedAt: '',
  productsVersion: 0
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
    initializedAt: state.initializedAt,
    productsVersion: state.productsVersion
  };
}

function markProductsChanged() {
  state.productsVersion += 1;
  return state.productsVersion;
}

function getProductsVersion() {
  return state.productsVersion;
}

module.exports = {
  initialize,
  getState,
  markProductsChanged,
  getProductsVersion
};
