'use strict';

const crypto = require('crypto');
const cloud = require('wx-server-sdk');
const nodemailer = require('nodemailer');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const FEEDBACKS_COLLECTION = 'feedbacks';
const RECIPIENT = '2915487801@qq.com';
const CONTENT_MAX_LENGTH = 1000;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 10;

const ERROR_CODES = Object.freeze({
  OK: 'OK',
  INVALID_ACTION: 'INVALID_ACTION',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CONTENT: 'INVALID_CONTENT',
  INVALID_REQUEST_ID: 'INVALID_REQUEST_ID',
  RATE_LIMITED: 'RATE_LIMITED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

function success(data) {
  return { success: true, code: ERROR_CODES.OK, message: '', data };
}

function failure(code, message) {
  return { success: false, code, message, data: null };
}

function businessError(code, message) {
  const error = new Error(message);
  error.businessCode = code;
  throw error;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeContent(value) {
  const content = normalizeText(value);
  if (!content || content.length > CONTENT_MAX_LENGTH) {
    businessError(ERROR_CODES.INVALID_CONTENT, '请输入 1～1000 个字符的反馈内容');
  }
  return content;
}

function createDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createFeedbackId(openId, requestId) {
  return `fb_${createDigest(`${openId}:${requestId}`)}`;
}

function normalizeDate(value) {
  if (value && typeof value === 'object' && value.$date) {
    return normalizeDate(value.$date);
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function queryDocumentById(collection, id) {
  const result = await collection.where({ _id: id }).limit(1).get();
  return result && Array.isArray(result.data) ? result.data[0] || null : null;
}

function assertRateLimit(records, now) {
  const timestamps = (Array.isArray(records) ? records : [])
    .map((record) => normalizeDate(record && record.createdAt))
    .filter(Boolean)
    .map((date) => date.getTime())
    .sort((left, right) => right - left);
  if (timestamps.length > 0 && now.getTime() - timestamps[0] < ONE_MINUTE_MS) {
    businessError(ERROR_CODES.RATE_LIMITED, '提交过于频繁，请稍后再试');
  }
  const dailyCount = timestamps.filter((value) => now.getTime() - value < ONE_DAY_MS).length;
  if (dailyCount >= DAILY_LIMIT) {
    businessError(ERROR_CODES.RATE_LIMITED, '今日反馈次数已达上限，请稍后再试');
  }
}

function readMailConfiguration(environment) {
  const host = normalizeText(environment.FEEDBACK_MAIL_HOST).toLowerCase();
  const port = Number(normalizeText(environment.FEEDBACK_MAIL_PORT));
  const user = normalizeText(environment.FEEDBACK_MAIL_USER);
  const secret = normalizeText(environment.FEEDBACK_MAIL_SECRET);
  if (!host || !port || !user || !secret) {
    return { ok: false, code: 'MAIL_CONFIG_MISSING' };
  }
  if (host !== 'smtp.qq.com' || port !== 465) {
    return { ok: false, code: 'MAIL_CONFIG_INVALID' };
  }
  return { ok: true, host, port, user, secret };
}

function normalizeEnvironmentName(value) {
  return normalizeText(value) === 'production' ? 'production' : 'staging';
}

function buildMail(feedback, environmentName, sender) {
  const isProduction = environmentName === 'production';
  const marker = isProduction ? 'PRODUCTION' : 'STAGING';
  return {
    from: sender,
    to: RECIPIENT,
    subject: isProduction ? '即出 - 新用户反馈' : '[STAGING] 即出 - 测试反馈',
    text: [
      `Environment: ${marker}`,
      `Feedback ID: ${feedback._id}`,
      `Submitted at: ${feedback.createdAt.toISOString()}`,
      '',
      'Content:',
      feedback.content
    ].join('\n')
  };
}

function classifyMailFailure(error) {
  const code = normalizeText(error && (error.code || error.errCode)).toUpperCase();
  if (['EAUTH', 'EENVELOPE'].includes(code)) return 'SMTP_AUTH_FAILED';
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET'].includes(code)) return 'SMTP_CONNECTION_FAILED';
  if (code === 'EMESSAGE') return 'SMTP_MESSAGE_REJECTED';
  return 'MAIL_SEND_FAILED';
}

async function deliverMail(feedback, dependencies) {
  const configuration = readMailConfiguration(dependencies.environment);
  if (!configuration.ok) {
    return { delivered: false, errorCode: configuration.code };
  }
  const environmentName = normalizeEnvironmentName(
    dependencies.environment.FEEDBACK_ENVIRONMENT
  );
  let transport;
  try {
    transport = dependencies.mailer.createTransport({
      host: configuration.host,
      port: configuration.port,
      secure: true,
      auth: { user: configuration.user, pass: configuration.secret },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
    await transport.sendMail(buildMail(feedback, environmentName, configuration.user));
    return { delivered: true, errorCode: '' };
  } catch (error) {
    return { delivered: false, errorCode: classifyMailFailure(error) };
  } finally {
    if (transport && typeof transport.close === 'function') transport.close();
  }
}

function createHandler(dependencies) {
  return async function handle(event = {}) {
    let diagnosticStage = 'request';
    const request = event && typeof event === 'object' && !Array.isArray(event)
      ? event
      : {};
    const action = normalizeText(request.action);
    if (action !== 'submit') {
      return failure(ERROR_CODES.INVALID_ACTION, '不支持的反馈操作');
    }

    const context = dependencies.getContext() || {};
    const openId = normalizeText(context.OPENID);
    if (!openId) {
      return failure(ERROR_CODES.UNAUTHORIZED, '请先登录后提交反馈');
    }

    try {
      diagnosticStage = 'validate';
      const content = normalizeContent(request.content);
      const suppliedRequestId = normalizeText(request.requestId);
      if (suppliedRequestId && !REQUEST_ID_PATTERN.test(suppliedRequestId)) {
        businessError(ERROR_CODES.INVALID_REQUEST_ID, '反馈请求参数不正确');
      }
      const requestId = suppliedRequestId
        || `server_${dependencies.randomBytes(18).toString('hex')}`;
      const feedbackId = createFeedbackId(openId, requestId);
      const now = dependencies.now();

      diagnosticStage = 'existing-read';
      const existingBeforeRateLimit = await queryDocumentById(
        dependencies.database.collection(FEEDBACKS_COLLECTION),
        feedbackId
      );
      if (existingBeforeRateLimit) {
        return success({
          accepted: true,
          feedbackId: existingBeforeRateLimit._id || feedbackId,
          notificationDelivered: existingBeforeRateLimit.mailStatus === 'sent',
          mailStatus: normalizeText(existingBeforeRateLimit.mailStatus) || 'pending',
          reused: true
        });
      }
      diagnosticStage = 'transaction';
      const transactionResult = await dependencies.database.runTransaction(async (transaction) => {
        const collection = transaction.collection(FEEDBACKS_COLLECTION);
        const document = collection.doc(feedbackId);
        const existing = await queryDocumentById(collection, feedbackId);
        if (existing) return { feedback: existing, reused: true };
        const recentResult = await collection.where({
          userOpenid: openId,
          createdAt: dependencies.command.gte(new Date(now.getTime() - ONE_DAY_MS))
        }).limit(DAILY_LIMIT).get();
        assertRateLimit(recentResult && recentResult.data, now);
        const feedback = {
          _id: feedbackId,
          userOpenid: openId,
          content,
          status: 'submitted',
          mailStatus: 'pending',
          createdAt: now,
          updatedAt: now
        };
        const storedFeedback = { ...feedback };
        delete storedFeedback._id;
        await document.set({ data: storedFeedback });
        return { feedback, reused: false };
      });
      const transactionValue = transactionResult
        && Object.prototype.hasOwnProperty.call(transactionResult, 'result')
        ? transactionResult.result
        : transactionResult;
      const feedback = transactionValue.feedback;
      if (transactionValue.reused) {
        return success({
          accepted: true,
          feedbackId: feedback._id,
          notificationDelivered: feedback.mailStatus === 'sent',
          mailStatus: normalizeText(feedback.mailStatus) || 'pending',
          reused: true
        });
      }

      diagnosticStage = 'mail';
      const delivery = await deliverMail(feedback, dependencies);
      const mailStatus = delivery.delivered ? 'sent' : 'failed';
      const mailPatch = { mailStatus, updatedAt: dependencies.now() };
      if (delivery.errorCode) mailPatch.mailLastErrorCode = delivery.errorCode;
      try {
        await dependencies.database.collection(FEEDBACKS_COLLECTION)
          .doc(feedback._id)
          .update({ data: mailPatch });
      } catch (_) {
        dependencies.logger.error('[feedbackAction] mail status update failed', {
          feedbackId: feedback._id,
          code: 'MAIL_STATUS_UPDATE_FAILED'
        });
      }
      if (!delivery.delivered) {
        dependencies.logger.error('[feedbackAction] notification not delivered', {
          feedbackId: feedback._id,
          code: delivery.errorCode
        });
      }
      return success({
        accepted: true,
        feedbackId: feedback._id,
        notificationDelivered: delivery.delivered,
        mailStatus,
        reused: false
      });
    } catch (error) {
      if (error && error.businessCode) {
        return failure(error.businessCode, error.message);
      }
      dependencies.logger.error('[feedbackAction] request failed', {
        action,
        stage: diagnosticStage,
        code: 'DATABASE_OR_INTERNAL_ERROR',
        errCode: normalizeText(error && (error.errCode || error.code || error.name))
      });
      return failure(ERROR_CODES.DATABASE_ERROR, '反馈暂时无法保存，请稍后再试');
    }
  };
}

const main = createHandler({
  database: db,
  command: db.command,
  getContext: () => cloud.getWXContext(),
  mailer: nodemailer,
  environment: process.env,
  now: () => new Date(),
  randomBytes: crypto.randomBytes,
  logger: console
});

exports.main = main;
exports.__test = Object.freeze({
  CONTENT_MAX_LENGTH,
  DAILY_LIMIT,
  ONE_MINUTE_MS,
  ONE_DAY_MS,
  RECIPIENT,
  normalizeContent,
  createFeedbackId,
  assertRateLimit,
  readMailConfiguration,
  normalizeEnvironmentName,
  buildMail,
  classifyMailFailure,
  createHandler
});
