/**
 * SOS Inventory API Integration Module
 * Handles all SOS API communication with proper error handling and rate limiting
 * Based on proven Apps Script patterns
 */

const functions = require('firebase-functions');
const axios = require('axios');
const { SOS_CONFIG, DATA_SOURCES } = require('../shared/config');
const { logInfo, logError, logSuccess } = require('../shared/logger');

/**
 * Fetch all inventory items from SOS API with parallel pagination
 * Implements controlled concurrency for better performance
 */
async function fetchAllInventoryItems() {
  logInfo(DATA_SOURCES.SOS_INVENTORY, 'Starting to fetch all inventory items');
  
  try {
    // First, get total count to calculate number of pages
    const initialPage = await fetchInventoryPage(0, SOS_CONFIG.PAGE_SIZE);
    const totalItems = initialPage.totalCount;
    const totalPages = Math.ceil(totalItems / SOS_CONFIG.PAGE_SIZE);
    
    logInfo(DATA_SOURCES.SOS_INVENTORY, `Total items: ${totalItems}, Pages: ${totalPages}`);
    
    // Start with items from first page
    const allItems = [...initialPage.items];
    
    // Process remaining pages in parallel with controlled concurrency
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
    const chunks = [];
    
    // Split pages into chunks for controlled concurrency
    for (let i = 0; i < remainingPages.length; i += SOS_CONFIG.CONCURRENT_REQUESTS) {
      chunks.push(remainingPages.slice(i, i + SOS_CONFIG.CONCURRENT_REQUESTS));
    }
    
    // Process each chunk of pages
    for (const chunk of chunks) {
      const pagePromises = chunk.map(async (pageNum) => {
        const start = pageNum * SOS_CONFIG.PAGE_SIZE;
        // Add small delay between requests in same chunk
        await sleep(Math.random() * SOS_CONFIG.RATE_LIMIT_MS);
        return fetchInventoryPage(start, SOS_CONFIG.PAGE_SIZE);
      });
      
      const results = await Promise.all(pagePromises);
      
      // Add items from this chunk
      results.forEach(result => {
        if (result && result.items) {
          allItems.push(...result.items);
          logInfo(DATA_SOURCES.SOS_INVENTORY, 
            `Fetched ${result.items.length} items (total: ${allItems.length}/${totalItems})`);
        }
      });
      
      // Add delay between chunks to prevent rate limiting
      if (chunks.indexOf(chunk) < chunks.length - 1) {
        await sleep(SOS_CONFIG.RATE_LIMIT_MS * 2);
      }
    }
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, 'Successfully fetched all inventory items', allItems.length);
    return allItems;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Failed to fetch all inventory items', error);
    throw error;
  }
}

/**
 * Fetch a single page of inventory items from SOS API
 * Handles authentication, error handling, and response parsing
 */
