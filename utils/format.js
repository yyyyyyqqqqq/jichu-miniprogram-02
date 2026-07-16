function formatPrice(value) {
  if (value === null || value === undefined || value === '') {
    return '--';
  }

  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) {
    return '--';
  }

  if (price === 0) {
    return '免费送';
  }

  const rounded = Math.round((price + Number.EPSILON) * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function formatDate(date) {
  return [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate())
  ].join('-');
}

function formatPublishedTime(isoTime, currentTime = new Date()) {
  const publishedDate = new Date(isoTime);
  const now = currentTime instanceof Date ? currentTime : new Date(currentTime);

  if (
    Number.isNaN(publishedDate.getTime())
    || Number.isNaN(now.getTime())
  ) {
    return '时间未知';
  }

  const difference = now.getTime() - publishedDate.getTime();
  if (difference < -60000) {
    return formatDate(publishedDate);
  }

  const safeDifference = Math.max(0, difference);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (safeDifference < minute) {
    return '刚刚';
  }
  if (safeDifference < hour) {
    return `${Math.floor(safeDifference / minute)}分钟前`;
  }
  if (safeDifference < day) {
    return `${Math.floor(safeDifference / hour)}小时前`;
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const publishedDay = new Date(
    publishedDate.getFullYear(),
    publishedDate.getMonth(),
    publishedDate.getDate()
  );
  const calendarDays = Math.floor((today.getTime() - publishedDay.getTime()) / day);

  if (calendarDays === 1) {
    return '昨天';
  }
  if (calendarDays > 1 && calendarDays < 7) {
    return `${calendarDays}天前`;
  }

  return formatDate(publishedDate);
}

function formatCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) {
    return '0';
  }

  const normalized = Math.floor(count);
  if (normalized >= 10000) {
    const amount = Math.round(normalized / 1000) / 10;
    return `${amount}万`;
  }
  if (normalized >= 1000) {
    const amount = Math.round(normalized / 100) / 10;
    return `${amount}k`;
  }
  return String(normalized);
}

module.exports = {
  formatPrice,
  formatPublishedTime,
  formatCount
};
