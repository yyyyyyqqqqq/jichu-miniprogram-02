const state = {
  initialized: false,
  initializedAt: '',
  productsVersion: 0,
  favoritesVersion: 0
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
    productsVersion: state.productsVersion,
    favoritesVersion: state.favoritesVersion
  };
}

function markProductsChanged() {
  state.productsVersion += 1;
  return state.productsVersion;
}

function getProductsVersion() {
  return state.productsVersion;
}

function markFavoritesChanged() {
  state.favoritesVersion += 1;
  state.productsVersion += 1;
  return state.favoritesVersion;
}

function getFavoritesVersion() {
  return state.favoritesVersion;
}

module.exports = {
  initialize,
  getState,
  markProductsChanged,
  getProductsVersion,
  markFavoritesChanged,
  getFavoritesVersion
};
