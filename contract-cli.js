#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, 'data');
const CONTRACTS_FILE = path.join(DATA_DIR, 'contracts.json');

function loadContracts() {
  if (!fs.existsSync(CONTRACTS_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(CONTRACTS_FILE, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    return JSON.parse(raw);
  } catch (error) {
    console.error('Kunde inte läsa contracts.json:', error.message);
    process.exitCode = 1;
    return [];
  }
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  try {
    return new Date(value).toLocaleString();
  } catch (err) {
    return value;
  }
}

function listContracts() {
  const contracts = loadContracts();
  if (contracts.length === 0) {
    console.log('Inga kontrakt sparade.');
    return;
  }

  console.log(`Hittade ${contracts.length} kontrakt:`);
  contracts.forEach(contract => {
    console.log(
      `${contract.id}\n` +
      `  Titel:      ${contract.title}\n` +
      `  Status:     ${contract.status}\n` +
      `  Prioritet:  ${contract.priority}\n` +
      `  Ägare:      ${contract.owner || '-'}\n` +
      `  Skapad:     ${formatDate(contract.createdAt)}\n`
    );
  });
}

function viewContract(id) {
  const contracts = loadContracts();
  const contract = contracts.find(item => item.id === id);
  if (!contract) {
    console.error('Kontrakt hittades inte:', id);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(contract, null, 2));
}

function history(contractId) {
  const contracts = loadContracts();
  const contract = contracts.find(item => item.id === contractId);
  if (!contract) {
    console.error('Kontrakt hittades inte:', contractId);
    process.exitCode = 1;
    return;
  }

  console.log(`Historik för ${contract.title} (${contract.id})`);
  const historyEntries = contract.history || [];
  if (historyEntries.length === 0) {
    console.log('Ingen historik.');
    return;
  }
  historyEntries
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .forEach(entry => {
      console.log(
        `- ${formatDate(entry.timestamp)} | ${entry.status} | ${entry.actor}${entry.note ? ' – ' + entry.note : ''}`
      );
    });
}

function usage() {
  console.log('Användning:');
  console.log('  node contract-cli.js list');
  console.log('  node contract-cli.js view <contractId>');
  console.log('  node contract-cli.js history <contractId>');
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'list':
    case undefined:
      listContracts();
      break;
    case 'view':
      if (!args[0]) {
        console.error('Ange contractId.');
        usage();
        process.exitCode = 1;
        return;
      }
      viewContract(args[0]);
      break;
    case 'history':
      if (!args[0]) {
        console.error('Ange contractId.');
        usage();
        process.exitCode = 1;
        return;
      }
      history(args[0]);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`Okänt kommando: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main();
