function delay(milliseconds) {
  const duration = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}

module.exports = {
  delay
};
