const NavigationService = require('../services/navigation-service');
const { ROUTES } = require('../constants/routes');

Component({
  data: {
    selected: 'home'
  },

  methods: {
    onHomeTap() {
      NavigationService.safeSwitchTab(ROUTES.HOME);
    },

    onPublishTap() {
      NavigationService.safeNavigateTo(ROUTES.PUBLISH);
    },

    onMessagesTap() {
      NavigationService.safeSwitchTab(ROUTES.MESSAGES);
    },

    onProfileTap() {
      NavigationService.safeSwitchTab(ROUTES.PROFILE);
    }
  }
});
