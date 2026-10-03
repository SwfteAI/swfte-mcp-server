// Weekly finance report: how many invoices were triaged and how many failed.
//   node scripts/report.cjs
const { Swfte } = require('@swfte/sdk');

const client = new Swfte({ apiKey: process.env.SWFTE_API_KEY });

async function weeklyTriageReport() {
  const runs = await client.workflows.getExecutionHistory('wf_Inv7Tr2');
  const failed = runs.filter((r) => r.status === 'FAILED').length;
  console.log(`triaged ${runs.length}, failed ${failed}`);
}

weeklyTriageReport().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
