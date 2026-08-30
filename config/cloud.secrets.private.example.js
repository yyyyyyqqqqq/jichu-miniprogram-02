module.exports = {
  staging: {
    productQueryCursorHmacSecret: 'YOUR_STAGING_PRODUCT_QUERY_CURSOR_HMAC_SECRET',
    FEEDBACK_MAIL_HOST: 'smtp.qq.com',
    FEEDBACK_MAIL_PORT: '465',
    FEEDBACK_MAIL_USER: '',
    FEEDBACK_MAIL_SECRET: ''
  },
  production: {
    FEEDBACK_MAIL_HOST: 'smtp.qq.com',
    FEEDBACK_MAIL_PORT: '465',
    FEEDBACK_MAIL_USER: '',
    FEEDBACK_MAIL_SECRET: ''
  }
};