async function fetchInventoryPage(start = 0, maxResults = 200) {
    const sosApiKey = "W-L1wrdxOqlL4SaJv2K5JPPEqr7_w4Em3uG3YEYBjlyIVtfuqxwHCnU5-xp39-lDMOaISCKXwiG5mt1PuTOTo7luX85AjyNRD6A0kjQrwvLO8IscWhLFLvkunVfEbHvCh1m7KoiscSJnWQwWVBlPYaAqAwKMRAaclyIqi2Ln3FT6tcXCDgXxhnRrTh7cW5041MRkwjmuhoa0AIPpY_BjObzQvaHWksMcMQNCgkdXnALxfvjClB4sw5PhA0InGpB8tY2UkvJmeT0rQnvfbl7JaYe9W4JOm08ffCdmVeyq1gKFhNcW";
  
  if (!sosApiKey) {
    throw new Error('SOS API key not configured. Run: firebase functions:config:set sos.api_key="your_key"');
  }
  
  const requestConfig = {
    method: 'GET',
    url: `${SOS_CONFIG.BASE_URL}${SOS_CONFIG.ITEM_ENDPOINT}`,
    headers: {
      'Authorization': `Bearer ${sosApiKey}`,
      'Content-Type': 'application/json'
    },
    params: {
      start: start,
      maxresults: maxResults,
      archived: 'false' // Only active items
    },
    timeout: SOS_CONFIG.TIMEOUT_SECONDS * 1000
  };
  
  try {
    logInfo(DATA_SOURCES.SOS_INVENTORY, `Fetching items from start: ${start}, max: ${maxResults}`);
    
    const response = await axios(requestConfig);
    
    if (response.status === 200 && response.data) {
      const items = response.data.data || response.data.items || response.data;
      const totalCount = response.data.totalCount || response.data.total || 0;
      
      // Add detailed logging of the first item
      if (Array.isArray(items) && items.length > 0) {
        const firstItem = items[0];
        logInfo(DATA_SOURCES.SOS_INVENTORY, 'Sample item structure:', {
          id: firstItem.id,
          sku: firstItem.sku,
          name: firstItem.name,
          hasId: !!firstItem.id,
          hasSku: !!firstItem.sku,
          rawKeys: Object.keys(firstItem)
        });
      }
      
      // Validate items have required fields
      if (Array.isArray(items)) {
        const invalidItems = items.filter(item => !item.id && !item.sku);
        if (invalidItems.length > 0) {
          logError(DATA_SOURCES.SOS_INVENTORY, 
            `Found ${invalidItems.length} items without ID or SKU in page starting at ${start}`);
        }
      }
      
      return {
        items: Array.isArray(items) ? items : [],
        totalCount: totalCount,
        hasMore: (start + maxResults) < totalCount,
        currentStart: start
      };
    } else {
      throw new Error(`Unexpected SOS API response: ${response.status}`);
    }
    
  } catch (error) {
    // Handle specific error cases
    if (error.response) {
      // SOS API returned an error response
      const status = error.response.status;
      const message = (error.response.data && error.response.data.message) || error.response.statusText;
      
      if (status === 429) {
        // Rate limit hit - wait and retry
        logInfo(DATA_SOURCES.SOS_INVENTORY, 'Rate limit hit, waiting before retry');
        await sleep(SOS_CONFIG.THROTTLE_WAIT_MS);
        throw new Error(`SOS API rate limit: ${message}`);
      } else if (status === 401) {
        throw new Error('SOS API authentication failed - check API key');
      } else {
        throw new Error(`SOS API error (${status}): ${message}`);
      }
    } else if (error.request) {
      // Network error
      throw new Error(`Network error connecting to SOS API: ${error.message}`);
    } else {
      // Other error
      throw new Error(`SOS API request failed: ${error.message}`);
    }
  }
}

/**
 * Test SOS API connection with a small request
 * Useful for debugging and validation
 */
async function testSosApiConnection() {
  logInfo(DATA_SOURCES.SOS_INVENTORY, 'Testing SOS API connection');
  
  try {
    const testResult = await fetchInventoryPage(0, 5);
    
    if (testResult && testResult.items && testResult.items.length > 0) {
      logSuccess(DATA_SOURCES.SOS_INVENTORY, 'SOS API connection test successful', testResult.items.length);
      
      // Log first item structure for debugging
      console.log('Sample SOS item structure:', JSON.stringify(testResult.items[0], null, 2));
      
      return {
        success: true,
        itemCount: testResult.items.length,
        totalCount: testResult.totalCount,
        sampleItem: testResult.items[0]
      };
    } else {
      throw new Error('SOS API test returned no data');
    }
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'SOS API connection test failed', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Utility function to pause execution
 * Used for rate limiting between API calls
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate SOS item data structure
 * Ensures we have the required fields for processing
 */
function validateSosItem(item) {
  const requiredFields = ['id', 'sku', 'name'];
  const missingFields = requiredFields.filter(field => !item[field]);
  
  if (missingFields.length > 0) {
    logError(DATA_SOURCES.SOS_INVENTORY, `SOS item missing required fields: ${missingFields.join(', ')}`, item);
    return false;
  }
  
  return true;
}

module.exports = {
  fetchAllInventoryItems,
  fetchInventoryPage,
  testSosApiConnection,
  validateSosItem
};