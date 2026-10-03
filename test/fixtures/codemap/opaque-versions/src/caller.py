from swfte import Swfte
import requests
client = Swfte()
client.workflows.invoke_version('wf_opaque_py', 'v3', inputs={'amount':1})
client.workflows.invoke_version_and_wait('wf_opaque_wait_py', 'custom@v3:release', inputs={'amount':1})
requests.post('https://api.swfte.com/v2/workflows/wf_opaque_raw_py/versions/custom%40v3%3Arelease/invoke', json={})
