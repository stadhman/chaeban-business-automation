/**
 * Inventory Data Processing Module
 * Handles business logic calculations and data transformations
 * Based on proven Apps Script mapItemToHistoricalRow patterns
 */

const {INVENTORY_STATUS, DATA_SOURCES} = require("../shared/config");
const {logInfo, logError, logSuccess} = require("../shared/logger");

/**
 * Process raw SOS inventory items into standardized format
 * Replicates mapItemToHistoricalRow() function from Apps Script
 */
function processInventoryItems(rawItems, fetchTimestamp = null) {
  logInfo(DATA_SOURCES.SOS_INVENTORY, "Processing inventory items with business logic");

  const timestamp = fetchTimestamp || new Date();
  const processedItems = [];
  const statusCounts = {
    [INVENTORY_STATUS.OK]: 0,
    [INVENTORY_STATUS.NEGATIVE_QUANTITY]: 0,
    [INVENTORY_STATUS.NEGATIVE_AVAILABLE]: 0,
    [INVENTORY_STATUS.NEGATIVE_VALUE]: 0,
    [INVENTORY_STATUS.NO_COST_BASIS]: 0,
  };

  try {
    // Validate input
    if (!Array.isArray(rawItems)) {
      throw new Error(`Expected array of items, got ${typeof rawItems}`);
    }

    if (rawItems.length === 0) {
      throw new Error('No items to process');
    }

    // Log sample of raw items
    logInfo(DATA_SOURCES.SOS_INVENTORY, 'Sample raw items:', {
      totalItems: rawItems.length,
      sampleItem: rawItems[0],
      itemKeys: Object.keys(rawItems[0])
    });

    // Track invalid items
    const invalidItems = [];
    let processedCount = 0;

    for (const rawItem of rawItems) {
      try {
        // Basic validation
        if (!rawItem) {
          invalidItems.push({ error: 'null or undefined item' });
          continue;
        }

        // Check for required fields
        if (!rawItem.id && !rawItem.sku) {
          invalidItems.push({
            error: 'missing both ID and SKU',
            item: rawItem
          });
          continue;
        }

        const processedItem = processInventoryItem(rawItem, timestamp);
        if (processedItem) {
          processedItems.push(processedItem);
          statusCounts[processedItem.status]++;
          processedCount++;
        } else {
          invalidItems.push({
            error: 'processing returned null',
            item: rawItem
          });
        }
      } catch (itemError) {
        invalidItems.push({
          error: itemError.message,
          item: rawItem
        });
      }
    }

    // Log processing results
    logInfo(DATA_SOURCES.SOS_INVENTORY, 'Processing results:', {
      totalItems: rawItems.length,
      processedCount,
      invalidCount: invalidItems.length,
      statusCounts
    });

    if (invalidItems.length > 0) {
      logError(DATA_SOURCES.SOS_INVENTORY, 
        `Found ${invalidItems.length} invalid items during processing`,
        invalidItems.slice(0, 5) // Log first 5 invalid items
      );
    }

    if (processedItems.length === 0) {
      throw new Error('No valid items were processed');
    }

    logSuccess(DATA_SOURCES.SOS_INVENTORY, "Successfully processed inventory items", processedItems.length);

    return {
      items: processedItems,
      summary: {
        total_items: processedItems.length,
        total_value: calculateTotalValue(processedItems),
        timestamp: timestamp,
        status_counts: statusCounts,
        invalid_items_count: invalidItems.length
      },
    };
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, "Failed to process inventory items", error);
    throw error;
  }
}

/**
 * Process a single inventory item with business logic
 * Exact replication of Apps Script business logic
 */
function processInventoryItem(rawItem, timestamp) {
  try {
    // Extract and validate numeric values with defaults
    const onHand = parseFloat(rawItem.onhand) || 0;
    const available = parseFloat(rawItem.available) || 0;
    const costBasis = parseFloat(rawItem.costBasis) || 0;

    // Calculate average cost (exact Apps Script logic)
    const avgCost = (onHand > 0 && costBasis > 0) ? costBasis / onHand : 0;

    // Determine status using exact Apps Script logic
    let status = INVENTORY_STATUS.OK;
    if (onHand < 0) {
      status = INVENTORY_STATUS.NEGATIVE_QUANTITY;
    } else if (available < 0) {
      status = INVENTORY_STATUS.NEGATIVE_AVAILABLE;
    } else if (costBasis < 0) {
      status = INVENTORY_STATUS.NEGATIVE_VALUE;
    } else if (onHand > 0 && costBasis <= 0) {
      status = INVENTORY_STATUS.NO_COST_BASIS;
    }

    // Generate a valid document ID
    let itemId = null;
    
    // Try to use existing ID first
    if (rawItem.id && typeof rawItem.id === 'string' && rawItem.id.trim() !== '') {
      itemId = rawItem.id.trim();
    }
    // Try SKU next
    else if (rawItem.sku && typeof rawItem.sku === 'string' && rawItem.sku.trim() !== '') {
      itemId = `sku_${rawItem.sku.trim()}`;
    }
    // Generate a unique ID as last resort
    else {
      const timestampStr = timestamp.getTime().toString(36);
      const randomStr = Math.random().toString(36).substring(2, 8);
      itemId = `item_${timestampStr}_${randomStr}`;
    }

    // Validate the generated ID
    if (!itemId || typeof itemId !== 'string' || itemId.trim() === '') {
      throw new Error('Failed to generate valid item ID');
    }

    // Sanitize the ID to ensure it's Firestore-safe
    itemId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');

    // Safely handle category
    let category = '';
    if (rawItem.category) {
      if (typeof rawItem.category === 'string') {
        category = rawItem.category.trim();
      } else if (typeof rawItem.category === 'number') {
        category = rawItem.category.toString();
      } else {
        category = 'Uncategorized';
      }
    }

    // Return processed item in standardized format
    return {
      item_id: itemId,
      sku: rawItem.sku || "",
      name: rawItem.name || "",
      full_name: rawItem.fullname || rawItem.name || "",
      qty_on_hand: onHand,
      qty_available: available,
      cost_basis: costBasis,
      average_cost: avgCost,
      category: category,
      status: status,
      last_updated: timestamp,
      // Additional metadata for debugging
      _raw_onhand: rawItem.onhand,
      _raw_available: rawItem.available,
      _raw_costBasis: rawItem.costBasis,
      _raw_id: rawItem.id || null,
      _raw_category: rawItem.category || null,
      _id_source: rawItem.id ? 'original_id' : (rawItem.sku ? 'sku' : 'generated')
    };
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 
      `Failed to process item ${rawItem.id || rawItem.sku || "unknown"}: ${error.message}`,
      { rawItem }
    );
    return null;
  }
}

