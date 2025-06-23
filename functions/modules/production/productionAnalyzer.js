// modules/production/productionAnalyzer.js
// Production cost analysis and business logic

const { logInfo, logError, logWarning } = require('../shared/logger');

/**
 * Analyze process transaction structure for cost data availability
 * @param {Array} transactions - Array of process transactions
 * @returns {Object} Comprehensive analysis results
 */
function analyzeProcessTransactionStructure(transactions) {
  if (!transactions || transactions.length === 0) {
    return { error: 'No transactions to analyze' };
  }

  const analysis = {
    totalTransactions: transactions.length,
    dateRange: {
      earliest: null,
      latest: null
    },
    outputProducts: new Set(),
    inputMaterials: new Set(),
    costDataAvailable: {
      transactionTotal: false,
      inputCosts: false,
      outputCosts: false,
      inputUnitCosts: false,
      outputUnitCosts: false,
      detailedCostFields: []
    },
    dataStructure: {
      commonInputFields: new Set(),
      commonOutputFields: new Set(),
      transactionFields: new Set()
    },
    sampleTransaction: transactions[0]
  };

  transactions.forEach(transaction => {
    // Date range analysis
    if (transaction.date) {
      const transactionDate = new Date(transaction.date);
      if (!analysis.dateRange.earliest || transactionDate < analysis.dateRange.earliest) {
        analysis.dateRange.earliest = transactionDate;
      }
      if (!analysis.dateRange.latest || transactionDate > analysis.dateRange.latest) {
        analysis.dateRange.latest = transactionDate;
      }
    }

    // Catalog all transaction-level fields
    Object.keys(transaction).forEach(field => {
      analysis.dataStructure.transactionFields.add(field);
    });

    // Product and material analysis
    if (transaction.outputs && Array.isArray(transaction.outputs)) {
      transaction.outputs.forEach(output => {
        if (output.item?.name) {
          analysis.outputProducts.add(output.item.name);
        }
        
        // Catalog output fields
        Object.keys(output).forEach(field => {
          analysis.dataStructure.commonOutputFields.add(field);
        });
      });
    }

    if (transaction.inputs && Array.isArray(transaction.inputs)) {
      transaction.inputs.forEach(input => {
        if (input.item?.name) {
          analysis.inputMaterials.add(input.item.name);
        }
        
        // Catalog input fields  
        Object.keys(input).forEach(field => {
          analysis.dataStructure.commonInputFields.add(field);
        });
      });
    }

    // Comprehensive cost data analysis
    if (transaction.total !== undefined && transaction.total !== null && transaction.total !== 0) {
      analysis.costDataAvailable.transactionTotal = true;
    }

    // Check for any cost-related fields in inputs
    if (transaction.inputs) {
      transaction.inputs.forEach(input => {
        const costFields = ['cost', 'unitCost', 'totalCost', 'price', 'unitPrice', 'amount'];
        costFields.forEach(field => {
          if (input[field] !== undefined && input[field] !== null && input[field] !== 0) {
            analysis.costDataAvailable.inputCosts = true;
            if (field.includes('unit') || field.includes('Unit')) {
              analysis.costDataAvailable.inputUnitCosts = true;
            }
            if (!analysis.costDataAvailable.detailedCostFields.includes(`input.${field}`)) {
              analysis.costDataAvailable.detailedCostFields.push(`input.${field}`);
            }
          }
        });
      });
    }

    // Check for any cost-related fields in outputs
    if (transaction.outputs) {
      transaction.outputs.forEach(output => {
        const costFields = ['cost', 'unitCost', 'totalCost', 'price', 'unitPrice', 'amount'];
        costFields.forEach(field => {
          if (output[field] !== undefined && output[field] !== null && output[field] !== 0) {
            analysis.costDataAvailable.outputCosts = true;
            if (field.includes('unit') || field.includes('Unit')) {
              analysis.costDataAvailable.outputUnitCosts = true;
            }
            if (!analysis.costDataAvailable.detailedCostFields.includes(`output.${field}`)) {
              analysis.costDataAvailable.detailedCostFields.push(`output.${field}`);
            }
          }
        });
      });
    }
  });

  // Convert Sets to Arrays for JSON serialization
  analysis.outputProducts = Array.from(analysis.outputProducts);
  analysis.inputMaterials = Array.from(analysis.inputMaterials);
  analysis.dataStructure.commonInputFields = Array.from(analysis.dataStructure.commonInputFields);
  analysis.dataStructure.commonOutputFields = Array.from(analysis.dataStructure.commonOutputFields);
  analysis.dataStructure.transactionFields = Array.from(analysis.dataStructure.transactionFields);

  return analysis;
}

/**
 * Extract production batches with cost analysis
 * @param {Array} transactions - Process transactions
 * @returns {Object} Production summary with cost insights
 */
