/**
 * Firestore Writer Module - FIXED ACTIVE/ARCHIVED LIFECYCLE
 * Properly preserves archived items while updating active ones
 */

const admin = require('firebase-admin');
const { COLLECTIONS, DATA_SOURCES, SOS_CONFIG } = require('../shared/config');
const { logInfo, logError, logSuccess, logStart, logComplete } = require('../shared/logger');

// Initialize Firestore if not already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/**
 * Write complete inventory snapshot to Firestore using chunked batches
 * FIXED: Properly manages active/archived lifecycle without deleting archived items
 */
async function writeInventorySnapshot(processedData) {
  const startTime = Date.now();
  logStart(DATA_SOURCES.SOS_INVENTORY, 'Writing inventory snapshot to Firestore');
  
  try {
    const { items, summary } = processedData;
    const timestamp = summary.timestamp;
    const timestampId = formatTimestampForId(timestamp);
    
    // Validate timestamp ID
    if (!timestampId || typeof timestampId !== 'string' || timestampId.trim() === '') {
      throw new Error(`Invalid timestamp ID: ${timestampId}`);
    }
    
    // Validate items array
    if (!Array.isArray(items)) {
      throw new Error(`Expected items array, got ${typeof items}`);
    }
    
    if (items.length === 0) {
      throw new Error('No items to process');
    }
    
    // Log sample of items for debugging
    logInfo(DATA_SOURCES.SOS_INVENTORY, 'Sample items for processing:', {
      totalItems: items.length,
      sampleItem: items[0],
      categories: extractUniqueCategories(items)
    });
    
    // STEP 1: Get existing items and mark them as archived
    const currentItemIds = await markCurrentItemsAsArchived(items, timestamp);
    logInfo(DATA_SOURCES.SOS_INVENTORY, `Processing ${items.length} new items, ${currentItemIds.size} existing items marked as archived`);
    
    // Create parent documents first
    const inventoryRef = db.collection('inventory');
    
    // Create current inventory document
    await inventoryRef.doc('current').set({
      last_updated: admin.firestore.Timestamp.fromDate(timestamp),
      item_count: items.length,
      status: 'active'
    });
    
    // Create snapshots document
    await inventoryRef.doc('snapshots').set({
      last_snapshot: admin.firestore.Timestamp.fromDate(timestamp),
      total_snapshots: 1,
      status: 'active'
    });
    
    // Create metadata document with all necessary data
    await inventoryRef.doc('metadata').set({
      last_updated: admin.firestore.Timestamp.fromDate(timestamp),
      last_snapshot: admin.firestore.Timestamp.fromDate(timestamp),
      total_item_count: items.length,
      categories: extractUniqueCategories(items),
      status_summary: summary.status_counts,
      status: 'active'
    });
    
    // Split items into chunks for batch processing
    const chunks = [];
    for (let i = 0; i < items.length; i += SOS_CONFIG.BATCH_SIZE) {
      chunks.push(items.slice(i, i + SOS_CONFIG.BATCH_SIZE));
    }
    
    logInfo(DATA_SOURCES.SOS_INVENTORY, 
      `Processing ${items.length} items in ${chunks.length} batches of ${SOS_CONFIG.BATCH_SIZE}`);
    
    // Write snapshot summary first
    const snapshotSummaryRef = db.collection('inventory')
      .doc('snapshots')
      .collection(timestampId)
      .doc('summary');
    
    // Create items document in snapshot
    await db.collection('inventory')
      .doc('snapshots')
      .collection(timestampId)
      .doc('items')
      .set({
        item_count: items.length,
        timestamp: admin.firestore.Timestamp.fromDate(timestamp),
        status: 'active'
      });
    
    // Ensure summary has valid categories
    const categories = extractUniqueCategories(items);
    const validSummary = {
      ...summary,
      timestamp: admin.firestore.Timestamp.fromDate(timestamp),
      categories: categories
    };
    
    await snapshotSummaryRef.set(validSummary);
    
    // Process each chunk of items
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const batch = db.batch();
      
      // Validate items in chunk
      const invalidItems = chunk.filter(item => !item.item_id || typeof item.item_id !== 'string' || item.item_id.trim() === '');
      if (invalidItems.length > 0) {
        logError(DATA_SOURCES.SOS_INVENTORY, 
          `Found ${invalidItems.length} items with invalid IDs in batch ${i + 1}`,
          invalidItems.map(item => ({
            item_id: item.item_id,
            sku: item.sku,
            name: item.name,
            category: item.category
          }))
        );
        throw new Error(`Invalid item IDs found in batch ${i + 1}`);
      }
      
      // Write items in this chunk to snapshot collection
      const itemsCollectionRef = db.collection('inventory')
        .doc('snapshots')
        .collection(timestampId)
        .doc('items')
        .collection('data');
      
      chunk.forEach(item => {
        // Double-check item_id is valid
        if (!item.item_id || typeof item.item_id !== 'string' || item.item_id.trim() === '') {
          throw new Error(`Invalid item_id for item: ${JSON.stringify(item)}`);
        }
        
        // Transform item data for Firestore snapshot
        const transformedItem = {
          ...item,
          onHand: parseFloat(item.qty_on_hand) || 0,
          available: parseFloat(item.qty_available) || 0,
          averageCost: parseFloat(item.average_cost) || 0,
          cost_basis: parseFloat(item.cost_basis) || 0,
          category: item.category && typeof item.category === 'string' ? item.category.trim() : 'Uncategorized',
          item_status: 'active',
          last_updated: admin.firestore.Timestamp.fromDate(timestamp)
        };
        
        delete transformedItem.qty_on_hand;
        delete transformedItem.qty_available;
        delete transformedItem.average_cost;
        
        const itemRef = itemsCollectionRef.doc(item.item_id);
        batch.set(itemRef, transformedItem);
      });
      
      // FIXED: Update current inventory items properly
      chunk.forEach(item => {
        const currentItemRef = db.collection('inventory')
          .doc('current')
          .collection('items')
          .doc(item.item_id);
        
        // Transform item data for current collection
        const transformedItem = {
          ...item,
          onHand: parseFloat(item.qty_on_hand) || 0,
          available: parseFloat(item.qty_available) || 0,
          averageCost: parseFloat(item.average_cost) || 0,
          cost_basis: parseFloat(item.cost_basis) || 0,
          category: item.category && typeof item.category === 'string' ? item.category.trim() : 'Uncategorized',
          item_status: 'active',
          last_updated: admin.firestore.Timestamp.fromDate(timestamp)
        };
        
        delete transformedItem.qty_on_hand;
        delete transformedItem.qty_available;
        delete transformedItem.average_cost;
        
        // FIXED: Use set() which will overwrite existing items (including archived ones)
        // This is correct because items in the current snapshot should be active
        batch.set(currentItemRef, transformedItem);
      });
      
      // Execute batch for this chunk
      await batch.commit();
      
      logInfo(DATA_SOURCES.SOS_INVENTORY, 
        `Processed batch ${i + 1}/${chunks.length} (${chunk.length} items)`);
      
      // Add small delay between batches to prevent overwhelming Firestore
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    const duration = Date.now() - startTime;
    logComplete(DATA_SOURCES.SOS_INVENTORY, 'inventory snapshot write', duration);
    logSuccess(DATA_SOURCES.SOS_INVENTORY, 
      `Wrote inventory snapshot: ${items.length} items in ${chunks.length} batches`);
    
    return {
      success: true,
      timestamp: timestamp,
      itemCount: items.length,
      snapshotId: timestampId,
      batchCount: chunks.length
    };
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Failed to write inventory snapshot', error);
    throw error;
  }
}

