// Use an in-memory SQLite database for all tests so no disk I/O occurs
// and each test run starts completely clean.
process.env.BRIDGE_DB_PATH = ':memory:';
