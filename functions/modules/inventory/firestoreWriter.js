/**
 * Firestore Writer Module
 * Handles all database operations for inventory data
 * Implements the designed collection structure for optimal querying
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
 * Implements efficient batch processing for large datasets
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
        
        // Transform item data for Firestore
        const transformedItem = {
          ...item,
          // Transform field names to match dashboard expectations
          onHand: parseFloat(item.qty_on_hand) || 0,
          available: parseFloat(item.qty_available) || 0,
          averageCost: parseFloat(item.cost_basis) || 0,
          // Ensure category is valid
          category: item.category && typeof item.category === 'string' ? item.category.trim() : 'Uncategorized',
          last_updated: admin.firestore.Timestamp.fromDate(timestamp)
        };
        
        // Remove original field names to avoid confusion
        delete transformedItem.qty_on_hand;
        delete transformedItem.qty_available;
        delete transformedItem.cost_basis;
        delete transformedItem.average_cost;
        
        const itemRef = itemsCollectionRef.doc(item.item_id);
        batch.set(itemRef, transformedItem);
      });
      
      // Update current inventory for items in this chunk
      chunk.forEach(item => {
        const currentItemRef = db.collection('inventory')
          .doc('current')
          .collection('items')
          .doc(item.item_id);
        
        // Transform item data for Firestore
        const transformedItem = {
          ...item,
          // Transform field names to match dashboard expectations
          onHand: parseFloat(item.qty_on_hand) || 0,
          available: parseFloat(item.qty_available) || 0,
          averageCost: parseFloat(item.cost_basis) || 0,
          // Ensure category is valid
          category: item.category && typeof item.category === 'string' ? item.category.trim() : 'Uncategorized',
          last_updated: admin.firestore.Timestamp.fromDate(timestamp)
        };
        
        // Remove original field names to avoid confusion
        delete transformedItem.qty_on_hand;
        delete transformedItem.qty_available;
        delete transformedItem.cost_basis;
        delete transformedItem.average_cost;
        
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
    
    // Remove the metadata subcollection update since we're using the main document
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
 * Get current inventory data for dashboard
 * Optimized for real-time dashboard queries
 */
