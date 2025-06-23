/**
 * Centralized Logging Module
 * Provides consistent logging across all business modules
 * Based on Apps Script logging patterns
 */

const functions = require("firebase-functions");
const {LOG_ACTIONS} = require("./config");

/**
 * Log an informational message
 */
function logInfo(source, message, data = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: "INFO",
    source: source,
    message: message,
    data: data,
  };

  console.log(`[INFO] ${source}: ${message}`, data || "");
  return logEntry;
}

/**
 * Log a success message
 */
function logSuccess(source, message, count = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: "SUCCESS",
    source: source,
    message: message,
    count: count,
  };

  console.log(`[SUCCESS] ${source}: ${message}`, count ? `(${count} items)` : "");
  return logEntry;
}

/**
 * Log an error message
 */
function logError(source, message, error = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: "ERROR",
    source: source,
    message: message,
    error: error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : null,
  };

  console.error(`[ERROR] ${source}: ${message}`, error || "");
  return logEntry;
}

/**
 * Log start of process
 */
function logStart(source, processName) {
  return logInfo(source, `Starting ${processName}`);
}

/**
 * Log completion of process
 */
function logComplete(source, processName, duration = null) {
  const message = duration ?
    `Completed ${processName} in ${duration}ms` :
    `Completed ${processName}`;
  return logSuccess(source, message);
}

module.exports = {
  logInfo,
  logSuccess,
  logError,
  logStart,
  logComplete,
};
