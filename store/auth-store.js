let currentUser = null;

function getCurrentUser() {
  return currentUser;
}

function isLoggedIn() {
  return Boolean(currentUser);
}

module.exports = {
  getCurrentUser,
  isLoggedIn
};