/**
 * Calculate total inventory value from processed items
 */
function calculateTotalValue(processedItems) {
  return processedItems.reduce((total, item) => {
    return total + (item.cost_basis || 0);
  }, 0);
}

/**
 * Generate summary statistics for processed inventory
 */
function generateInventorySummary(processedItems, timestamp = null) {
  const summary = {
    timestamp: timestamp || new Date(),
    total_items: processedItems.length,
    total_value: calculateTotalValue(processedItems),
    status_counts: {},
    category_breakdown: {},
    value_by_category: {},
  };

  // Calculate status distribution
  for (const status of Object.values(INVENTORY_STATUS)) {
    summary.status_counts[status] = 0;
  }

  // Process each item for summary statistics
  processedItems.forEach((item) => {
    // Status counts
    summary.status_counts[item.status]++;

    // Category breakdown
    const category = item.category || "Uncategorized";
    if (!summary.category_breakdown[category]) {
      summary.category_breakdown[category] = 0;
      summary.value_by_category[category] = 0;
    }
    summary.category_breakdown[category]++;
    summary.value_by_category[category] += item.cost_basis || 0;
  });

  return summary;
}

/**
 * Filter items by status for exception reporting
 */
function getItemsByStatus(processedItems, status) {
  return processedItems.filter((item) => item.status === status);
}

/**
 * Get all exception items (non-OK status)
 */
function getExceptionItems(processedItems) {
  return processedItems.filter((item) => item.status !== INVENTORY_STATUS.OK);
}

/**
 * Validate processed item data structure
 */
function validateProcessedItem(item) {
  const requiredFields = ["item_id", "sku", "qty_on_hand", "cost_basis", "status"];
  const missingFields = requiredFields.filter((field) =>
    item[field] === undefined || item[field] === null,
  );

  if (missingFields.length > 0) {
    logError(DATA_SOURCES.SOS_INVENTORY,
        `Processed item missing required fields: ${missingFields.join(", ")}`,
        item,
    );
    return false;
  }

  return true;
}

/**
 * Sort items for optimal dashboard display
 * Exceptions first, then by value descending
 */
function sortItemsForDisplay(processedItems) {
  return processedItems.sort((a, b) => {
    // Exception items first
    if (a.status !== INVENTORY_STATUS.OK && b.status === INVENTORY_STATUS.OK) {
      return -1;
    }
    if (a.status === INVENTORY_STATUS.OK && b.status !== INVENTORY_STATUS.OK) {
      return 1;
    }

    // Within same status group, sort by cost_basis descending
    return (b.cost_basis || 0) - (a.cost_basis || 0);
  });
}

/**
 * Utility: Extract unique categories from items
 */
function extractUniqueCategories(items) {
  const categories = new Set();
  items.forEach(item => {
    if (item.category && typeof item.category === 'string' && item.category.trim()) {
      categories.add(item.category.trim());
    } else {
      categories.add('Uncategorized');
    }
  });
  return Array.from(categories).sort();
}

/**
 * Utility: Generate summary from current items
 */
function generateCurrentSummary(items) {
  const summary = {
    total_items: items.length,
    total_value: 0,
    status_counts: {},
    categories: []
  };
  
  const statusCounts = {};
  const categories = new Set();
  
  items.forEach(item => {
    // Total value
    summary.total_value += item.cost_basis || 0;
    
    // Status counts
    const status = item.status || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    
    // Categories
    if (item.category && typeof item.category === 'string' && item.category.trim()) {
      categories.add(item.category.trim());
    } else {
      categories.add('Uncategorized');
    }
  });
  
  summary.status_counts = statusCounts;
  summary.categories = Array.from(categories).sort();
  
  return summary;
}

module.exports = {
  processInventoryItems,
  processInventoryItem,
  generateInventorySummary,
  getItemsByStatus,
  getExceptionItems,
  validateProcessedItem,
  sortItemsForDisplay,
  calculateTotalValue,
  extractUniqueCategories,
  generateCurrentSummary,
};
