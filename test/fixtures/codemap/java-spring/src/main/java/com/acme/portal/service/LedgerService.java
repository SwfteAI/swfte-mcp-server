package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class LedgerService {

    private final SwfteClient client;
    private final List<WorkflowExecution> lastRuns;

    public LedgerService(SwfteClient client) {
        this.client = client;
        this.lastRuns = client.workflows().getExecutionHistory("wf_JvLed7");
    }

    public String post(String batchId, double amount) {
        return client.workflows().invoke("wf_JvLed7", Map.of("batchId", batchId, "amount", amount)).getExecutionId();
    }

    public int knownRuns() {
        return lastRuns.size();
    }
}
