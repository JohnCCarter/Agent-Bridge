/**
 * Safely updates a contract with error handling.
 * @param {Object} bridgeClient - The bridge client instance
 * @param {string} contractId - Contract ID to update
 * @param {Object} update - Update object with status, actor, note, etc.
 * @param {Function} [logCallback] - Optional callback for logging contract activity
 * @returns {Promise<void>}
 */
async function updateContractSafely(bridgeClient, contractId, update, logCallback) {
  try {
    await bridgeClient.updateContract(contractId, update);
    if (logCallback && typeof logCallback === 'function') {
      logCallback(contractId, {
        timestamp: new Date().toISOString(),
        type: 'contract.local_update',
        status: update.status,
        actor: update.actor,
        note: update.note
      });
    }
  } catch (error) {
    console.error(`Failed to update contract ${contractId}:`, error.message);
  }
}

module.exports = {
  updateContractSafely
};
