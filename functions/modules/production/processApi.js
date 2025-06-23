// modules/production/processApi.js
// SOS Process API integration following inventory module patterns

const { SOS_CONFIG } = require('../shared/config');
const { logInfo, logError, logWarning } = require('../shared/logger');

// SOS API Key (same as used in sosApi.js)
const sosApiKey = "W-L1wrdxOqlL4SaJv2K5JPPEqr7_w4Em3uG3YEYBjlyIVtfuqxwHCnU5-xp39-lDMOaISCKXwiG5mt1PuTOTo7luX85AjyNRD6A0kjQrwvLO8IscWhLFLvkunVfEbHvCh1m7KoiscSJnWQwWVBlPYaAqAwKMRAaclyIqi2Ln3FT6tcXCDgXxhnRrTh7cW5041MRkwjmuhoa0AIPpY_BjObzQvaHWksMcMQNCgkdXnALxfvjClB4sw5PhA0InGpB8tY2UkvJmeT0rQnvfbl7JaYe9W4JOm08ffCdmVeyq1gKFhNcW";

/**
 * Fetch process transactions from SOS API with pagination
 * @param {string} startDate - ISO date string (e.g., '2025-06-20')
 * @param {string} endDate - ISO date string (e.g., '2025-06-21')
 * @returns {Array} Array of process transaction objects
 */
async function fetchProcessTransactions(startDate, endDate) {
  const allTransactions = [];
  let start = 0;
  let hasMore = true;

  logInfo(`Fetching process transactions from ${startDate} to ${endDate}`);

  while (hasMore) {
    try {
      const url = `${SOS_CONFIG.BASE_URL}/process`;
      const params = new URLSearchParams({
        start: start.toString(),
        maxresults: SOS_CONFIG.PAGE_SIZE.toString(),
        archived: 'false'
        // Temporarily removing date filters for testing
        // from: `${startDate}T00:00:00`,
        // to: `${endDate}T23:59:59`
      });

      logInfo(`Fetching process page: start=${start}, size=${SOS_CONFIG.PAGE_SIZE}`);

      const response = await fetch(`${url}?${params}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sosApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: SOS_CONFIG.TIMEOUT_SECONDS * 1000
      });

      if (!response.ok) {
        if (response.status === 429) {
          logWarning('Rate limited, waiting 30 seconds...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue;
        }
        throw new Error(`SOS Process API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Extract items from response (handle different response structures)
      const items = data.data || data.items || data;
      const totalCount = data.totalCount || data.total || 0;
      
      // Log first transaction structure for analysis
      if (start === 0 && Array.isArray(items) && items.length > 0) {
        logInfo('Sample process transaction structure:');
        logInfo(JSON.stringify(items[0], null, 2));
      }

      // Only spread if items is an array
      if (Array.isArray(items)) {
        allTransactions.push(...items);
      } else {
        logWarning('API response is not an array:', typeof items);
        logWarning('Response structure:', JSON.stringify(data, null, 2));
      }
      
      hasMore = Array.isArray(items) && items.length === SOS_CONFIG.PAGE_SIZE;
      start += SOS_CONFIG.PAGE_SIZE;

      logInfo(`Fetched ${Array.isArray(items) ? items.length : 0} transactions, total: ${allTransactions.length}`);

      // Rate limiting between requests
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, SOS_CONFIG.RATE_LIMIT_MS));
      }

    } catch (error) {
      logError('Error fetching process transactions:', error);
      throw error;
    }
  }

  logInfo(`Total process transactions fetched: ${allTransactions.length}`);
  return allTransactions;
}

/**
 * Fetch yesterday's process transactions
 * @returns {Array} Array of process transaction objects
 */
async function fetchYesterdayProcesses() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];
  
  return await fetchProcessTransactions(dateStr, dateStr);
}

/**
 * Fetch process transactions for a date range
 * @param {number} daysBack - Number of days back from today
 * @returns {Array} Array of process transaction objects
 */
async function fetchRecentProcesses(daysBack = 15) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);
  
  const endDateStr = endDate.toISOString().split('T')[0];
  const startDateStr = startDate.toISOString().split('T')[0];
  
  return await fetchProcessTransactions(startDateStr, endDateStr);
}

/**
 * Fetch specific date range for production analysis
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Array} Filtered and validated process transactions
 */
async function fetchProductionData(startDate, endDate) {
  try {
    const transactions = await fetchProcessTransactions(startDate, endDate);
    
    // Filter for valid production transactions
    const validTransactions = transactions.filter(transaction => {
      return transaction.outputs && 
             transaction.outputs.length > 0 && 
             !transaction.archived;
    });

    logInfo(`Filtered ${validTransactions.length} valid production transactions from ${transactions.length} total`);
    return validTransactions;

  } catch (error) {
    logError('Error fetching production data:', error);
    throw error;
  }
}

/**
 * Simple test function to verify SOS Process API connection
 * @returns {Object} Connection test results
 */
async function testProcessAPI() {
  try {
    logInfo('Testing SOS Process API connection (NO DATE FILTER)...');
    
    // The date range here will be ignored for the test
    const startDate = '2025-06-16';
    const endDate = '2025-06-19';
    
    const transactions = await fetchProcessTransactions(startDate, endDate);
    
    logInfo(`Process API test successful: ${transactions.length} transactions found`);
    
    return {
      success: true,
      transactionCount: transactions.length,
      sampleTransaction: transactions[0] || null,
      testDescription: 'Fetched most recent transactions without any date filter.'
    };
    
  } catch (error) {
    logError('Process API test failed:', error);
    throw error;
  }
}

module.exports = {
  fetchProcessTransactions,
  fetchYesterdayProcesses,
  fetchRecentProcesses,
  fetchProductionData,
  testProcessAPI
};