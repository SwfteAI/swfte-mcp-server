# Swfte integration notes

The editor's publish button calls the Content pipeline through the generated client:

```ts
import { invokeContentPipeline } from '@/swfte/content-pipeline';

const res = await invokeContentPipeline({ sources, topic });
console.log(res.output?.articles);
```

Before the typed client existed we called the endpoint directly:

```ts
await fetch('https://api.swfte.com/agents/v2/workflows/wf_8K2mQ4/invoke', { method: 'POST', body });
```

The help widget is a one-liner:

```tsx
<ChatWidget agentId="ag_Docs2W" />
```