function extractProductionBatches(transactions) {
  const productionSummary = {
    totalBatches: transactions.length,
    products: {},
    dailyTotals: {},
    costDataQuality: {
      batchesWithCosts: 0,
      batchesWithoutCosts: 0,
      totalValue: 0
    }
  };

  transactions.forEach(transaction => {
    const transactionDate = new Date(transaction.date).toISOString().split('T')[0];
    
    // Initialize daily totals
    if (!productionSummary.dailyTotals[transactionDate]) {
      productionSummary.dailyTotals[transactionDate] = {
        batches: 0,
        products: new Set(),
        totalValue: 0
      };
    }

    if (transaction.outputs && transaction.outputs.length > 0) {
      transaction.outputs.forEach(output => {
        const productName = output.item?.name || 'Unknown Product';
        
        // Initialize product tracking
        if (!productionSummary.products[productName]) {
          productionSummary.products[productName] = {
            batches: [],
            totalQuantity: 0,
            totalBatches: 0,
            costAnalysis: {
              batchesWithCosts: 0,
              averageCostPerUnit: 0,
              totalValue: 0
            }
          };
        }

        // Extract batch information
        const batch = {
          transactionId: transaction.id,
          transactionNumber: transaction.number,
          date: transaction.date,
          quantity: output.quantity || 0,
          inputs: transaction.inputs?.map(input => ({
            name: input.item?.name || 'Unknown Input',
            quantity: input.quantity || 0,
            // Include any cost fields found
            cost: input.cost || input.unitCost || input.totalCost || null
          })) || [],
          totalTransactionValue: transaction.total || 0,
          hasCostData: !!(transaction.total || 
                          (transaction.inputs && transaction.inputs.some(i => i.cost || i.unitCost)) ||
                          (output.cost || output.unitCost))
        };

        productionSummary.products[productName].batches.push(batch);
        productionSummary.products[productName].totalQuantity += batch.quantity;
        productionSummary.products[productName].totalBatches += 1;

        // Cost analysis
        if (batch.hasCostData) {
          productionSummary.products[productName].costAnalysis.batchesWithCosts += 1;
          productionSummary.costDataQuality.batchesWithCosts += 1;
          
          if (batch.totalTransactionValue) {
            productionSummary.products[productName].costAnalysis.totalValue += batch.totalTransactionValue;
            productionSummary.costDataQuality.totalValue += batch.totalTransactionValue;
          }
        } else {
          productionSummary.costDataQuality.batchesWithoutCosts += 1;
        }

        // Daily totals
        productionSummary.dailyTotals[transactionDate].batches += 1;
        productionSummary.dailyTotals[transactionDate].products.add(productName);
        if (batch.totalTransactionValue) {
          productionSummary.dailyTotals[transactionDate].totalValue += batch.totalTransactionValue;
        }
      });
    }
  });

  // Calculate average costs where possible
  Object.keys(productionSummary.products).forEach(productName => {
    const product = productionSummary.products[productName];
    if (product.costAnalysis.batchesWithCosts > 0 && product.totalQuantity > 0) {
      product.costAnalysis.averageCostPerUnit = 
        product.costAnalysis.totalValue / product.totalQuantity;
    }
  });

  // Convert Sets to Arrays in daily totals
  Object.keys(productionSummary.dailyTotals).forEach(date => {
    productionSummary.dailyTotals[date].products = 
      Array.from(productionSummary.dailyTotals[date].products);
  });

  return productionSummary;
}

/**
 * Generate recommendations based on cost data analysis
 * @param {Object} analysis - Structure analysis results
 * @returns {Object} Recommendations for next steps
 */
function generateCostDataRecommendations(analysis) {
  const recommendations = {
    dataRoute: 'UNKNOWN',
    confidence: 'LOW',
    nextSteps: [],
    implementationNotes: []
  };

  // Determine recommended data route
  if (analysis.costDataAvailable.inputCosts && analysis.costDataAvailable.outputCosts) {
    recommendations.dataRoute = 'DIRECT_API';
    recommendations.confidence = 'HIGH';
    recommendations.nextSteps.push('Proceed with direct API integration');
    recommendations.nextSteps.push('Build cost tracking dashboard');
    
  } else if (analysis.costDataAvailable.transactionTotal) {
    recommendations.dataRoute = 'TRANSACTION_TOTALS';
    recommendations.confidence = 'MEDIUM';
    recommendations.nextSteps.push('Use transaction totals for cost tracking');
    recommendations.nextSteps.push('May need additional data for input/labor breakdown');
    
  } else if (analysis.costDataAvailable.detailedCostFields.length > 0) {
    recommendations.dataRoute = 'PARTIAL_API';
    recommendations.confidence = 'MEDIUM';
    recommendations.nextSteps.push('Limited cost data available via API');
    recommendations.nextSteps.push('Consider supplementing with Reports API');
    
  } else {
    recommendations.dataRoute = 'REPORTS_API_REQUIRED';
    recommendations.confidence = 'HIGH';
    recommendations.nextSteps.push('No cost data in process API');
    recommendations.nextSteps.push('Explore SOS Reports API for cost information');
    recommendations.nextSteps.push('Consider manual cost calculation from inventory data');
  }

  // Implementation notes
  if (analysis.costDataAvailable.detailedCostFields.length > 0) {
    recommendations.implementationNotes.push(
      `Available cost fields: ${analysis.costDataAvailable.detailedCostFields.join(', ')}`
    );
  }
  
  recommendations.implementationNotes.push(
    `Products to track: ${analysis.outputProducts.length} different products`
  );
  
  recommendations.implementationNotes.push(
    `Input materials: ${analysis.inputMaterials.length} different materials`
  );

  return recommendations;
}

module.exports = {
  analyzeProcessTransactionStructure,
  extractProductionBatches,
  generateCostDataRecommendations
};