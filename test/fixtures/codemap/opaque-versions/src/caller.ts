import Swfte from '@swfte/sdk';
const client = new Swfte({});
client.workflows.invokeVersion('wf_opaque_ts', 'v3', {amount:1});
client.workflows.invokeVersionAndWait('wf_opaque_wait_ts', 'custom@v3:release', {amount:1});
fetch('https://api.swfte.com/v2/workflows/wf_opaque_raw_ts/versions/custom%40v3%3Arelease/invoke', {method:'POST'});
