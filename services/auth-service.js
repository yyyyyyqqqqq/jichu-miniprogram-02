const AuthStore = require('../store/auth-store');

function getCurrentUser() {
  return AuthStore.getCurrentUser();
}

function isLoggedIn() {
  return AuthStore.isLoggedIn();
}

module.exports = {
  getCurrentUser,
  isLoggedIn
};