/**
 * FIXED: Mark current items as archived, but only those NOT in the new snapshot
 * This prevents items from being deleted and preserves archived status
 */
async function markCurrentItemsAsArchived(newItems, timestamp) {
  logInfo(DATA_SOURCES.SOS_INVENTORY, 'Checking existing items for archival');
  
  try {
    const currentRef = db.collection('inventory').doc('current').collection('items');
    const existingItems = await currentRef.get();
    
    if (existingItems.empty) {
      logInfo(DATA_SOURCES.SOS_INVENTORY, 'No existing items to check for archival');
      return new Set();
    }
    
    // Create set of new item IDs for fast lookup
    const newItemIds = new Set(newItems.map(item => item.item_id));
    
    // Find items that exist currently but are NOT in the new snapshot
    const itemsToArchive = [];
    const existingItemIds = new Set();
    
    existingItems.forEach(doc => {
      const itemId = doc.id;
      existingItemIds.add(itemId);
      
      // If this item is NOT in the new snapshot, it should be archived
      if (!newItemIds.has(itemId)) {
        itemsToArchive.push(doc);
      }
    });
    
    logInfo(DATA_SOURCES.SOS_INVENTORY, `Found ${existingItems.size} existing items, ${itemsToArchive.length} need archiving, ${newItemIds.size} new/updated items`);
    
    if (itemsToArchive.length === 0) {
      logInfo(DATA_SOURCES.SOS_INVENTORY, 'No items need archiving - all existing items are in new snapshot');
      return existingItemIds;
    }
    
    // Archive items that are no longer in the snapshot
    const batches = [];
    let currentBatch = db.batch();
    let operationCount = 0;
    
    itemsToArchive.forEach(doc => {
      currentBatch.update(doc.ref, {
        item_status: 'archived',
        archived_at: admin.firestore.Timestamp.fromDate(timestamp)
      });
      
      operationCount++;
      
      // Firestore batch limit is 500 operations
      if (operationCount >= 450) {
        batches.push(currentBatch);
        currentBatch = db.batch();
        operationCount = 0;
      }
    });
    
    // Add the last batch if it has operations
    if (operationCount > 0) {
      batches.push(currentBatch);
    }
    
    // Execute all batches
    for (let i = 0; i < batches.length; i++) {
      await batches[i].commit();
      logInfo(DATA_SOURCES.SOS_INVENTORY, `Archived batch ${i + 1}/${batches.length}`);
    }
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, `Successfully archived ${itemsToArchive.length} items that are no longer in snapshot`);
    
    return existingItemIds;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Failed to archive items', error);
    throw error;
  }
}

