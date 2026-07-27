export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://predex:predex@localhost:5432/predex_pump?schema=contract_test';
