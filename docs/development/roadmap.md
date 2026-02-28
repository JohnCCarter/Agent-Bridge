# Codex <-> Cursor Integration Roadmap

## Phase 1 - Task Contracts

- [x] Define TaskContract TypeScript types and Zod schema in src/contracts.ts
- [x] Add server routes:
  - [x] POST /contracts - create a contract from a published task
  - [x] GET /contracts/:id - fetch contract state
  - [x] PATCH /contracts/:id/status - update status, owner, timestamps
- [x] Update /publish_message handler to optionally create/attach a contract
- [x] Extend message payload format to include contractId

## Phase 2 - Resource Locks Integration

- [x] Build client helpers for lock operations tied to contracts (new          gent-bridge-client.js)
- [x] Enforce that contract operations can acquire/release locks via helper
- [x] Emit lock-related notifications in contract updates

## Phase 3 - Notifications & Status Stream

- [x] Add Server-Sent Events endpoint /events broadcasting contract and lock changes
- [x] Buffer recent events for agents that reconnect
- [x] Document event payload structure in README

## Phase 4 - Agent Upgrades

- [x] Update Cursor agent to:
  - [x] Create contracts when delegating tasks
  - [x] Subscribe and process status events
  - [x] Persist brief activity history per contract
- [x] Update Codex agent to:
  - [x] Accept contracts, acquire locks as required
  - [x] Post status updates and release locks on completion
  - [x] Handle failure plus retry semantics on contracts

## Phase 5 - Documentation and Follow-up

- [x] Update README with new workflow
- [x] Produce CONTRACTS.md explaining lifecycle, statuses, fields
- [x] Review and improve tests to cover contract creation, lock flow, events

## Phase 6 - Next Iteration Ideas

- [x] CLI/utility commands for listing active contracts and recent events
- [x] Optional persistence layer (JSON disk store) for contracts and locks
- [x] Web dashboard or VS Code view that consumes /events

## Phase 7 - Integration Test Automation

- [x] Define a scripted contract scenario that covers code generation, persistence, and verification
- [x] Implement an automation script (e.g. scripts/contract-smoke-test.js) to trigger both agents end-to-end
- [x] Capture contract metadata, persisted paths, and agent logs as assertions
- [x] Document how to run the automation and add an npm script for quick regression runs