/**
 * Get current inventory data for dashboard - ONLY ACTIVE ITEMS
 */
async function getCurrentInventoryData() {
    try {
        console.log('Starting getCurrentInventoryData...');
        
        const inventoryRef = db.collection('inventory');
        console.log('Checking inventory collection...');
        
        try {
            const inventorySnapshot = await inventoryRef.limit(1).get();
            console.log('Inventory collection exists:', !inventorySnapshot.empty);
            
            if (inventorySnapshot.empty) {
                return {
                    success: true,
                    data: {
                        items: [],
                        summary: {
                            totalItems: 0,
                            totalValue: 0,
                            categories: [],
                            lowStockItems: 0,
                            outOfStockItems: 0,
                            negativeStockItems: 0,
                            itemsWithIssues: 0
                        },
                        lastUpdated: null
                    }
                };
            }
            
            const currentDoc = await inventoryRef.doc('current').get();
            if (!currentDoc.exists) {
                return {
                    success: true,
                    data: {
                        items: [],
                        summary: {
                            totalItems: 0,
                            totalValue: 0,
                            categories: [],
                            lowStockItems: 0,
                            outOfStockItems: 0,
                            negativeStockItems: 0,
                            itemsWithIssues: 0
                        },
                        lastUpdated: null
                    }
                };
            }

            const metadataDoc = await inventoryRef.doc('metadata').get();
            if (!metadataDoc.exists) {
                return {
                    success: true,
                    data: {
                        items: [],
                        summary: {
                            totalItems: 0,
                            totalValue: 0,
                            categories: [],
                            lowStockItems: 0,
                            outOfStockItems: 0,
                            negativeStockItems: 0,
                            itemsWithIssues: 0
                        },
                        lastUpdated: null
                    }
                };
            }

            // Get ONLY ACTIVE items from current collection
            const currentRef = inventoryRef.doc('current').collection('items');
            console.log('Attempting to fetch ACTIVE current items...');
            
            try {
                // FILTER FOR ACTIVE ITEMS ONLY
                const currentSnapshot = await currentRef.where('item_status', '==', 'active').get();
                console.log('Active items fetched successfully. Empty?', currentSnapshot.empty);
                console.log('Number of ACTIVE items found:', currentSnapshot.size);
                
                if (currentSnapshot.empty) {
                    console.log('No active items found in Firestore');
                    return {
                        success: true,
                        data: {
                            items: [],
                            summary: {
                                totalItems: 0,
                                totalValue: 0,
                                categories: [],
                                lowStockItems: 0,
                                outOfStockItems: 0,
                                negativeStockItems: 0,
                                itemsWithIssues: 0
                            },
                            lastUpdated: metadataDoc.data().last_updated
                        }
                    };
                }

                const items = [];
                const categories = new Set();
                let totalValue = 0;
                let lowStockItems = 0;
                let outOfStockItems = 0;
                let negativeStockItems = 0;
                let itemsWithIssues = 0;

                console.log('Processing ACTIVE items...');
                currentSnapshot.forEach(doc => {
                    try {
                        const data = doc.data();

                        const category = typeof data.category === 'string' ? data.category.trim() : 'Uncategorized';
                        if (category) categories.add(category);

                        const onHand = parseFloat(data.onHand) || 0;
                        const available = parseFloat(data.available) || 0;
                        const averageCost = parseFloat(data.averageCost) || 0;
                        const costBasis = parseFloat(data.cost_basis) || 0;
                        
                        totalValue += costBasis;

                        if (onHand < 0) negativeStockItems++;
                        if (available <= 0) outOfStockItems++;
                        if (available > 0 && available <= 10) lowStockItems++;
                        if (data.status === 'error' || data.status === 'warning') itemsWithIssues++;

                        items.push({
                            id: doc.id,
                            ...data,
                            category: category
                        });
                    } catch (itemError) {
                        console.error(`Error processing item ${doc.id}:`, itemError);
                        itemsWithIssues++;
                    }
                });

                console.log('ACTIVE items processing complete. Summary:', {
                    totalActiveItems: items.length,
                    uniqueCategories: categories.size,
                    totalValue,
                    lowStockItems,
                    outOfStockItems,
                    negativeStockItems,
                    itemsWithIssues
                });

                return {
                    success: true,
                    data: {
                        items,
                        summary: {
                            totalItems: items.length,
                            totalValue,
                            categories: Array.from(categories).sort(),
                            lowStockItems,
                            outOfStockItems,
                            negativeStockItems,
                            itemsWithIssues
                        },
                        lastUpdated: metadataDoc.data().last_updated
                    }
                };
            } catch (error) {
                console.error('Error fetching active items:', error);
                throw new Error(`Failed to fetch active items: ${error.message}`);
            }
        } catch (error) {
            console.error('Error checking inventory collection:', error);
            throw new Error(`Failed to access inventory collection: ${error.message}`);
        }
    } catch (error) {
        console.error('Error in getCurrentInventoryData:', error);
        return {
            success: false,
            message: 'Failed to fetch dashboard data',
            error: `${error.code || ''} ${error.message || error}`
        };
    }
}