async function getCurrentInventoryData() {
    try {
        console.log('Starting getCurrentInventoryData...');
        
        // First, verify the inventory collection exists
        const inventoryRef = db.collection('inventory');
        console.log('Checking inventory collection...');
        
        try {
            const inventorySnapshot = await inventoryRef.limit(1).get();
            console.log('Inventory collection exists:', !inventorySnapshot.empty);
            
            if (inventorySnapshot.empty) {
                console.log('Inventory collection is empty');
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
            
            // Check if current document exists
            const currentDoc = await inventoryRef.doc('current').get();
            console.log('Current document exists:', currentDoc.exists);
            
            if (!currentDoc.exists) {
                console.log('Current document does not exist');
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

            // Check if metadata document exists
            const metadataDoc = await inventoryRef.doc('metadata').get();
            console.log('Metadata document exists:', metadataDoc.exists);
            
            if (!metadataDoc.exists) {
                console.log('Metadata document does not exist');
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

            // Get the current items collection
            const currentRef = inventoryRef.doc('current').collection('items');
            console.log('Attempting to fetch current items...');
            
            try {
                const currentSnapshot = await currentRef.get();
                console.log('Current items fetched successfully. Empty?', currentSnapshot.empty);
                console.log('Number of items found:', currentSnapshot.size);
                
                if (currentSnapshot.empty) {
                    console.log('No current items found in Firestore');
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

                // Log a sample item for debugging
                const firstItem = currentSnapshot.docs[0].data();
                console.log('Sample item structure:', {
                    id: currentSnapshot.docs[0].id,
                    hasCategory: !!firstItem.category,
                    categoryType: typeof firstItem.category,
                    fields: Object.keys(firstItem)
                });

                const items = [];
                const categories = new Set();
                let totalValue = 0;
                let lowStockItems = 0;
                let outOfStockItems = 0;
                let negativeStockItems = 0;
                let itemsWithIssues = 0;

                console.log('Processing items...');
                currentSnapshot.forEach(doc => {
                    try {
                        const data = doc.data();
                        console.log(`Processing item ${doc.id}:`, {
                            hasCategory: !!data.category,
                            categoryType: typeof data.category,
                            onHand: data.onHand,
                            available: data.available,
                            averageCost: data.averageCost
                        });

                        // Safely handle category
                        const category = typeof data.category === 'string' ? data.category.trim() : 'Uncategorized';
                        if (category) categories.add(category);

                        // Calculate values
                        const onHand = parseFloat(data.onHand) || 0;
                        const available = parseFloat(data.available) || 0;
                        const averageCost = parseFloat(data.averageCost) || 0;
                        const value = onHand * averageCost;
                        totalValue += value;

                        // Count items by status
                        if (onHand < 0) negativeStockItems++;
                        if (available <= 0) outOfStockItems++;
                        if (available > 0 && available <= 10) lowStockItems++;
                        if (data.status === 'error' || data.status === 'warning') itemsWithIssues++;

                        items.push({
                            id: doc.id,
                            ...data,
                            category: category,
                            value: value
                        });
                    } catch (itemError) {
                        console.error(`Error processing item ${doc.id}:`, itemError);
                        itemsWithIssues++;
                    }
                });

                console.log('Items processing complete. Summary:', {
                    totalItems: items.length,
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
                console.error('Error fetching current items:', error);
                console.error('Error details:', {
                    code: error.code,
                    message: error.message,
                    stack: error.stack
                });
                throw new Error(`Failed to fetch current items: ${error.message}`);
            }
        } catch (error) {
            console.error('Error checking inventory collection:', error);
            throw new Error(`Failed to access inventory collection: ${error.message}`);
        }
    } catch (error) {
        console.error('Error in getCurrentInventoryData:', error);
        console.error('Full error details:', {
            code: error.code,
            message: error.message,
            stack: error.stack,
            name: error.name
        });
        return {
            success: false,
            message: 'Failed to fetch dashboard data',
            error: `${error.code || ''} ${error.message || error}`
        };
    }
}

/**
 * Get historical inventory data for trend analysis
 * Supports date range queries for analytics
 */
async function getInventoryHistory(startDate, endDate, limit = 30) {
  logInfo(DATA_SOURCES.SOS_INVENTORY, `Fetching inventory history from ${startDate} to ${endDate}`);
  
  try {
    const startTimestamp = admin.firestore.Timestamp.fromDate(startDate);
    const endTimestamp = admin.firestore.Timestamp.fromDate(endDate);
    
    // Query snapshot summaries in date range
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
 * Get items with specific status for exception reporting
 */
async function getItemsByStatus(status) {
  logInfo(DATA_SOURCES.SOS_INVENTORY, `Fetching items with status: ${status}`);
  
  try {
    const itemsSnapshot = await db.collection('inventory')
      .doc('current')
      .collection('items')
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
    
    logSuccess(DATA_SOURCES.SOS_INVENTORY, `Found ${items.length} items with status: ${status}`);
    return items;
    
  } catch (error) {
    logError(DATA_SOURCES.SOS_INVENTORY, `Failed to fetch items with status: ${status}`, error);
    throw error;
  }
}

/**
 * Utility: Format timestamp for use as Firestore document ID
 * Creates sortable, readable timestamp IDs
 */
function formatTimestampForId(timestamp) {
  const date = new Date(timestamp);
  return date.toISOString().replace(/[:.]/g, '-').slice(0, -5); // Remove milliseconds and Z
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
    
    // Categories - safely handle category values
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

/**
 * Test database connectivity and permissions
 */
async function testFirestoreConnection() {
  logInfo(DATA_SOURCES.SOS_INVENTORY, 'Testing Firestore connection');
  
  try {
    // Test basic write permission
    const testRef = db.collection('inventory')
      .doc('test')
      .collection('connection')
      .doc('test');
    
    await testRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      test: true
    });
    
    // Test read permission for inventory collection
    const inventoryRef = db.collection('inventory');
    const inventoryDoc = await inventoryRef.doc('current').get();
    
    // Test read permission for items collection
    const itemsRef = inventoryRef.doc('current').collection('items');
    const itemsSnapshot = await itemsRef.limit(1).get();
    
    // Clean up test document
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