/**
 * Chaeban Business Automation - Main Cloud Functions
 * Entry point for all Firebase Cloud Functions
 */

const functions = require('firebase-functions');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logStart, logComplete, logError, logSuccess } = require('./modules/shared/logger');
const { DATA_SOURCES } = require('./modules/shared/config');

// Import inventory modules
const sosApi = require('./modules/inventory/sosApi');
const dataProcessor = require('./modules/inventory/dataProcessor');
const firestoreWriter = require('./modules/inventory/firestoreWriter');

/**
 * MANUAL EXECUTION: Run inventory snapshot manually
 * HTTP trigger for manual execution during testing/development
 * Usage: Call this endpoint to trigger inventory snapshot manually
 */
exports.runInventorySnapshot = onRequest({
  timeoutSeconds: 540, // 9 minutes
  memory: '1GiB'
}, async (req, res) => {
  const startTime = Date.now();
  logStart(DATA_SOURCES.SOS_INVENTORY, 'Manual inventory snapshot execution');
  
  try {
    // Execute the complete inventory snapshot process
    const result = await executeInventorySnapshot();
    
    const duration = Date.now() - startTime;
    logComplete(DATA_SOURCES.SOS_INVENTORY, 'manual inventory snapshot', duration);
    
    // Return success response
    res.status(200).json({
      success: true,
      message: 'Inventory snapshot completed successfully',
      data: {
        timestamp: result.timestamp,
        itemCount: result.itemCount,
        snapshotId: result.snapshotId,
        duration: duration
      }
    });
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Manual inventory snapshot failed', error);
    
    res.status(500).json({
      success: false,
      message: 'Inventory snapshot failed',
      error: error.message
    });
  }
});

/**
 * SCHEDULED EXECUTION: Daily automated inventory snapshot
 * Cloud Scheduler trigger for automated daily execution
 * Runs at 9 AM Eastern Time every day
 */
exports.scheduledInventorySnapshot = onSchedule({
  schedule: '0 9 * * *',
  timeZone: 'America/New_York',
  timeoutSeconds: 540, // 9 minutes
  memory: '1GiB'
}, async (event) => {
  const startTime = Date.now();
  logStart(DATA_SOURCES.SOS_INVENTORY, 'Scheduled daily inventory snapshot');
  
  try {
    // Execute the complete inventory snapshot process
    const result = await executeInventorySnapshot();
    
    const duration = Date.now() - startTime;
    logComplete(DATA_SOURCES.SOS_INVENTORY, 'scheduled inventory snapshot', duration);
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, 
      `Scheduled inventory snapshot completed: ${result.itemCount} items processed`);
    
    return result;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Scheduled inventory snapshot failed', error);
    throw error; // This will trigger Cloud Functions error alerting
  }
});

/**
 * DASHBOARD API: Get current inventory data
 * HTTP endpoint to serve dashboard data
 */
exports.getInventoryDashboardData = onRequest({
  timeoutSeconds: 120, // 2 minutes
  memory: '512MiB'
}, async (req, res) => {
  // Enable CORS for dashboard access
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  try {
    logStart(DATA_SOURCES.SOS_INVENTORY, 'Dashboard data request');
    
    // Get current inventory data
    const currentData = await firestoreWriter.getCurrentInventoryData();
    
    // Check if the current data request was successful
    if (!currentData.success) {
      logError(DATA_SOURCES.SOS_INVENTORY, 'Failed to get current inventory data', currentData.error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch dashboard data',
        error: currentData.error
      });
      return;
    }
    
    // Sort items for optimal display (exceptions first)
    if (currentData.data && currentData.data.items) {
      currentData.data.items = dataProcessor.sortItemsForDisplay(currentData.data.items);
    }
    
    // Get recent trend data (last 7 days)
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 7);
    
    try {
      const recentHistory = await firestoreWriter.getInventoryHistory(startDate, endDate, 7);
      
      logSuccess(DATA_SOURCES.SOS_INVENTORY, 'Dashboard data served successfully');
      
      res.status(200).json({
        success: true,
        data: {
          current: currentData.data,
          recent_history: recentHistory,
          last_updated: new Date().toISOString()
        }
      });
    } catch (historyError) {
      logError(DATA_SOURCES.SOS_INVENTORY, 'Failed to fetch recent history', historyError);
      
      // Still return current data even if history fails
      res.status(200).json({
        success: true,
        data: {
          current: currentData.data,
          recent_history: [],
          last_updated: new Date().toISOString()
        }
      });
    }
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Dashboard data request failed', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data',
      error: error.message
    });
  }
});

/**
 * TESTING API: Test SOS API connection
 * HTTP endpoint for testing SOS API connectivity
 */
exports.testSosConnection = onRequest({
  timeoutSeconds: 60, // 1 minute
  memory: '256MiB'
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  
  try {
    logStart(DATA_SOURCES.SOS_INVENTORY, 'SOS API connection test');
    
    const testResult = await sosApi.testSosApiConnection();
    
    res.status(200).json({
      success: true,
      message: 'SOS API connection test completed',
      data: testResult
    });
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'SOS API connection test failed', error);
    
    res.status(500).json({
      success: false,
      message: 'SOS API connection test failed',
      error: error.message
    });
  }
});

/**
 * TESTING API: Test Firestore connection
 * HTTP endpoint for testing Firestore connectivity
 */
exports.testFirestoreConnection = onRequest({
  timeoutSeconds: 60, // 1 minute
  memory: '256MiB'
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  
  try {
    const testResult = await firestoreWriter.testFirestoreConnection();
    
    res.status(200).json({
      success: true,
      message: 'Firestore connection test completed',
      data: testResult
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Firestore connection test failed',
      error: error.message
    });
  }
});

/**
 * Core inventory snapshot execution logic
 * Shared by both manual and scheduled triggers
 */
async function executeInventorySnapshot() {
  try {
    // Step 1: Fetch inventory data from SOS API
    logStart(DATA_SOURCES.SOS_INVENTORY, 'SOS API data fetch');
    const rawInventoryItems = await sosApi.fetchAllInventoryItems();
    
    if (!rawInventoryItems || rawInventoryItems.length === 0) {
      throw new Error('No inventory items retrieved from SOS API');
    }
    
    // Step 2: Process data with business logic
    logStart(DATA_SOURCES.SOS_INVENTORY, 'Business logic processing');
    const processedData = dataProcessor.processInventoryItems(rawInventoryItems);
    
    // Step 3: Write to Firestore
    logStart(DATA_SOURCES.SOS_INVENTORY, 'Firestore write operation');
    const writeResult = await firestoreWriter.writeInventorySnapshot(processedData);
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, 
      `Inventory snapshot completed: ${processedData.items.length} items processed`);
    
    return writeResult;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Inventory snapshot execution failed', error);
    throw error;
  }
}