package com.acme.portal.service;

import com.swfte.sdk.models.WorkflowExecution;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/** Uses the fully qualified SDK type: the in-house fork (com.acme.swftefork) also has a class named SwfteClient. */
@Service
public class ChurnService {

    private final com.swfte.sdk.SwfteClient swfte;

    public ChurnService(com.swfte.sdk.SwfteClient swfte) {
        this.swfte = swfte;
    }

    public String flag(String customerId) {
        return swfte.workflows().invoke("wf_JvChn3", Map.of("customerId", customerId)).getExecutionId();
    }

    @SuppressWarnings("unchecked")
    public List<String> drivers(String customerId) {
        WorkflowExecution run = swfte.workflows().invokeAndWait("wf_JvChn3", Map.of("customerId", customerId, "window", "90d"));
        return (List<String>) run.getOutputs().get("drivers");
    }

    public String retentionNote(String customerId, String note) {
        return swfte.agents().chat("ag_JvRet4", note).getResponse();
    }
}
