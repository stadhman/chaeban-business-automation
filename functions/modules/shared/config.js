/**
 * Chaeban Business Automation - Configuration
 * All project-wide constants and configuration
 */

// Firestore Collection Names
const COLLECTIONS = {
  INVENTORY: {
    SNAPSHOTS: "inventory/snapshots",
    CURRENT: "inventory/current",
    METADATA: "inventory/metadata",
  },
  LOGS: "logs",
  USERS: "users",
};

// Data Source Names (for logging)
const DATA_SOURCES = {
  SOS_INVENTORY: "SOS_Inventory",
  SOS_ORDERS: "SOS_Orders",
  EMAIL_SHIPMENTS: "Email_Shipments",
};

// Log Action Types
const LOG_ACTIONS = {
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
  INFO: "INFO",
  START: "START",
  COMPLETE: "COMPLETE",
};

// SOS API Configuration (based on working Apps Script system)
const SOS_CONFIG = {
    BASE_URL: 'https://api.sosinventory.com/api/v2',
    ITEM_ENDPOINT: '/item',
    ORDER_ENDPOINT: '/salesorder',
    PAGE_SIZE: 500,
    TIMEOUT_SECONDS: 180,
    MAX_RETRIES: 3,
    THROTTLE_WAIT_MS: 30000,
    RATE_LIMIT_MS: 100,
    CONCURRENT_REQUESTS: 3,
    BATCH_SIZE: 250
};

// Business Logic Constants
const INVENTORY_STATUS = {
  OK: "OK",
  NEGATIVE_QUANTITY: "NEGATIVE_QUANTITY",
  NEGATIVE_AVAILABLE: "NEGATIVE_AVAILABLE",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
  NO_COST_BASIS: "NO_COST_BASIS",
};

// Firebase Environment Variables (to be set in Firebase Console)
const ENV_VARS = {
  SOS_API_KEY: "SOS_API_KEY",
  SOS_API_SECRET: "SOS_API_SECRET", // If needed
};

module.exports = {
  COLLECTIONS,
  DATA_SOURCES,
  LOG_ACTIONS,
  SOS_CONFIG,
  INVENTORY_STATUS,
  ENV_VARS,
};
