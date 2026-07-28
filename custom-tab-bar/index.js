const NavigationService = require('../services/navigation-service');
const AuthGuard = require('../services/auth-guard');
const {
  ROUTES,
  AUTH_TARGETS
} = require('../constants/routes');

Component({
  data: {
    selected: 'home'
  },

  methods: {
    async onHomeTap() {
      const allowed = await AuthGuard.requireMarketAccess({
        target: AUTH_TARGETS.HOME
      });
      if (allowed) {
        NavigationService.safeSwitchTab(ROUTES.HOME);
      }
    },

    async onPublishTap() {
      const allowed = await AuthGuard.requireLogin({
        target: AUTH_TARGETS.PUBLISH
      });
      if (allowed) {
        NavigationService.safeNavigateTo(ROUTES.PUBLISH);
      }
    },

    async onMessagesTap() {
      const allowed = await AuthGuard.requireLogin({
        target: AUTH_TARGETS.MESSAGES
      });
      if (allowed) {
        NavigationService.safeSwitchTab(ROUTES.MESSAGES);
      }
    },

    async onProfileTap() {
      const allowed = await AuthGuard.requireMarketAccess({
        target: AUTH_TARGETS.PROFILE
      });
      if (allowed) {
        NavigationService.safeSwitchTab(ROUTES.PROFILE);
      }
    }
  }
});
