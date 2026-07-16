function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) {
    return '0';
  }
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

module.exports = {
  formatPrice
};
