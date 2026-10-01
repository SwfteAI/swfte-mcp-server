package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class ContractService {

    private final SwfteClient client;

    public ContractService(SwfteClient client) {
        this.client = client;
    }

    public String queueReview(String documentUrl) {
        return client.workflows().invoke("wf_JvCtr3", Map.of("documentUrl", documentUrl, "jurisdiction", "US-DE")).getExecutionId();
    }

    @SuppressWarnings("unchecked")
    public int highRiskClauseCount(String documentUrl, String jurisdiction) {
        WorkflowExecution run = client.workflows()
                .invokeAndWait("wf_JvCtr3", Map.of("documentUrl", documentUrl, "jurisdiction", jurisdiction));
        if (!"high".equals(run.getOutputs().get("risk"))) {
            return 0;
        }
        return ((List<Object>) run.getOutputs().get("clauses")).size();
    }

    public String validateDraft(String documentUrl) {
        return client.workflows().execute("wf_JvCtr3", Map.of("documentUrl", documentUrl, "jurisdiction", "US-DE", "testingFlag", true)).getStatusRaw();
    }
}