/**
 * Get historical inventory data for trend analysis
 */
async function getInventoryHistory(startDate, endDate, limit = 30) {
  logInfo(DATA_SOURCES.SOS_INVENTORY, `Fetching inventory history from ${startDate} to ${endDate}`);
  
  try {
    const startTimestamp = admin.firestore.Timestamp.fromDate(startDate);
    const endTimestamp = admin.firestore.Timestamp.fromDate(endDate);
    
    const snapshotsQuery = db.collectionGroup('summary')
      .where('timestamp', '>=', startTimestamp)
      .where('timestamp', '<=', endTimestamp)
      .orderBy('timestamp', 'desc')
      .limit(limit);
    
    const snapshotsSnapshot = await snapshotsQuery.get();
    
    const historicalData = [];
    snapshotsSnapshot.forEach(doc => {
      historicalData.push({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate()
      });
    });
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, 'Successfully fetched inventory history', historicalData.length);
    return historicalData;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Failed to fetch inventory history', error);
    throw error;
  }
}

/**
 * Get items with specific status for exception reporting - ONLY ACTIVE ITEMS
 */
async function getItemsByStatus(status) {
  logInfo(DATA_SOURCES.SOS_INVENTORY, `Fetching ACTIVE items with status: ${status}`);
  
  try {
    const itemsSnapshot = await db.collection('inventory')
      .doc('current')
      .collection('items')
      .where('item_status', '==', 'active')
      .where('status', '==', status)
      .get();
    
    const items = [];
    itemsSnapshot.forEach(doc => {
      items.push({
        id: doc.id,
        ...doc.data(),
        last_updated: doc.data().last_updated?.toDate()
      });
    });
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, `Found ${items.length} ACTIVE items with status: ${status}`);
    return items;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, `Failed to fetch ACTIVE items with status: ${status}`, error);
    throw error;
  }
}

function formatTimestampForId(timestamp) {
  const date = new Date(timestamp);
  return date.toISOString().replace(/[:.]/g, '-').slice(0, -5);
}

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
    summary.total_value += item.cost_basis || 0;
    
    const status = item.status || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    
    if (item.category) {
      if (typeof item.category === 'string') {
        const trimmedCategory = item.category.trim();
        if (trimmedCategory) {
          categories.add(trimmedCategory);
        }
      } else if (typeof item.category === 'number') {
        categories.add(item.category.toString());
      }
    }
  });
  
  summary.status_counts = statusCounts;
  summary.categories = Array.from(categories).sort();
  
  return summary;
}

async function testFirestoreConnection() {
  logInfo(DATA_SOURCES.SOS_INVENTORY, 'Testing Firestore connection');
  
  try {
    const testRef = db.collection('inventory')
      .doc('test')
      .collection('connection')
      .doc('test');
    
    await testRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      test: true
    });
    
    const inventoryRef = db.collection('inventory');
    const inventoryDoc = await inventoryRef.doc('current').get();
    
    const itemsRef = inventoryRef.doc('current').collection('items');
    const itemsSnapshot = await itemsRef.limit(1).get();
    
    await testRef.delete();
    
    return {
      success: true,
      message: 'Firestore connection test successful',
      details: {
        canWrite: true,
        canReadInventory: inventoryDoc.exists,
        canReadItems: !itemsSnapshot.empty,
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, 'Firestore connection test failed', {
      error: error.message,
      code: error.code,
      details: error.details
    });
    
    return {
      success: false,
      message: 'Firestore connection test failed',
      error: error.message,
      code: error.code,
      details: error.details
    };
  }
}

module.exports = {
  writeInventorySnapshot,
  getCurrentInventoryData,
  getInventoryHistory,
  getItemsByStatus,
  testFirestoreConnection,
  formatTimestampForId
};