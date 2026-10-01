package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class RiskService {

    private final SwfteClient client;
    private final List<Map<String, Object>> archive = new ArrayList<>();

    public RiskService(SwfteClient client) {
        this.client = client;
    }

    public double assess(String customerId) {
        WorkflowExecution run = client.workflows().invokeAndWait("wf_JvRisk4", Map.of("customerId", customerId));
        return ((Number) run.getOutputs().get("score")).doubleValue();
    }

    public String assess(String customerId, String window) {
        WorkflowExecution run = client.workflows().invokeAndWait("wf_JvRisk4", Map.of("customerId", customerId, "window", window));
        Map<String, Object> out = run.getOutputs();
        return out.get("band") + " (" + out.get("score") + ")";
    }

    public void assessAll(List<String> customerIds) {
        for (String id : customerIds) {
            WorkflowExecution run = client.workflows().invokeAndWait("wf_JvRisk4", Map.of("customerId", id));
            store(run.getOutputs());
        }
    }

    public long failedRuns() {
        return client.workflows().getExecutionHistory("wf_JvRisk4").stream()
                .filter(e -> "FAILED".equals(e.getStatusRaw()))
                .count();
    }

    private void store(Map<String, Object> outputs) {
        archive.add(outputs);
    }
}
