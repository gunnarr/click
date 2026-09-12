// Error rate tracking with a sliding time window.

const _errorTimestamps = [];
const ERROR_WINDOW = 300_000; // 5 minutes in ms
const ERROR_THRESHOLD = 10;

function recordError() {
  _errorTimestamps.push(Date.now());
}

function getErrorRate() {
  const cutoff = Date.now() - ERROR_WINDOW;
  while (_errorTimestamps.length && _errorTimestamps[0] < cutoff) {
    _errorTimestamps.shift();
  }
  return _errorTimestamps.length;
}

// Reset state (for testing only).
function _reset() {
  _errorTimestamps.length = 0;
}

// Inject a timestamp directly (for testing time-dependent behavior).
function _pushTimestamp(ts) {
  _errorTimestamps.push(ts);
}

module.exports = {
  recordError,
  getErrorRate,
  ERROR_WINDOW,
  ERROR_THRESHOLD,
  _reset,
  _pushTimestamp,
};
