let navigationLocked = false;

function getCurrentRoute() {
  const pages = getCurrentPages();
  const currentPage = pages[pages.length - 1];
  return currentPage ? `/${currentPage.route}` : '';
}

function unlock() {
  navigationLocked = false;
}

function runNavigation(method, url) {
  if (navigationLocked || !url) {
    return Promise.resolve(false);
  }

  if (getCurrentRoute() === url.split('?')[0]) {
    return Promise.resolve(false);
  }

  navigationLocked = true;
  return new Promise((resolve) => {
    wx[method]({
      url,
      success() {
        resolve(true);
      },
      fail() {
        resolve(false);
      },
      complete() {
        unlock();
      }
    });
  });
}

function safeNavigateTo(url) {
  return runNavigation('navigateTo', url);
}

function safeSwitchTab(url) {
  return runNavigation('switchTab', url);
}

module.exports = {
  getCurrentRoute,
  safeNavigateTo,
  safeSwitchTab
};
